#!/usr/bin/env node
/**
 * Playwright/Firefox bridge: launches Firefox (via Playwright), loads the Agora
 * Web SDKs (RTC + RTM), subscribes to the robot's video track, and pipes JPEG
 * frames over WebSocket to the Python receiver.
 *
 * Why Firefox instead of Chromium:
 *   Firefox decodes H.264 WebRTC via OpenH264 GMP (Cisco, freely distributable) on
 *   all platforms including ARM64 Linux — no proprietary system codec package needed.
 *   Chromium on ARM64 Linux has no usable H.264 WebRTC support in 2026
 *   (chromium-codecs-ffmpeg-extra is stuck at v126, Chromium is v147 — ABI mismatch).
 *
 * OpenH264 GMP: Firefox downloads it from Mozilla CDN on first run (~1 MB).
 *   A persistent profile (/opt/ff-profile) caches it between bridge restarts.
 *   The Dockerfile pre-warms the profile so it is baked into the image.
 *
 * Configuration via LOONA_BRIDGE_CONFIG env var (a JSON blob).
 * Required keys:
 *   ws_port:         int — port of the Python WebSocket receiver (127.0.0.1).
 *   app_id:          string — Agora App ID.
 *   channel:         string — Agora RTC channel name.
 *   token:           string — Agora RTC token.
 *   user_id:         int — our viewer UID for RTC.
 *   rtm_token:       string — Agora RTM token.
 *   rtm_uid_app:     string — our RTM UID.
 *   rtm_uid_loona:   string — robot's RTM UID (peer to message).
 *
 * Optional keys:
 *   fps:           int  (default 15)
 *   jpeg_quality:  float (default 0.7)
 */
const { firefox } = require('playwright');
const http = require('http');
const path = require('path');
const fs   = require('fs');

// Persistent Firefox profile — preserves downloaded OpenH264 GMP between restarts.
const PROFILE_DIR = process.env.FIREFOX_PROFILE_DIR || '/opt/ff-profile';

