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
#    Uses RTCPeerConnection.createOffer() to trigger GMP download (more reliable
#    than about:blank which doesn't request codec support).
#    Falls back gracefully if CDN unreachable — bridge.html waitForH264Codec()
#    handles the runtime fallback.
COPY prewarm.js ./prewarm.js
RUN node prewarm.js && rm prewarm.js

COPY bridge/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
