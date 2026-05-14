#!/usr/bin/env node
/**
 * Docker build pre-warm: ensure OpenH264 GMP is registered in the Firefox profile
 * before the image is committed.
 *
 * TWO-PHASE STRATEGY
 * ──────────────────
 * Phase 1 — Let Firefox do it itself (preferred):
 *   Launch Firefox via Playwright with media.gmp-manager.updateEnabled=true.
 *   Firefox downloads OpenH264 (~1 MB) from Mozilla CDN and registers it in
 *   prefs.js automatically.  Poll RTCPeerConnection.createOffer() until H264
 *   appears in the SDP, then close.  Profile at FIREFOX_PROFILE_DIR is baked
 *   into the image layer.
 *
 *   WHY http://127.0.0.1 NOT about:blank:
 *   Firefox exposes RTCPeerConnection only in "secure contexts".  localhost is
 *   treated as potentially trustworthy even over plain HTTP per the W3C spec;
 *   about:blank (null origin) is NOT — RTCPeerConnection constructor throws.
 *
 * Phase 2 — Manual install (fallback if Phase 1 times out / CDN blocked):
 *   Download the .so from Cisco's CDN directly in Node.js, extract with Python
 *   (stdlib bz2/zipfile), create gmpopenh264.info, write the GMP version info to
 *   /opt/loona-bridge/gmp-version.json.  bridge.js reads that file at startup and
 *   injects media.gmp-gmpopenh264.version + .abi into firefoxUserPrefs so Firefox
 *   finds the manually placed plugin even though Playwright rewrites user.js on
 *   each launch.
 *
 * NEVER fails the build (always exits 0).
 */

'use strict';
const { firefox } = require('playwright');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const cp    = require('child_process');

const PROFILE_DIR  = process.env.FIREFOX_PROFILE_DIR        || '/opt/ff-profile';
const PW_PATH      = process.env.PLAYWRIGHT_BROWSERS_PATH   || '/opt/pw-browsers';
const GMP_INFO_OUT = '/opt/loona-bridge/gmp-version.json';
const TIMEOUT_MS   = 120 * 1000;

function log(msg) { console.log('[prewarm] ' + msg); }

function clearLocks(dir) {
  for (const f of ['lock', 'parent.lock', '.parentlock']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
}

// ── HTTP server — provides a "localhost" secure context for RTCPeerConnection ──
function startHttpServer() {
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>prewarm</title></head><body></body></html>';
  const srv  = http.createServer((_q, r) => { r.writeHead(200, {'Content-Type':'text/html'}); r.end(html); });
  return new Promise((res, rej) => {
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
    srv.on('error', rej);
  });
}

// ── Phase 1: Firefox auto-download ───────────────────────────────────────────
async function phase1() {
  log('=== Phase 1: Firefox GMP auto-download ===');
  log('FIREFOX_PROFILE_DIR: ' + PROFILE_DIR);

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  clearLocks(PROFILE_DIR);

  const { srv, port } = await startHttpServer();
  const pollUrl = 'http://127.0.0.1:' + port + '/';
  log('Poll URL: ' + pollUrl);

  let context;
  try {
    context = await firefox.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      firefoxUserPrefs: {
        'media.gmp-manager.updateEnabled':            true,
        'media.gmp-gmpopenh264.enabled':              true,
        'media.gmp-gmpopenh264.autoupdate':           true,
        'media.autoplay.default':                     0,
        'media.navigator.permission.disabled':        true,
        'media.navigator.streams.fake':               false,
        'app.update.enabled':                         false,
        'toolkit.telemetry.enabled':                  false,
        'datareporting.healthreport.service.enabled': false,
      },
    });
  } catch (e) {
    log('Firefox launch failed: ' + e.message);
    srv.close();
    return false;
  }

  let page;
  try {
    page = await context.newPage();
    await page.goto(pollUrl, { waitUntil: 'load' });
    srv.close();
    log('Poll page loaded. Waiting for GMP download (up to 120 s)...');
  } catch (e) {
    log('Page navigation failed: ' + e.message);
    srv.close();
    try { await context.close(); } catch (_) {}
    return false;
  }

  const start = Date.now();
  let found = false;

  while (Date.now() - start < TIMEOUT_MS) {
    const elapsed = Math.round((Date.now() - start) / 1000);

    const hasH264 = await page.evaluate(async () => {
      try {
        const pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        pc.close();
        return /H264|h264/i.test(offer.sdp);
      } catch (_) { return false; }
    }).catch(() => false);

    if (hasH264) {
      log('✓ OpenH264 GMP ready after ' + elapsed + 's (Firefox registered it automatically)');
      found = true;
      break;
    }

    log('  still waiting... ' + elapsed + 's');
    await new Promise(r => setTimeout(r, 3000));
  }

  try { await context.close(); } catch (_) {}

  if (!found) {
    log('Phase 1 timed out — Firefox GMP manager could not reach Mozilla CDN.');
  }
  return found;
}