function findSdkFile(pkgName, candidates) {
  let pkgRoot;
  try {
    pkgRoot = path.dirname(require.resolve(pkgName + '/package.json'));
  } catch (e1) {
    try {
      pkgRoot = path.dirname(require.resolve(pkgName));
    } catch (e2) {
      return null;
    }
  }
  for (const rel of candidates) {
    const p = path.join(pkgRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  // Scan top-level for Agora*.js
  try {
    const files = fs.readdirSync(pkgRoot);
    for (const f of files) {
      if (/^Agora.*\.js$/i.test(f)) return path.join(pkgRoot, f);
    }
  } catch (e) {}
  // Scan browser/ subdirectory (agora-rtm-sdk 1.5.x puts its bundle there)
  try {
    const browserDir = path.join(pkgRoot, 'browser');
    const files = fs.readdirSync(browserDir);
    for (const f of files) {
      if (/^Agora.*\.js$/i.test(f) || f === 'index.js') return path.join(browserDir, f);
    }
  } catch (e) {}
  return null;
}

(async () => {
  const cfgRaw = process.env.LOONA_BRIDGE_CONFIG;
  if (!cfgRaw) {
    console.error('LOONA_BRIDGE_CONFIG env var is required (see bridge.js header)');
    process.exit(2);
  }
  let cfg;
  try { cfg = JSON.parse(cfgRaw); }
  catch (e) {
    console.error('LOONA_BRIDGE_CONFIG is not valid JSON: ' + e.message);
    process.exit(2);
  }
  for (const k of ['ws_port']) {
    if (!cfg[k]) {
      console.error('LOONA_BRIDGE_CONFIG missing required field: ' + k);
      process.exit(2);
    }
  }

  // Locate SDK files inside node_modules.
  const rtcPath = findSdkFile('agora-rtc-sdk-ng',
    ['AgoraRTC_N-production.js', 'AgoraRTC_N.js']);
  const rtmPath = findSdkFile('agora-rtm-sdk',
    ['index.js', 'AgoraRTM-1.5.1.js', 'AgoraRTM.js',
     'browser/AgoraRTM-production.js', 'browser/AgoraRTM.js']);

  if (!rtcPath) {
    console.error('agora-rtc-sdk-ng not found in node_modules — run: npm install');
    process.exit(2);
  }
  if (!rtmPath) {
    console.error('agora-rtm-sdk not found in node_modules — run: npm install');
    process.exit(2);
  }
  console.error('[bridge] RTC SDK: ' + rtcPath);
  console.error('[bridge] RTM SDK: ' + rtmPath);
  console.error('[bridge] Browser: Playwright Firefox + OpenH264 GMP (WebRTC H.264)');

  // Serve bridge.html via a local HTTP server so the page gets an http:// origin.
  // file:// pages in Firefox cannot connect via WebSocket to non-localhost hosts
  // (e.g. ws://homeassistant:PORT); an http:// origin has no such restriction.
  const htmlPath = path.resolve(__dirname, 'bridge.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('bridge.html not found at ' + htmlPath);
    process.exit(2);
  }
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  });
  const httpPort = await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
    httpServer.on('error', reject);
  });
  console.error('[bridge] HTML server: http://127.0.0.1:' + httpPort + '/');

  // Ensure profile directory exists.
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Remove Firefox lock files left by a previously crashed instance.
  // Without this, Firefox refuses to open an already-locked profile.
  for (const lock of ['lock', 'parent.lock', '.parentlock']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, lock)); } catch (e) {}
  }

  // Check how GMP was pre-warmed:
  //   Phase 1 (Firefox auto-download): profile dir has gmp-gmpopenh264/
  //   Phase 2 (manual install):        gmp-version.json exists with version+abi
  // bridge.js must declare the version in firefoxUserPrefs because Playwright
  // rewrites user.js on every launch — without it Firefox doesn't know the GMP
  // directory to load even if the .so files are physically present.
  const gmpProfileDir = path.join(PROFILE_DIR, 'gmp-gmpopenh264');
  const hasGmpDir  = fs.existsSync(gmpProfileDir);
  const GMP_INFO_PATH = path.join(__dirname, 'gmp-version.json');  // /opt/loona-bridge/gmp-version.json
  let gmpVersionPrefs = {};

  // Try Phase 2 first (gmp-version.json written by prewarm manual install).
  try {
    const info = JSON.parse(fs.readFileSync(GMP_INFO_PATH, 'utf8'));
    if (info.version && info.abi) {
      gmpVersionPrefs = {
        'media.gmp-gmpopenh264.version':    info.version,
        'media.gmp-gmpopenh264.abi':        info.abi,
        // Keep lastUpdate fresh — stale timestamp (image built weeks ago) causes
        // Firefox to mark the GMP as needing re-download and silently stop decoding.
        'media.gmp-gmpopenh264.lastUpdate': Math.floor(Date.now() / 1000) - 86400,
      };
      console.error('[bridge] GMP Phase 2 (manual install): v' + info.version + ' (' + info.abi + ')');
    }
  } catch (_) {
    // No gmp-version.json — Phase 1 was used; read version+abi from prefs.js so
    // we can inject a fresh lastUpdate.  Without this, an image built weeks ago
    // has a stale lastUpdate in prefs.js and Firefox silently refuses to decode.
    try {
      const prefsJs = fs.readFileSync(path.join(PROFILE_DIR, 'prefs.js'), 'utf8');
      const vM = prefsJs.match(/"media\.gmp-gmpopenh264\.version",\s*"([^"]+)"/);
      const aM = prefsJs.match(/"media\.gmp-gmpopenh264\.abi",\s*"([^"]+)"/);
      if (vM && aM) {
        gmpVersionPrefs = {
          'media.gmp-gmpopenh264.version':    vM[1],
          'media.gmp-gmpopenh264.abi':        aM[1],
          'media.gmp-gmpopenh264.lastUpdate': Math.floor(Date.now() / 1000) - 86400,
        };
        console.error('[bridge] GMP Phase 1 (auto-download, refreshed lastUpdate): v' + vM[1] + ' (' + aM[1] + ')');
      } else {
        console.error('[bridge] GMP Phase 1 (auto-download): prefs.js has no version/abi — using as-is');
      }
    } catch (e2) {
      console.error('[bridge] GMP: could not read prefs.js: ' + e2.message);
    }
  }

  const hasGmp = hasGmpDir || Object.keys(gmpVersionPrefs).length > 0;
  console.error('[bridge] OpenH264 GMP pre-warmed: ' + (hasGmp ? 'YES ✓' : 'NO — will try to download at runtime'));

  // Launch Firefox with a PERSISTENT profile.
  // launchPersistentContext reuses PROFILE_DIR between runs.
  // autoupdate is set FALSE to prevent Firefox from evicting the pre-warmed GMP
  // by trying to fetch a newer version from a CDN that may be unreachable at runtime.
  // MOZ_DISABLE_CONTENT_SANDBOX=1 is the reliable way to disable the GMP
  // sandbox on Linux.  The pref security.sandbox.content.level=0 is also set
  // below but Playwright may not honour it for the GMP child process; the env
  // var always wins.  Without this, libgmpopenh264.so crashes inside Docker's
  // restricted seccomp → Agora gets a hard decode error → stops the RTP stream
  // entirely (raw.bytes=0, framesRx=?).
  const launchEnv = {
    ...process.env,
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
    // Also disable the GMP child-process sandbox (separate from content sandbox).
    // On ARM64 Linux inside Docker (restricted seccomp), Firefox's own seccomp
    // layer on the gmplugin process double-stacks with Docker's policy and causes
    // libgmpopenh264.so to crash → framesDecoded stays 0.
    MOZ_DISABLE_GMP_SANDBOX: '1',
  };

  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    env: launchEnv,
    // Provide a real viewport so Firefox doesn't treat the page as "background".
    // Without this, headless Firefox can suspend <video> elements and freeze
    // AudioContext (current time stuck at 0) before any frames arrive.
    viewport: { width: 1280, height: 720 },
    firefoxUserPrefs: {
      // Allow autoplay without user gesture.
      'media.autoplay.default':             0,
      'media.autoplay.blocking_policy':     0,
      // Allow WebRTC without permission prompts.
      'media.navigator.permission.disabled': true,
      'media.navigator.streams.fake':        false,
      // OpenH264 GMP — enabled but auto-update OFF so the baked version is not
      // replaced by a CDN download that may fail on the production network.
      'media.gmp-manager.updateEnabled':     true,   // keep manager on for initial install
      'media.gmp-gmpopenh264.enabled':       true,
      'media.gmp-gmpopenh264.autoupdate':    false,  // OFF — don't evict pre-warmed GMP
      // Inject fresh version/abi/lastUpdate prefs (read from prefs.js or gmp-version.json
      // above).  Required because:
      //  a) Playwright rewrites user.js on every launch, erasing prefs.js GMP entries.
      //  b) lastUpdate from image-build-time becomes stale → Firefox marks GMP as
      //     needing update → silently skips decode even though .so is physically present.
      ...gmpVersionPrefs,
      // Disable content-process sandbox.
      // In Docker (seccomp restricted) the GMP content process (runs libgmpopenh264.so)
      // may fail to spawn if Firefox's own seccomp layer is active at the same time as
      // Docker's policy.  Level 0 = no Firefox seccomp — GMP process starts cleanly.
      // The GMP still runs in a separate OS process; only Firefox's extra seccomp is off.
      'security.sandbox.content.level':     0,
      // Disable background services that slow startup.
      'app.update.enabled':                  false,
      'toolkit.telemetry.enabled':           false,
      'datareporting.healthreport.service.enabled': false,
    },
  });

  console.error('[bridge] Firefox launched (persistent profile: ' + PROFILE_DIR + ')');

  const page = await context.newPage();

  // No timeout — startAgora runs indefinitely.
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);

  page.on('console', (msg) => {
    const text = msg.text();
    console.error('[bridge js] ' + text);
    // bridge.html signals [FATAL] when ws fails persistently — Python restarted on
    // a new port.  Exit so run.sh re-reads bridge-config.json with the new ws_port.
    if (text.startsWith('[FATAL]')) {
      console.error('[bridge] fatal signal from page — exiting for run.sh restart');
      shutdown();
    }
  });
  page.on('pageerror', (err) => console.error('[bridge js ERROR] ' + err.message));

  await page.goto('http://127.0.0.1:' + httpPort + '/', { waitUntil: 'load' });
  httpServer.close();

  // Override visibility API — headless Firefox reports page as "hidden", which
  // causes <video> elements to immediately suspend (Agora: "waiting => suspend")
  // and freezes AudioContext (currentTime stuck at 0).
  // Both kill the video pipeline before any RTP frames arrive.
  await page.evaluate(() => {
    // Make the page appear visible and focused at all times.
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hidden',          { get: () => false,      configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    } catch (e) {}
    // Pre-create an AudioContext and keep it alive with a silent gain node.
    // Agora SDK creates its own AudioContext; if that context is suspended on
    // creation, audio (and video) playback never starts.
    // Patching AudioContext to auto-resume covers Agora's internal context too.
    try {
      const OrigAC = window.AudioContext || window.webkitAudioContext;
      if (OrigAC) {
        function PatchedAC(...args) {
          const ctx = new OrigAC(...args);
          const resume = () => ctx.state !== 'running' && ctx.resume().catch(() => {});
          resume();
          ctx.addEventListener('statechange', resume);
          document.addEventListener('visibilitychange', resume);
          return ctx;
        }
        PatchedAC.prototype = OrigAC.prototype;
        Object.setPrototypeOf(PatchedAC, OrigAC);
        window.AudioContext = PatchedAC;
        if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
      }
    } catch (e) {}
    console.log('[bridge-init] visibility override + AudioContext patch applied');
  });

  // Inject the SDK bundles directly.
  await page.addScriptTag({ path: rtcPath });
  await page.addScriptTag({ path: rtmPath });

  // Verify globals.
  const have = await page.evaluate(() => ({
    rtc: typeof AgoraRTC !== 'undefined',
    rtm: typeof AgoraRTM !== 'undefined',
  }));
  console.error('[bridge] window.AgoraRTC=' + have.rtc + '  window.AgoraRTM=' + have.rtm);
  if (!have.rtc || !have.rtm) {
    console.error('[bridge fatal] SDK script(s) failed to define globals — abort');
    process.exit(3);
  }

  // Fire-and-forget: startAgora sets up event handlers and runs indefinitely.
  page.evaluate(cfg => window.startAgora(cfg), cfg).catch((err) => {
    console.error('[bridge] startAgora error: ' + (err && err.message || String(err)));
  });
  console.error('[bridge] page started, streaming...');

  const shutdown = async () => {
    try { await context.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
})().catch((err) => {
  console.error('[bridge fatal] ' + (err && err.stack || err));
  process.exit(1);
});
