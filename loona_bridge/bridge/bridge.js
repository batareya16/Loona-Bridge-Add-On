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
  // Serve bridge.html + static assets (broadway.js, avc.wasm) from __dirname.
  // avc.wasm is loaded by broadway.js via fetch('avc.wasm', ...) relative to the
  // page origin, so it must be served from the same HTTP server.
  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
      return;
    }
    // Serve static files from bridge dir — prevent path traversal
    const fname = url.replace(/^\/+/, '').replace(/\.\./g, '');
    if (fname && !fname.includes('/')) {
      const fpath = path.join(__dirname, fname);
      try {
        if (fs.existsSync(fpath) && fs.statSync(fpath).isFile()) {
          const ext = path.extname(fpath).toLowerCase();
          const ct = { '.js': 'application/javascript', '.wasm': 'application/wasm',
                       '.html': 'text/html' }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct });
          fs.createReadStream(fpath).pipe(res);
          return;
        }
      } catch (_) {}
    }
    res.writeHead(404); res.end('Not found');
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
    // NOTE: MOZ_DISABLE_GMP_SANDBOX was tried but broke ICE/UDP in Firefox
    // (likely affects socket/media child process spawning). Removed.
    // full_access=true in config.yaml (--privileged Docker) removes the outer
    // seccomp layer so Firefox's inner GMP sandbox works correctly.
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
      // In headless Firefox, tabs never become "foreground" in the OS sense.
      // Without this pref, Firefox keeps AudioContext suspended even when
      // media.autoplay.default=0, causing Agora to warn
      // "AudioContext current time stuck at 0" and freeze its media pipeline.
      'media.block-autoplay-until-in-foreground': false,
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
      // ── Force software-only H.264 decode via OpenH264 GMP ───────────────────
      // On ARM64 (Raspberry Pi 4) Firefox may try VA-API / V4L2 hardware H.264 decode.
      // Inside Docker the GPU/VPU device nodes (/dev/dri/*, /dev/video*) are typically
      // not available, so hardware decode init fails silently.
      // Firefox's WebRTC pipeline initialises the decoder BEFORE starting the jitter
      // buffer — if decoder init fails, the jitter buffer never starts:
      //   packetsReceived > 0 (SRTP layer works) but jbe=0, framesReceived=0, pliCount=0.
      // Disabling hardware decode forces Firefox to use OpenH264 GMP (software) which
      // is pre-warmed in the persistent profile and works in Docker.
      'media.hardware-video-decoding.enabled':       false,
      'media.hardware-video-decoding.force-enabled': false,
      'media.ffmpeg.vaapi.enabled':                  false,
      'media.ffmpeg.vaapi-drm-display.enabled':      false,
      // Ensure GMP decoder is active for WebRTC H.264.
      'media.gmp.decoder.enabled':                   true,
      // ── H265/HEVC WebRTC support (Firefox 130+) ─────────────────────────
      // Loona robot sends H265 (HEVC) video via Agora on SSRC=40000.
      // Firefox 130 added H265 WebRTC support but it is OFF by default.
      // Enabling it allows Agora to negotiate H265 in the video SDP so the
      // robot routes H265 to the video receiver (not PT=0 audio PCMU slot).
      // GStreamer avdec_h265 (installed by playwright --with-deps via
      // gstreamer1.0-libav) provides software H265 decode — no hardware GPU needed.
      'media.peerconnection.video.h265_enabled': true,
      // Disable background services that slow startup.
      'app.update.enabled':                  false,
      'toolkit.telemetry.enabled':           false,
      'datareporting.healthreport.service.enabled': false,
    },
  });

  console.error('[bridge] Firefox launched (persistent profile: ' + PROFILE_DIR + ')');

  const page = await context.newPage();

  // ── Track C: H265 → JPEG via Node.js ffmpeg ──────────────────────────────────
  // WebCodecs VideoDecoder doesn't support H265 on Linux ARM64 without VA-API.
  // GStreamer avdec_h265 may not be available in the HA base image.
  // This fallback decodes H265 Annex B in Node.js (ffmpeg subprocess) and injects
  // JPEG frames back into the page, which sends them to the Python HA Core socket.
  //
  // Flow: bridge.html RTCRtpScriptTransform → reassemble FU/AP → Annex B →
  //       window.__h265FeedNAL(base64) → [IPC] → bridge.js → ffmpeg stdin →
  //       ffmpeg stdout JPEG → page.evaluate(window.__nodeJpegReady) → ws.send
  const cp = require('child_process');
  let ffH265 = null, ffBuf = Buffer.alloc(0);

  function startFfmpeg() {
    if (ffH265) return;
    ffH265 = cp.spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'hevc',        // raw H265 Annex B stream from stdin
      '-i', 'pipe:0',
      '-f', 'image2pipe',  // stream of individual image frames
      '-vcodec', 'mjpeg',  // JPEG output
      '-q:v', '4',         // quality 1–31, lower=better (4 ≈ 85%)
      '-an',               // no audio
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'inherit'] });

    ffH265.stdin.on('error', () => {});
    ffH265.on('error', (e) => console.error('[ffmpeg] ' + e.message));
    ffH265.on('exit', (code) => {
      console.error('[ffmpeg] exited code=' + code + ' — will restart on next NAL');
      ffH265 = null;
    });

    ffH265.stdout.on('data', (chunk) => {
      ffBuf = Buffer.concat([ffBuf, chunk]);
      // Scan for complete JPEG frames: SOI=0xFF 0xD8 ... EOI=0xFF 0xD9
      while (true) {
        let soi = -1;
        for (let i = 0; i + 1 < ffBuf.length; i++) {
          if (ffBuf[i] === 0xFF && ffBuf[i + 1] === 0xD8) { soi = i; break; }
        }
        if (soi < 0) { ffBuf = Buffer.alloc(0); break; }
        let eoi = -1;
        for (let i = soi + 2; i + 1 < ffBuf.length; i++) {
          if (ffBuf[i] === 0xFF && ffBuf[i + 1] === 0xD9) { eoi = i; break; }
        }
        if (eoi < 0) { if (soi > 0) ffBuf = ffBuf.slice(soi); break; }
        const jpeg = ffBuf.slice(soi, eoi + 2);
        ffBuf = ffBuf.slice(eoi + 2);
        // Inject JPEG into page → window.__nodeJpegReady → ws.send to Python
        page.evaluate((b64) => {
          if (typeof window.__nodeJpegReady === 'function') window.__nodeJpegReady(b64);
        }, jpeg.toString('base64')).catch(() => {});
      }
    });

    console.error('[ffmpeg] H265 decoder started pid=' + ffH265.pid);
  }

  // Exposed to bridge.html: receives base64-encoded H265 Annex B NAL unit.
  // Fire-and-forget — no return value needed.
  await page.exposeFunction('__h265FeedNAL', (b64) => {
    if (!ffH265) startFfmpeg();
    if (ffH265 && !ffH265.stdin.destroyed) {
      try { ffH265.stdin.write(Buffer.from(b64, 'base64')); } catch (_) {}
    }
  });

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
  page.on('pageerror', (err) => {
    const msg = err && err.message || String(err);
    // Broadway.js WASM abort is an expected error during initialization if
    // avc.wasm fetch races with something — log but don't treat as fatal.
    if (msg.includes('wasmBinary') || msg.includes('broadwayOnPicture') ||
        msg.includes('on the web, we need the wasm')) {
      console.error('[bridge js WASM-ABORT] ' + msg.slice(0, 120));
      return;
    }
    console.error('[bridge js ERROR] ' + msg);
  });

  await page.goto('http://127.0.0.1:' + httpPort + '/', { waitUntil: 'load' });
  // NOTE: httpServer is intentionally NOT closed here.
  // broadway.js (loaded via <script src="/broadway.js"> in bridge.html) starts
  // WebAssembly.instantiateStreaming(fetch('avc.wasm')) asynchronously — this
  // fetch fires AFTER the 'load' event and would fail if the server were closed.
  // The server binds to 127.0.0.1:0 (random port, local-only) and will be
  // garbage-collected when the Node.js process exits.
  console.error('[bridge] HTML server kept alive for avc.wasm fetch');

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
    // Agora SDK v4.24+ uses AudioContext.currentTime as its jitter-buffer clock.
    // In headless Firefox inside Docker (no audio device), the AudioContext cannot
    // be resumed — ctx.state stays 'suspended' and currentTime stays 0 forever.
    // Agora detects this after ~10 s ("AudioContext current time stuck at 0") and
    // freezes its video decode scheduler → framesDecoded=0 forever.
    //
    // Fix A (prototype patch): Override AudioContext.prototype.currentTime.
    //   When the native getter returns 0 (context suspended), return a synthetic
    //   monotonically-increasing time from performance.now() instead.
    //   Agora's scheduler sees advancing time and proceeds with jitter-buffer emit.
    //
    // Fix B (constructor patch): Still attempt ctx.resume() + silent BufferSource
    //   so we use the real clock if the audio backend eventually becomes available.
    try {
      const OrigAC = window.AudioContext || window.webkitAudioContext;
      if (OrigAC) {
        // A: prototype currentTime override (applies to ALL AudioContext instances,
        //    including the one Agora creates internally).
        const origDesc = Object.getOwnPropertyDescriptor(OrigAC.prototype, 'currentTime');
        if (origDesc && origDesc.get) {
          Object.defineProperty(OrigAC.prototype, 'currentTime', {
            get() {
              const real = origDesc.get.call(this);
              if (real > 0) return real;                  // context running — use real clock
              if (!this._synthOrigin) this._synthOrigin = performance.now();
              return (performance.now() - this._synthOrigin) / 1000;  // synthetic
            },
            configurable: true,
          });
          console.log('[bridge-init] AudioContext.currentTime synthetic-time patch applied');
        }

        // B: constructor patch — still try real resume (harmless if no audio device).
        function PatchedAC(...args) {
          const ctx = new OrigAC(...args);
          const tryResume = () => {
            if (ctx.state === 'running') return;
            ctx.resume().catch(() => {});
            try {
              const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
              const src = ctx.createBufferSource();
              src.buffer = buf; src.connect(ctx.destination); src.start(0);
            } catch (_) {}
          };
          tryResume();
          ctx.addEventListener('statechange', tryResume);
          document.addEventListener('visibilitychange', tryResume);
          setTimeout(tryResume, 200);
          setTimeout(tryResume, 1000);
          return ctx;
        }
        PatchedAC.prototype = OrigAC.prototype;
        Object.setPrototypeOf(PatchedAC, OrigAC);
        window.AudioContext = PatchedAC;
        if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
      }
    } catch (e) {}
    // ── Intercept RTCPeerConnection constructor ──────────────────────────────
    // Log config (especially encodedInsertableStreams:true which means Agora
    // will call createEncodedStreams() and bypass Firefox's native H.264 decode).
    try {
      const _OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = function(config, constraints) {
        if (config) {
          const {iceServers: _ign, ...rest} = config;
          if (Object.keys(rest).length)
            console.log('[pc-new] ' + JSON.stringify(rest));
        }
        return new _OrigPC(config, constraints);
      };
      window.RTCPeerConnection.prototype = _OrigPC.prototype;
      Object.setPrototypeOf(window.RTCPeerConnection, _OrigPC);
    } catch(e) {}

    // ── Intercept createEncodedStreams ───────────────────────────────────────
    // If Agora calls this, it owns the encoded bitstream — Firefox's native
    // decoder never sees frames → framesReceived=0, framesDecoded=0, pliCount=0.
    // Log it so we can confirm the hypothesis; passthrough for now.
    try {
      if (RTCRtpReceiver.prototype.createEncodedStreams) {
        const _origCES = RTCRtpReceiver.prototype.createEncodedStreams;
        RTCRtpReceiver.prototype.createEncodedStreams = function() {
          console.log('[enc-streams] createEncodedStreams called kind=' +
            (this.track && this.track.kind || '?'));
          return _origCES.apply(this, arguments);
        };
        console.log('[bridge-init] createEncodedStreams intercepted (diagnostic)');
      } else {
        console.log('[bridge-init] createEncodedStreams not present in this Firefox');
      }
    } catch(e) {}

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
