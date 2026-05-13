#!/usr/bin/env node
/**
 * Playwright/Firefox bridge: launches Firefox (via Playwright), loads the Agora
 * Web SDKs (RTC + RTM), subscribes to the robot's video track, and pipes JPEG
 * frames over WebSocket to the Python receiver.
 *
 * Why Firefox instead of Chromium:
 *   Firefox decodes H.264 WebRTC via its bundled libavcodec on all platforms
 *   including ARM64 Linux — no proprietary codec package needed.
 *   Chromium on ARM64 Linux has no usable H.264 WebRTC support in 2026
 *   (chromium-codecs-ffmpeg-extra is stuck at v126, Chromium is v147 — ABI mismatch).
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
  // Also scan browser/ subdirectory (agora-rtm-sdk 1.5.x puts bundle there)
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
  console.error('[bridge] Browser: Playwright Firefox (built-in H.264 via libavcodec)');

  // Serve bridge.html via a local HTTP server so Firefox gets an http:// origin.
  // file:// pages in Firefox cannot make WebSocket connections to non-localhost
  // hosts (e.g. ws://homeassistant:PORT) — the http:// origin has no such limit.
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

  // Launch Firefox.
  // H.264 WebRTC decode is handled by Firefox's bundled libavcodec — no GMP/OpenH264
  // download needed. OpenH264 GMP is for encoding only; we only receive video.
  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      // Allow autoplay without user gesture.
      'media.autoplay.default':           0,
      'media.autoplay.blocking_policy':   0,
      // Allow WebRTC without permission prompts.
      'media.navigator.permission.disabled': true,
      'media.navigator.streams.fake':     false,
      // Disable GMP auto-download (we don't need OpenH264 — only receiving H.264,
      // not encoding; Firefox's built-in decoder handles it).
      'media.gmp-gmpopenh264.enabled':    false,
      'media.gmp-gmpopenh264.autoupdate': false,
      // Disable telemetry/update checks to speed up startup.
      'app.update.enabled':               false,
      'toolkit.telemetry.enabled':        false,
      'datareporting.healthreport.service.enabled': false,
    },
  });

  console.error('[bridge] Firefox launched');

  // Firefox permissions are handled via firefoxUserPrefs above
  // (media.navigator.permission.disabled = true).
  // Playwright's newContext permissions API is Chromium-only — not supported in Firefox.
  const context = await browser.newContext();
  const page = await context.newPage();

  // Disable all timeouts — startAgora can legitimately take >30 s on slow networks.
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);

  page.on('console',   (msg) => console.error('[bridge js] ' + msg.text()));
  page.on('pageerror', (err) => console.error('[bridge js ERROR] ' + err.message));

  await page.goto('http://127.0.0.1:' + httpPort + '/', { waitUntil: 'load' });
  // HTML is loaded — HTTP server no longer needed.
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

  // startAgora sets up event handlers and runs indefinitely (WebSocket, Agora RTC/RTM).
  // We do not await its return — just fire it and let the page run.
  // Errors surface via page.on('pageerror') and page.on('console').
  page.evaluate(cfg => window.startAgora(cfg), cfg).catch((err) => {
    console.error('[bridge] startAgora error: ' + (err && err.message || String(err)));
  });
  console.error('[bridge] page started, streaming...');

  const shutdown = async () => {
    try { await browser.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
})().catch((err) => {
  console.error('[bridge fatal] ' + (err && err.stack || err));
  process.exit(1);
});
