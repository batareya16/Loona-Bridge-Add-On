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

  // Check if OpenH264 GMP is already in the profile (pre-warmed during build).
  const gmpDir = path.join(PROFILE_DIR, 'gmp-gmpopenh264');
  const hasGmp = fs.existsSync(gmpDir);
  console.error('[bridge] OpenH264 GMP in profile: ' + (hasGmp ? 'YES ✓' : 'NO — will download on first run'));

  // Launch Firefox with a PERSISTENT profile.
  // launchPersistentContext reuses PROFILE_DIR between runs, so the OpenH264
  // GMP download (triggered by media.gmp-gmpopenh264.enabled=true) is preserved.
  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    firefoxUserPrefs: {
      // Allow autoplay without user gesture.
      'media.autoplay.default':             0,
      'media.autoplay.blocking_policy':     0,
      // Allow WebRTC without permission prompts.
      'media.navigator.permission.disabled': true,
      'media.navigator.streams.fake':        false,
      // OpenH264 GMP — required for WebRTC H.264 encode AND decode in Firefox.
      // Firefox downloads ~1 MB from Mozilla CDN on first run; cached in profile.
      'media.gmp-gmpopenh264.enabled':       true,
      'media.gmp-gmpopenh264.autoupdate':    true,
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

  page.on('console',   (msg) => console.error('[bridge js] ' + msg.text()));
  page.on('pageerror', (err) => console.error('[bridge js ERROR] ' + err.message));

  await page.goto('http://127.0.0.1:' + httpPort + '/', { waitUntil: 'load' });
  httpServer.close();

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
