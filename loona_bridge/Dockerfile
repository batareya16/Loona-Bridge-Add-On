# https://developers.home-assistant.io/docs/add-ons/configuration
# Supervisor often builds add-ons on an Alpine-based BUILD_FROM (/bin/ash) — apt-get is missing there (exit 127).
ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

RUN set -eux; \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache \
        chromium \
        nss \
        freetype \
        harfbuzz \
        ca-certificates \
        ttf-freefont \
        jq \
        dumb-init; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        chromium \
        dumb-init \
        jq \
        ca-certificates \
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
        libxshmfence1; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Neither apk nor apt-get found — unsupported BUILD_FROM"; exit 1; \
    fi

WORKDIR /opt/loona-bridge

COPY bridge/package.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

RUN npm install --omit=dev \
    && npm cache clean --force

COPY bridge/ ./

# Paths differ: Debian /usr/bin/chromium, Alpine often chromium-browser symlink
ENV NODE_ENV=production

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
