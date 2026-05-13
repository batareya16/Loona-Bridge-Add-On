#!/usr/bin/env node
/**
 * Headless Chromium bridge: launches a tiny page that loads the Agora Web SDKs
 * (RTC + RTM), subscribes to the robot's video track, and pipes JPEG frames
 * over WebSocket to the Python receiver.
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
 *   headless:      bool (default true)
 */
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

function findSdkFile(pkgName, candidates) {
  // Some Agora packages (e.g. agora-rtc-sdk-ng) declare an "exports" field that
  // blocks require.resolve('<pkg>/package.json'). Fallback chain: resolve the
  // main entry to find the package root, then check our candidate filenames.
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
  // Last resort: scan top-level for a .js file matching name pattern.
  try {
    const files = fs.readdirSync(pkgRoot);
    for (const f of files) {
      if (/^Agora.*\.js$/i.test(f)) return path.join(pkgRoot, f);
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

  // Locate the bundled SDK files inside node_modules.
  const rtcPath = findSdkFile('agora-rtc-sdk-ng',
    ['AgoraRTC_N-production.js', 'AgoraRTC_N.js']);
  // agora-rtm-sdk@1.5.1 ships as a UMD bundle in index.js (not AgoraRTM-1.5.1.js).
  const rtmPath = findSdkFile('agora-rtm-sdk',
    ['index.js', 'AgoraRTM-1.5.1.js', 'AgoraRTM.js']);
  // Broadway.js: pure-JS H.264 decoder (asm.js). Not on npm — download manually:
  //   curl -Lo bridge/broadway.js \
  //     https://raw.githubusercontent.com/mbebenita/Broadway/master/Player/Decoder.js
  const broadwayLocal = path.join(__dirname, 'broadway.js');
  const broadwayPath  = fs.existsSync(broadwayLocal)
    ? broadwayLocal
    : findSdkFile('broadway', ['dist/Decoder.js', 'Decoder.js']);
  if (!rtcPath) {
    console.error('agora-rtc-sdk-ng not found in node_modules — run: npm install');
    process.exit(2);
  }
  if (!rtmPath) {
    console.error('agora-rtm-sdk not found in node_modules — run: npm install');
    process.exit(2);
  }
  if (!broadwayPath) {
    console.error('broadway.js not found — download it first:');
    console.error('  curl -Lo ' + path.join(__dirname, 'broadway.js') +
                  ' https://cdn.jsdelivr.net/gh/mbebenita/Broadway@master/dist/Decoder.js');
    process.exit(2);
  }
  console.error('[bridge] RTC SDK:  ' + rtcPath);
  console.error('[bridge] RTM SDK:  ' + rtmPath);
  console.error('[bridge] Broadway: ' + broadwayPath);

  // Robot publishes H.264 video. Open-source Chromium and puppeteer's bundled
  // Chrome-for-Testing both ship WITHOUT proprietary codecs — they receive
  // ~3 Mbps of bytes but produce zero decoded frames. Browsers that DO have
  // H.264 (Google's licensed builds): Google Chrome, Brave, Edge, Opera.
  // Search in priority order — codec-having browsers first, Chromium last.
  const candidates = [
    {path: process.env.CHROME_PATH, hasCodecs: 'unknown', label: 'CHROME_PATH'},
    {path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',                hasCodecs: true,  label: 'Google Chrome'},
    {path: '/Applications/Arc.app/Contents/MacOS/Arc',                                    hasCodecs: true,  label: 'Arc'},
    {path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',                hasCodecs: true,  label: 'Brave'},
    {path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',              hasCodecs: true,  label: 'Edge'},
    {path: '/Applications/Opera.app/Contents/MacOS/Opera',                                hasCodecs: true,  label: 'Opera'},
    {path: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',                            hasCodecs: true,  label: 'Vivaldi'},
    {path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',  hasCodecs: true,  label: 'Chrome Canary'},
    {path: '/usr/bin/google-chrome',                                                       hasCodecs: true,  label: 'google-chrome (linux)'},
    {path: '/usr/bin/brave-browser',                                                       hasCodecs: true,  label: 'brave-browser (linux)'},
    // Chromium last — its codec support depends on build, often missing H.264.
    {path: '/Applications/Chromium.app/Contents/MacOS/Chromium',                          hasCodecs: false, label: 'Chromium (no H.264!)'},
    {path: '/usr/bin/chromium-browser',                                                    hasCodecs: false, label: 'chromium-browser (linux)'},
    {path: '/usr/lib/chromium/chromium',                                                   hasCodecs: false, label: 'chromium-binary (alpine)'},
    {path: '/usr/bin/chromium',                                                            hasCodecs: false, label: 'chromium (linux)'},
  ].filter(c => c.path);

  let executablePath, picked;
  for (const c of candidates) {
    try { if (fs.existsSync(c.path)) { executablePath = c.path; picked = c; break; } }
    catch (e) {}
  }

  if (picked) {
    console.error(`[bridge] using browser: ${picked.label} → ${executablePath}`);
    if (picked.hasCodecs === false) {
      console.error('[bridge] WARN: this browser (Chromium) likely LACKS H.264 codec.');
      console.error('[bridge] WARN: bytes will arrive (receiveBitrate>0) but decoder will produce 0 frames.');
      console.error('[bridge] WARN: install Google Chrome / Brave / Edge to fix, OR set CHROME_PATH.');
    }
  } else {
    console.error('[bridge] no system browser found — falling back to puppeteer-bundled');
    console.error('[bridge] WARN: bundled Chrome-for-Testing also lacks H.264, video will likely be black.');
    console.error('[bridge] WARN: install Google Chrome (or set CHROME_PATH=/path/to/chrome) to fix.');
  }

  // Detect headless mode: 'new' needs Chromium 112+. Alpine's chromium may
  // be older, so use legacy true when running a system binary.
  const useNewHeadless = !executablePath || executablePath.includes('google-chrome');
  // Test Chromium binary before handing off to puppeteer.
  // Must include GPU/sandbox flags — without them chromium SIGSEGVs early on Alpine.
  if (executablePath) {
    const { spawnSync } = require('child_process');
    const vr = spawnSync(executablePath,
      ['--headless', '--no-sandbox', '--disable-setuid-sandbox',
       '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--version'],
      { timeout: 5000, encoding: 'buffer' });
    const vOut = (vr.stdout || Buffer.alloc(0)).toString().trim();
    const vErr = (vr.stderr || Buffer.alloc(0)).toString().trim();
    if (vr.status === 0) {
      console.error('[bridge] chromium version: ' + (vOut || vErr));
    } else if (vr.error) {
      // spawn-level error (ENOENT, EACCES, etc.)
      console.error('[bridge] chromium spawn error: ' + vr.error.message);
    } else {
      console.error('[bridge] chromium --version exit=' + vr.status +
        ' signal=' + vr.signal +
        ' stdout=' + vOut.slice(0, 200) +
        ' stderr=' + vErr.slice(0, 200));
    }
  }

  const browser = await puppeteer.launch({
    headless: cfg.headless === false ? false : (useNewHeadless ? 'new' : true),
    executablePath: executablePath || undefined,
    dumpio: true,   // pipe Chromium stdout/stderr so we see the crash reason
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--disable-seccomp-filter-sandbox',
      '--disable-namespace-sandbox',
      '--disable-crash-reporter',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,WebRtcHideLocalIpsWithMdns',
    ],
  });

  const page = await browser.newPage();
  page.on('console',   (msg) => console.error('[bridge js] ' + msg.text()));
  page.on('pageerror', (err) => console.error('[bridge js ERROR] ' + err.message));

  const htmlPath = path.resolve(__dirname, 'bridge.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('bridge.html not found at ' + htmlPath);
    process.exit(2);
  }
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });

  // Inject the SDK bundles directly — sidestepping CDN flakiness.
  await page.addScriptTag({ path: rtcPath });
  await page.addScriptTag({ path: rtmPath });

  // Broadway Decoder.js is Emscripten/WASM — it calls fetch('avc.wasm') at
  // runtime.  headless Chrome blocks file:// fetches (CORS).
  // Fix: patch window.fetch BEFORE the script loads so that any request for
  // 'avc.wasm' is served from the pre-read binary, never hitting the network.
  const broadwayWasmPath = path.join(path.dirname(broadwayPath), 'avc.wasm');
  if (fs.existsSync(broadwayWasmPath)) {
    const wasmB64 = fs.readFileSync(broadwayWasmPath).toString('base64');
    await page.evaluate((b64) => {
      // Decode base64 → ArrayBuffer once.
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const wasmBytes = buf.buffer;

      // Patch fetch so Emscripten's wasm streaming/array-buffer fallbacks both work.
      const _origFetch = window.fetch;
      window.fetch = async function(url, ...rest) {
        if (typeof url === 'string' && url.includes('avc.wasm')) {
          console.log('[wasm-intercept] serving avc.wasm from pre-loaded binary (' +
                      wasmBytes.byteLength + ' bytes)');
          return new Response(new Uint8Array(wasmBytes), {
            status: 200, headers: {'Content-Type': 'application/wasm'},
          });
        }
        return _origFetch.apply(this, [url, ...rest]);
      };
      // Also set Module['wasmBinary'] as belt-and-suspenders.
      window.Module = window.Module || {};
      window.Module['wasmBinary'] = wasmBytes;
      console.log('[wasm-intercept] fetch patched + Module.wasmBinary set');
    }, wasmB64);
    console.error('[bridge] Broadway WASM intercept ready: ' + broadwayWasmPath);
  } else {
    console.error('[bridge] WARN: avc.wasm not found — Broadway will fail. Download:');
    console.error('[bridge]   curl -Lo ' + broadwayWasmPath +
      ' https://raw.githubusercontent.com/mbebenita/Broadway/master/Player/avc.wasm');
  }
  await page.addScriptTag({ path: broadwayPath });

  // Sanity-check that the globals appeared.
  const have = await page.evaluate(() => ({
    rtc:      typeof AgoraRTC !== 'undefined',
    rtm:      typeof AgoraRTM !== 'undefined',
    broadway: typeof Decoder  !== 'undefined',
  }));
  console.error('[bridge] window.AgoraRTC=' + have.rtc +
                '  window.AgoraRTM=' + have.rtm +
                '  window.Decoder(Broadway)=' + have.broadway);
  if (!have.rtc || !have.rtm || !have.broadway) {
    console.error('[bridge fatal] SDK script(s) failed to define globals — abort');
    process.exit(3);
  }

  await page.evaluate(async (cfg) => { return await window.startAgora(cfg); }, cfg);
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
