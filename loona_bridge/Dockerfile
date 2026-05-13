# Playwright Firefox bridge for Loona camera.
# Firefox decodes H.264 WebRTC via its built-in libavcodec — works on ARM64/amd64
# without any proprietary codec packages.
# chromium-codecs-ffmpeg-extra approach abandoned: RPi package stuck at v126
# while system Chromium is v147 (ABI incompatible → WebRTC H.264 never registers).
ARG BUILD_FROM
FROM ${BUILD_FROM}

# Base tools only — Playwright installs its own Firefox system deps via --with-deps.
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
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    NODE_ENV=production

# 1) Install npm deps (playwright + Agora SDKs).
# 2) Download Firefox binary AND install all its system deps via --with-deps.
#    --with-deps runs apt-get install for all Firefox runtime libraries automatically.
RUN npm install --omit=dev \
    && DEBIAN_FRONTEND=noninteractive npx playwright install firefox --with-deps \
    && npm cache clean --force

COPY bridge/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
