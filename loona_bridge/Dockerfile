# Debian experiment: test Chromium + chromium-codecs-ffmpeg-extra on ARM64.
# This is a targeted attempt to improve H.264 decode without Chrome/Brave packaging.
ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        dumb-init \
        jq \
        chromium \
        nodejs \
        npm \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Required for this experiment: fail with explicit message if repo/arch has no codec package.
RUN set -eux; \
    apt-get update; \
    if ! apt-cache show chromium-codecs-ffmpeg-extra >/dev/null 2>&1; then \
      echo "[loona-bridge build] FATAL: package chromium-codecs-ffmpeg-extra is not available for this base image/architecture."; \
      echo "[loona-bridge build] FATAL: cannot run Debian ffmpeg-extra H.264 experiment."; \
      exit 42; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium-codecs-ffmpeg-extra; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loona-bridge

COPY bridge/package.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

RUN npm install --omit=dev \
    && npm cache clean --force

COPY bridge/ ./

ENV NODE_ENV=production

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