// ── Phase 2: manual download from Cisco CDN ──────────────────────────────────

/** Download URL → Buffer using Node.js https (follows redirects). */
function download(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (prewarm/loona-bridge)' },
      timeout: timeoutMs || 90000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Use Python stdlib (bz2 + zipfile) to decompress downloaded data → .so file. */
function extractGmp(dataPath, outDir) {
  const script = `
import bz2, zipfile, io, os, sys
with open(sys.argv[1],'rb') as f: data = f.read()
os.makedirs(sys.argv[2], exist_ok=True)
try:
    with zipfile.ZipFile(io.BytesIO(data)) as z: z.extractall(sys.argv[2])
    print('ZIP extracted')
except zipfile.BadZipFile:
    so = bz2.decompress(data)
    with open(os.path.join(sys.argv[2],'libgmpopenh264.so'),'wb') as f: f.write(so)
    print('bz2 extracted, ' + str(len(so)) + ' bytes')
`.trim();
  const tmpPy = path.join(os.tmpdir(), 'loona_gmp_extract.py');
  fs.writeFileSync(tmpPy, script);
  try {
    const out = cp.execSync('python3 ' + tmpPy + ' ' + dataPath + ' ' + outDir, { timeout: 30000 }).toString();
    log('  extract: ' + out.trim());
  } finally {
    try { fs.unlinkSync(tmpPy); } catch (_) {}
  }
}

async function phase2() {
  log('=== Phase 2: manual GMP install from Cisco CDN ===');

  const arch = os.arch(); // 'arm64' or 'x64'
  const gmpAbi = (arch === 'arm64') ? 'aarch64-gcc3' : 'x86_64-gcc3';

  // Try to discover exact version + URL via Mozilla's GMP update server.
  // Falls back to hardcoded Cisco CDN URL for OpenH264 2.3.1 if unreachable.
  let gmpUrl, gmpVersion;

  try {
    // Read Firefox version info for the update server query.
    const ffDirs = fs.readdirSync(PW_PATH)
      .filter(d => d.startsWith('firefox-'))
      .map(d => path.join(PW_PATH, d, 'firefox'))
      .filter(d => fs.existsSync(path.join(d, 'application.ini')));

    if (ffDirs.length === 0) throw new Error('Firefox not found in ' + PW_PATH);
    const ffDir  = ffDirs.sort().pop();
    const ini    = fs.readFileSync(path.join(ffDir, 'application.ini'), 'utf8');
    const ffVer  = (ini.match(/^Version=(.+)$/m) || [])[1].trim();
    const buildId = (ini.match(/^BuildID=(.+)$/m) || [])[1].trim();
    const gmpPlatform = (arch === 'arm64') ? 'Linux_aarch64-gcc3' : 'Linux_x86_64-gcc3';

    log('Firefox ' + ffVer + ' BuildID=' + buildId + ' platform=' + gmpPlatform);

    const updateUrl = 'https://aus5.mozilla.org/update/3/GMP/' + ffVer + '/' + buildId +
      '/' + gmpPlatform + '/en-US/release/default/default/update.xml';
    log('Querying Mozilla update server: ' + updateUrl);

    const xml = (await download(updateUrl, 20000)).toString('utf8');
    const block = (xml.match(/id="gmp-gmpopenh264"([\s\S]*?)(?=<addon|<\/addons>)/) || [])[0] || '';
    const u = (block.match(/URL="([^"]+)"/) || [])[1];
    const v = (block.match(/version="([^"]+)"/) || [])[1];

    if (u && v) {
      gmpUrl = u;
      gmpVersion = v;
      log('Mozilla CDN URL: ' + gmpUrl + ' (v' + gmpVersion + ')');
    } else {
      throw new Error('URL not found in update XML');
    }
  } catch (e) {
    log('Mozilla update server unavailable (' + e.message + ') — using hardcoded Cisco CDN fallback');
    gmpVersion = '2.3.1';
    gmpUrl = (arch === 'arm64')
      ? 'https://ciscobinary.openh264.org/openh264-2.3.1-linux64-arm64.zip'
      : 'https://ciscobinary.openh264.org/openh264-2.3.1-linux64.zip';
    log('Cisco CDN URL: ' + gmpUrl);
  }

  // Download.
  log('Downloading OpenH264 ' + gmpVersion + '...');
  let data;
  try {
    data = await download(gmpUrl, 90000);
    log('Downloaded ' + data.length.toLocaleString() + ' bytes');
  } catch (e) {
    log('ERROR: Download failed: ' + e.message);
    log('Phase 2 failed — H264 will not be available at first runtime.');
    return false;
  }

  // Save to temp file, extract with Python.
  const tmpData = path.join(os.tmpdir(), 'loona_gmp.download');
  const gmpDir  = path.join(PROFILE_DIR, 'gmp-gmpopenh264', gmpVersion);
  fs.writeFileSync(tmpData, data);
  try {
    extractGmp(tmpData, gmpDir);
  } catch (e) {
    log('ERROR: Extraction failed: ' + e.message);
    return false;
  } finally {
    try { fs.unlinkSync(tmpData); } catch (_) {}
  }

  // Verify .so was extracted.
  const files = fs.existsSync(gmpDir) ? fs.readdirSync(gmpDir) : [];
  const hasSo = files.some(f => f.endsWith('.so'));
  if (!hasSo) {
    log('ERROR: libgmpopenh264.so not found in ' + gmpDir + ' after extraction. Files: ' + files.join(', '));
    return false;
  }

  // Create gmpopenh264.info if not in the archive (some bz2 builds omit it).
  const infoPath = path.join(gmpDir, 'gmpopenh264.info');
  if (!fs.existsSync(infoPath)) {
    fs.writeFileSync(infoPath,
      'Name=gmpopenh264\n' +
      'Description=OpenH264 Video Codec provided by Cisco Systems, Inc.\n' +
      'Version=' + gmpVersion + '\n' +
      'Vendor=Cisco Systems, Inc.\n' +
      'ABI=' + gmpAbi + '\n');
    log('  created gmpopenh264.info');
  }

  log('GMP files: ' + fs.readdirSync(gmpDir).join(', '));

  // Write gmp-version.json for bridge.js to read at runtime.
  // bridge.js injects version+abi into firefoxUserPrefs so Firefox finds the plugin
  // even though Playwright rewrites user.js on every launch (erasing prefs.js GMP prefs
  // that Phase 1 would have registered).
  const info = { version: gmpVersion, abi: gmpAbi };
  fs.writeFileSync(GMP_INFO_OUT, JSON.stringify(info, null, 2));
  log('Saved gmp-version.json: ' + JSON.stringify(info));

  log('✓ Manual GMP install complete (v' + gmpVersion + ' ' + gmpAbi + ')');
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const ok = await phase1();
    if (!ok) {
      await phase2();
    }
  } catch (e) {
    log('Unexpected error: ' + (e && e.stack || e));
  }

  // Final diagnostic
  const gmpExists = fs.existsSync(path.join(PROFILE_DIR, 'gmp-gmpopenh264'));
  const infoExists = fs.existsSync(GMP_INFO_OUT);
  log('─────────────────────────────────────');
  log('Profile GMP dir exists: ' + (gmpExists  ? 'YES ✓' : 'NO'));
  log('gmp-version.json exists: ' + (infoExists ? 'YES ✓' : 'NO (Phase 1 only)'));
  if (gmpExists || infoExists) {
    log('H264 WILL BE AVAILABLE at container start.');
  } else {
    log('WARNING: Neither phase succeeded. H264 will try to download at runtime.');
  }
  log('Done.');
  process.exit(0);
})();
