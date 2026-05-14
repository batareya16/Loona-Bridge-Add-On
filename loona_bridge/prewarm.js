/**
 * Docker build pre-warm: launch Firefox with a persistent profile and trigger
 * OpenH264 GMP download by calling RTCPeerConnection.createOffer().
 *
 * Why: Firefox downloads the OpenH264 GMP (needed for WebRTC H.264) from
 * Mozilla CDN asynchronously at first use. If we pre-download it here and
 * bake it into the Docker image, H.264 is immediately available at runtime.
 *
 * If CDN is unreachable during build, the bridge falls back to waiting at
 * runtime (waitForH264Codec loop in bridge.html).
 */
const { firefox } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROFILE = process.env.FIREFOX_PROFILE_DIR || '/opt/ff-profile';
const TIMEOUT = 90; // seconds to wait for GMP download

fs.mkdirSync(PROFILE, { recursive: true });

(async () => {
  console.log('[prewarm] Profile dir: ' + PROFILE);
  console.log('[prewarm] Launching Firefox to trigger OpenH264 GMP download...');

  const ctx = await firefox.launchPersistentContext(PROFILE, {
    headless: true,
    firefoxUserPrefs: {
      'media.gmp-gmpopenh264.enabled':    true,
      'media.gmp-gmpopenh264.autoupdate': true,
      'app.update.enabled':               false,
      'toolkit.telemetry.enabled':        false,
      'datareporting.healthreport.service.enabled': false,
    },
  });

  const page = await ctx.newPage();
  await page.goto('about:blank');

  // Trigger OpenH264 GMP download by calling createOffer() — this causes
  // Firefox to request H.264 codec support and download OpenH264 if missing.
  console.log('[prewarm] Triggering WebRTC codec check (createOffer)...');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const hasH264 = await page.evaluate(async () => {
        const pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        pc.close();
        return /H264|h264/i.test(offer.sdp);
      });
      if (hasH264) {
        console.log('[prewarm] H.264 already available — GMP present from previous run or bundled');
        await ctx.close();
        process.exit(0);
      }
      console.log('[prewarm] H.264 not in offer yet — GMP downloading... (attempt ' + (attempt+1) + ')');
    } catch (e) {
      console.log('[prewarm] createOffer attempt ' + (attempt+1) + ' error: ' + e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Poll for GMP directory to appear in the profile
  console.log('[prewarm] Waiting up to ' + TIMEOUT + 's for OpenH264 GMP to download...');
  const gmpDir = path.join(PROFILE, 'gmp-gmpopenh264');
  let found = false;
  for (let i = 0; i < TIMEOUT; i++) {
    await new Promise(r => setTimeout(r, 1000));

    // Re-check if H.264 is now in an offer
    try {
      const hasH264 = await page.evaluate(async () => {
        const pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        pc.close();
        return /H264|h264/i.test(offer.sdp);
      });
      if (hasH264) {
        console.log('[prewarm] ✓ H.264 codec available after ' + (i+1) + 's');
        found = true;
        break;
      }
    } catch (e) {}

    if (fs.existsSync(gmpDir)) {
      const vers = fs.readdirSync(gmpDir).filter(f => fs.statSync(path.join(gmpDir, f)).isDirectory());
      if (vers.length > 0) {
        console.log('[prewarm] ✓ OpenH264 GMP directory found: ' + gmpDir + '/' + vers[0]);
        found = true;
        break;
      }
    }

    if (i % 10 === 9) {
      console.log('[prewarm] still waiting... ' + (i+1) + 's elapsed');
    }
  }

  await ctx.close();

  if (found) {
    console.log('[prewarm] SUCCESS — OpenH264 baked into Docker image');
    process.exit(0);
  } else {
    console.log('[prewarm] GMP not downloaded in ' + TIMEOUT + 's — will download at first runtime');
    console.log('[prewarm] (this is OK — bridge.html waitForH264Codec() will wait at startup)');
    process.exit(0); // Not a fatal error
  }
})().catch(e => {
  console.error('[prewarm] Fatal error: ' + e.message);
  process.exit(0); // Don't fail the Docker build
});
