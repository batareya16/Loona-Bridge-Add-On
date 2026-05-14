# Playwright Firefox bridge for Loona camera.
# Firefox decodes H.264 WebRTC via OpenH264 GMP (Cisco) on ARM64 and amd64.
# OpenH264 is downloaded from Mozilla CDN on first run and cached in /opt/ff-profile.
# The build pre-warms the profile so OpenH264 is baked into the image.
ARG BUILD_FROM
FROM ${BUILD_FROM}

# Base tools only — Playwright installs Firefox system deps via --with-deps.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        dumb-init \
        jq \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loona-bridge

COPY bridge/package.json ./

# PLAYWRIGHT_BROWSERS_PATH: where Playwright stores downloaded Firefox binary.
# FIREFOX_PROFILE_DIR: persistent profile — preserves OpenH264 GMP between restarts.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    FIREFOX_PROFILE_DIR=/opt/ff-profile \
    NODE_ENV=production

# 1) Install npm deps.
# 2) Download Firefox binary + all its system deps.
RUN npm install --omit=dev \
    && DEBIAN_FRONTEND=noninteractive npx playwright install firefox --with-deps \
    && npm cache clean --force

# 3) Pre-warm Firefox profile: trigger OpenH264 GMP download from Mozilla CDN.
#    Firefox downloads ~1 MB and saves it to /opt/ff-profile/gmp-gmpopenh264/.
#    This bakes the GMP into the image so H.264 works immediately at runtime
#    without an internet request. Falls back gracefully if CDN unreachable.
RUN node - <<'EOF'
const { firefox } = require('playwright');
const fs = require('fs');
const PROFILE = '/opt/ff-profile';
fs.mkdirSync(PROFILE, { recursive: true });
(async () => {
  console.log('[prewarm] launching Firefox to download OpenH264 GMP...');
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
  // Wait up to 30 s for GMP download (it is async in Firefox's background).
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const gmpDir = PROFILE + '/gmp-gmpopenh264';
    if (fs.existsSync(gmpDir)) {
      const vers = fs.readdirSync(gmpDir);
      if (vers.length > 0) {
        console.log('[prewarm] OpenH264 GMP downloaded: ' + gmpDir + '/' + vers[0]);
        break;
      }
    }
    if (i % 5 === 4) console.log('[prewarm] waiting for GMP... (' + (i+1) + 's)');
  }
  await ctx.close();
  const gmpDir = PROFILE + '/gmp-gmpopenh264';
  if (fs.existsSync(gmpDir)) {
    console.log('[prewarm] SUCCESS — OpenH264 baked into image');
  } else {
    console.log('[prewarm] GMP not found — will download at first runtime (H.264 may fail until then)');
  }
})().catch(e => {
  console.error('[prewarm] error: ' + e.message + ' — continuing without pre-warm');
});
EOF

COPY bridge/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
