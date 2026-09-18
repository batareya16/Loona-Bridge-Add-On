#!/usr/bin/env node
/** Firefox/Agora bridge: WebRTC video to JPEG frames over a local WebSocket. */
const { firefox } = require('playwright');
const http = require('http');
const path = require('path');
const fs   = require('fs');

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

  // Firefox requires an HTTP origin for the Core WebSocket.
  const htmlPath = path.resolve(__dirname, 'bridge.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('bridge.html not found at ' + htmlPath);
    process.exit(2);
  }
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
      return;
    }
    // Serve static files from the bridge directory only.
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

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Stale locks prevent opening the profile after a crash.
  for (const lock of ['lock', 'parent.lock', '.parentlock']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, lock)); } catch (e) {}
  }

  // Playwright rewrites user.js, so restore pre-warmed GMP metadata at launch.
  const gmpProfileDir = path.join(PROFILE_DIR, 'gmp-gmpopenh264');
  const hasGmpDir  = fs.existsSync(gmpProfileDir);
  const GMP_INFO_PATH = path.join(__dirname, 'gmp-version.json');
  let gmpVersionPrefs = {};

  try {
    const info = JSON.parse(fs.readFileSync(GMP_INFO_PATH, 'utf8'));
    if (info.version && info.abi) {
      gmpVersionPrefs = {
        'media.gmp-gmpopenh264.version':    info.version,
        'media.gmp-gmpopenh264.abi':        info.abi,
        'media.gmp-gmpopenh264.lastUpdate': Math.floor(Date.now() / 1000) - 86400,
      };
      console.error('[bridge] GMP Phase 2 (manual install): v' + info.version + ' (' + info.abi + ')');
    }
  } catch (_) {
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

  const launchEnv = {
    ...process.env,
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
  };

  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    timeout: 120_000,
    env: launchEnv,
    viewport: { width: 1280, height: 720 },
    firefoxUserPrefs: {
      'media.autoplay.default':             0,
      'media.autoplay.blocking_policy':     0,
      'media.block-autoplay-until-in-foreground': false,
      'media.navigator.permission.disabled': true,
      'media.navigator.streams.fake':        false,
      // One bridge page does not need Firefox's default process pool.
      'dom.ipc.processCount':                1,
      'dom.ipc.processCount.webIsolated':    1,
      'browser.tabs.remote.autostart':       false,
      'browser.tabs.remote.autostart.2':     false,
      'browser.tabs.remote.separatePrivilegedContentProcess': false,
      'browser.cache.memory.capacity':       16384,
      'media.memory_cache_max_size':         16384,
      'media.gmp-manager.updateEnabled':     true,
      'media.gmp-gmpopenh264.enabled':       true,
      'media.gmp-gmpopenh264.autoupdate':    false,
      ...gmpVersionPrefs,
      'security.sandbox.content.level':     0,
      'media.hardware-video-decoding.enabled':       false,
      'media.hardware-video-decoding.force-enabled': false,
      'media.ffmpeg.vaapi.enabled':                  false,
      'media.ffmpeg.vaapi-drm-display.enabled':      false,
      'media.gmp.decoder.enabled':                   true,
      'media.peerconnection.video.h265_enabled': true,
      'app.update.enabled':                  false,
      'toolkit.telemetry.enabled':           false,
      'datareporting.healthreport.service.enabled': false,
    },
  });

  console.error('[bridge] Firefox launched (persistent profile: ' + PROFILE_DIR + ')');

  const page = await context.newPage();
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[bridge] stopping: ' + reason);
    try { if (ffH265) ffH265.kill('SIGTERM'); } catch (e) {}
    try { await context.close(); } catch (e) {}
    try { httpServer.close(); } catch (e) {}
    process.exit(0);
  };

  // ── Track C: H265 → JPEG via Node.js ffmpeg + direct Python WS ───────────────
  //
  // Optimised flow (v0.1.81):
  //   bridge.html RTCRtpScriptTransform → reassemble FU/AP → Annex B →
  //   window.__h265FeedNAL(base64) → [CDP IPC] → bridge.js → ffmpeg stdin →
  //   ffmpeg stdout JPEG → bridge.js WS → Python  (binary, no base64, no page.evaluate)
  //
  // Key changes vs previous:
  //   • bridge.js opens its own WebSocket to Python and sends JPEG as raw binary.
  //     Eliminates: page.evaluate per frame, base64 encode/decode, Firefox WS send.
  //   • Hardware H265 decode (hevc_v4l2m2m) attempted first on ARM64;
  //     auto-falls back to software if the device is unavailable.
  //   • bridge.html WS is now used only for agora_config receive + RTM messages.

  const cp  = require('child_process');
  const WS  = require('ws');

  // ── Direct Python WebSocket (JPEG forwarding) ─────────────────────────────────
  const pyWsUrl    = `ws://${cfg.ws_host || '127.0.0.1'}:${cfg.ws_port}`;
  let   pyWs       = null;
  let   pyWsReady  = false;
  let   pyWsReconnectTimer = null;
  let   pyWsRetryMs = 3000;
  let   firstJpeg  = true;
  const minIntervalMs = Math.floor(1000 / Math.max(1, cfg.fps || 10));
  const PY_WS_MAX_BUFFERED = 512 * 1024;
  let   lastSendMs    = 0;

  function openPyWs() {
    const sock = new WS(pyWsUrl);
    sock.on('open', () => {
      pyWs      = sock;
      pyWsReady = true;
      pyWsRetryMs = 3000;
      clearTimeout(pyWsReconnectTimer);
      pyWsReconnectTimer = null;
      console.error('[pyWs] connected to Python at ' + pyWsUrl);
    });
    sock.on('close', () => {
      if (pyWs === sock) {
        pyWs      = null;
        pyWsReady = false;
      }
      // This is a data-only channel. Core may replace it while a camera session
      // is being created, so a single close must not kill Firefox. The page's
      // control WS owns session liveness and will request a restart if its port
      // genuinely remains unavailable.
      if (!shuttingDown) {
        console.error('[pyWs] Python connection closed — retrying in ' +
                      (pyWsRetryMs / 1000) + ' s');
        clearTimeout(pyWsReconnectTimer);
        pyWsReconnectTimer = setTimeout(openPyWs, pyWsRetryMs);
        pyWsRetryMs = Math.min(pyWsRetryMs * 2, 30000);
      }
    });
    sock.on('error', () => {});   // close event fires anyway
  }
  openPyWs();

  // ── ffmpeg H265 decoder ────────────────────────────────────────────────────────
  let ffH265            = null;
  let ffBuf             = Buffer.alloc(0);
  const MAX_JPEG_BUFFER = 4 * 1024 * 1024;
  // hevc_v4l2m2m: rpivid driver present in HA OS on RPi4 (/dev/video19).
  // Try hw first on ARM64 only if the GStreamer element is actually installed.
  // Signal-kills (code=null, from our own kill()) are NOT hw failures — don't disable hw.
  const _hwElemAvail = (process.arch === 'arm64') && (() => {
    try { return cp.spawnSync('gst-inspect-1.0', ['--exists', 'v4l2h265dec'], { timeout: 3000 }).status === 0; }
    catch(_) { return false; }
  })();
  if (process.arch === 'arm64' && !_hwElemAvail)
    console.error('[gst] v4l2h265dec not found — using software decode from start');
  let useHwDec          = _hwElemAvail;
  let ffNoOutputTimer   = null;
  let ffFirstFrameSeen  = false;  // true after first JPEG output from current decoder instance
  // Prime the decoder, then drop excess input to keep latency bounded.
  let ffIdrWritten      = false;
  let ffStartupNalCount = 0;
  const FF_STARTUP_NAL_MAX = 10;
  let ffPendingFrames   = 0;
  const MAX_PENDING_FRAMES = useHwDec ? 3 : 10;

  function resetNoOutputTimer() {
    clearTimeout(ffNoOutputTimer);
    const ms = ffFirstFrameSeen ? (useHwDec ? 3000 : 8000) : 12000;
    ffNoOutputTimer = setTimeout(() => {
      if (ffH265) {
        console.error('[ffmpeg] no JPEG output for ' + (ms / 1000) +
                      's — ' + (ffFirstFrameSeen ? 'decode stall' : 'init timeout') +
                      ', killing (will restart on next IDR)');
        ffH265.kill();
      }
    }, ms);
  }

  const FF_STDIN_MAX = 32 * 1024;

  function buildDecoderArgs() {
    if (useHwDec) {
      return [
        '-q',
        'fdsrc', 'fd=0', 'blocksize=131072',
        '!', 'h265parse',
        '!', 'v4l2h265dec', 'device=/dev/video19',
        '!', 'videoconvert',
        '!', 'jpegenc', 'quality=80',
        '!', 'fdsink', 'fd=1', 'sync=false', 'async=false',
      ];
    } else {
      return [
        '-q',
        'fdsrc', 'fd=0', 'blocksize=131072',
        '!', 'h265parse',
        '!', 'avdec_h265', 'max-threads=2',
        '!', 'videoconvert',
        '!', 'jpegenc', 'quality=80',
        '!', 'fdsink', 'fd=1', 'sync=false', 'async=false',
      ];
    }
  }
  function startFfmpeg() {
    if (ffH265) return;
    ffFirstFrameSeen  = false;
    ffIdrWritten      = false;
    ffStartupNalCount = 0;
    ffPendingFrames   = 0;
    const args = buildDecoderArgs();
    if (useHwDec) {
      console.error('[gst] hardware H265 decode via v4l2h265dec (/dev/video19)');
    } else {
      console.error('[gst] software H265 decode via avdec_h265 (max-threads=2)');
    }

    ffH265 = cp.spawn('gst-launch-1.0', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    resetNoOutputTimer();

    ffH265.stdin.on('error', () => {});
    ffH265.on('error', (e) => {
      console.error('[gst] spawn error: ' + e.message +
                    (e.code === 'ENOENT' ? ' — is gstreamer1.0-tools installed?' : ''));
    });
    ffH265.on('exit', (code, signal) => {
      clearTimeout(ffNoOutputTimer);
      if (signal) {
        console.error('[gst] killed (' + signal + ') — will restart on next IDR');
      } else if (code !== 0 && useHwDec) {
        console.error('[gst] hw decode error (code=' + code +
                      ') — switching to software (avdec_h265)');
        useHwDec = false;
      } else {
        console.error('[gst] exited code=' + code + ' — will restart on next IDR');
      }
      ffH265 = null;
      ffBuf  = Buffer.alloc(0);
      page.evaluate('if (window._requestKeyFrame) window._requestKeyFrame()').catch(() => {});
    });

    ffH265.stdout.on('data', (chunk) => {
      ffBuf = Buffer.concat([ffBuf, chunk]);
      let latestJpeg = null;
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
        if (eoi < 0) {
          if (soi > 0) ffBuf = ffBuf.slice(soi);
          if (ffBuf.length > MAX_JPEG_BUFFER) {
            console.error('[gst] incomplete JPEG buffer exceeded 4 MiB — dropping it');
            ffBuf = Buffer.alloc(0);
          }
          break;
        }
        latestJpeg = ffBuf.slice(soi, eoi + 2);
        ffBuf      = ffBuf.slice(eoi + 2);
      }
      if (!latestJpeg) return;

      if (!ffFirstFrameSeen) {
        ffFirstFrameSeen = true;
        ffPendingFrames = 0;
      } else {
        if (ffPendingFrames > 0) ffPendingFrames--;
      }
      resetNoOutputTimer();

      const now = Date.now();
      if (now - lastSendMs < minIntervalMs) return;
      lastSendMs = now;

      if (pyWsReady && pyWs.readyState === WS.OPEN &&
          pyWs.bufferedAmount < PY_WS_MAX_BUFFERED) {
        pyWs.send(latestJpeg, { binary: true });
        if (firstJpeg) {
          firstJpeg = false;
          console.error('[gst] ✓ first JPEG sent to Python (' +
                        latestJpeg.length + ' B, hw=' + useHwDec + ')');
          // Notify bridge.html for its log/counters (no WS send needed there).
          page.evaluate(() => {
            if (typeof window.__onFirstFrame === 'function') window.__onFirstFrame();
          }).catch(() => {});
        }
      }
    });

    console.error('[gst] decoder started pid=' + ffH265.pid +
                  ' hw=' + useHwDec);
  }

  // ── H265 NAL feeder (called from bridge.html via RTCRtpScriptTransform) ───────
  // isIDR=true  → Annex B chunk contains VPS/SPS/PPS + IDR NAL (from feedH265).
  // isIDR=false → Annex B chunk is a single P/B frame NAL.
  // After ffmpeg exits (kill or error), we only restart on the next IDR so the
  // decoder always begins at a clean random-access point — never mid-GOP.
  await page.exposeFunction('__h265FeedNAL', (b64, isIDR) => {
    if (!ffH265) {
      if (!isIDR) return;   // wait for a clean IDR before (re)starting decoder
      startFfmpeg();
    }
    if (ffH265 && !ffH265.stdin.destroyed) {
      if (!ffFirstFrameSeen) {
        // ── Startup priming: pipeline NULL→PLAYING takes 1-3 s; fdsrc does not
        // read stdin until PLAYING state.  Writing every incoming frame queues
        // 20-30 frames before the decoder starts, putting us permanently behind.
        // Solution: write IDR + FF_STARTUP_NAL_MAX P-frames, then drop the rest
        // until the decoder produces its first JPEG (ffFirstFrameSeen).
        // avdec_h265 needs a few frames after the IDR before it outputs anything
        // (B-frame reordering pipeline) — sending only the IDR causes a 5 s stall.
        if (!ffIdrWritten) {
          if (!isIDR) return;  // no IDR yet — drop P/B frames
          ffIdrWritten = true;
          ffStartupNalCount = 1;  // IDR counts as first NAL
          console.error('[gst] startup IDR sent — priming decoder (max ' +
                        FF_STARTUP_NAL_MAX + ' frames)');
        } else if (ffStartupNalCount >= FF_STARTUP_NAL_MAX) {
          return;  // primed — drop all remaining NALs until first JPEG output
        } else {
          ffStartupNalCount++;
        }
        // fall through to write this NAL
      } else if (ffPendingFrames >= MAX_PENDING_FRAMES) {
        // ── Decoder behind: drop this frame to maintain real-time output.
        // Don't kill — just skip.  When the decoder catches up (outputs a JPEG),
        // ffPendingFrames drops below the limit and normal writing resumes.
        return;
      } else if (ffH265.stdin.writableLength > FF_STDIN_MAX) {
        // ── Last-resort overrun guard (should rarely fire given pending-frame cap).
        console.error('[gst] stdin overrun — killing to reset latency (will restart on next IDR)');
        ffH265.kill();
        return;
      }
      ffPendingFrames++;
      try { ffH265.stdin.write(Buffer.from(b64, 'base64')); } catch (_) {}
    }
  });

  // Simple ack so bridge.html can update its frame counter without WS.
  await page.exposeFunction('__onFirstFrame', () => {});

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
    console.log('[bridge-init] headless media workarounds applied');
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

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise(() => {});
})().catch((err) => {
  console.error('[bridge fatal] ' + (err && err.stack || err));
  process.exit(1);
});
