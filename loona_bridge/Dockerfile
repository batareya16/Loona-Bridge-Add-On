# Playwright Firefox bridge for Loona camera.
# Firefox 130 (Playwright 1.47.0) decodes H.265/HEVC WebRTC via GStreamer avdec_h265
# (software decode, installed by playwright --with-deps via gstreamer1.0-libav).
# media.peerconnection.video.h265_enabled=true unlocks H265 in Firefox WebRTC.
# OpenH264 GMP for H264 fallback is pre-warmed but non-fatal if CDN unreachable.
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
        gstreamer1.0-libav \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-good \
        gstreamer1.0-tools \
        ffmpeg \
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

# 3) Pre-warm Firefox profile: launch Firefox, wait for OpenH264 GMP to download
#    and register itself in the profile.  The profile with registered GMP is then
#    baked into the image layer so H.264 is available at container start without
#    any CDN request.
#    Falls back gracefully if CDN unreachable — bridge.html waitForH264Codec()
#    handles the runtime fallback.
COPY prewarm.js ./prewarm.js
RUN node prewarm.js && rm prewarm.js

# Verify prewarm result — WARNING only (not fatal).
# Primary codec is now H265 via GStreamer (no GMP needed).
# H264 via OpenH264 GMP is a useful fallback but not required.
RUN echo "=== GMP prewarm verification ===" \
    && (ls /opt/ff-profile/gmp-gmpopenh264/ 2>/dev/null && echo "Phase 1 OK: Firefox auto-downloaded GMP ✓") \
    || (ls /opt/loona-bridge/gmp-version.json 2>/dev/null && echo "Phase 2 OK: manual GMP install ✓") \
    || echo "WARNING: OpenH264 GMP not installed — H264 fallback unavailable (H265 via GStreamer will be used)" \
    && echo "=== GMP check done ==="

COPY bridge/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
