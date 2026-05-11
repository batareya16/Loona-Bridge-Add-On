# Debian: Chromium из репозитория часто без H.264 в WebRTC. Дополнительно ставим Google Chrome
# из официального .deb (arm64/amd64), если файл доступен — у run.sh приоритет google-chrome-stable.
#
# Сборка должна идти на Debian-слое (есть apt-get). Если Supervisor подставит только Alpine без apt —
# используйте образ с debian в build.yaml или предсобранный image из реестра.
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

# Try installing Brave browser (Chromium-based) for H.264 test.
# If repo/package is unavailable on current arch, keep image buildable and fall back to other browsers.
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
      -o /etc/apt/keyrings/brave-browser-archive-keyring.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/brave-browser-archive-keyring.gpg arch=${ARCH}] https://brave-browser-apt-release.s3.brave.com/ stable main" \
      > /etc/apt/sources.list.d/brave-browser-release.list; \
    apt-get update; \
    if DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends brave-browser; then \
      brave-browser --version || true; \
    else \
      echo "[loona-bridge build] brave-browser package is unavailable for arch=${ARCH}; continuing without it"; \
    fi; \
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
