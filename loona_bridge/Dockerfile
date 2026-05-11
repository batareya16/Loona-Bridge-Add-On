# Debian: Chromium из репозитория часто без H.264 в WebRTC. Дополнительно ставим Google Chrome
# из официального .deb (arm64/amd64), если файл доступен — у run.sh приоритет google-chrome-stable.
#
# Сборка должна идти на Debian-слое (есть apt-get). Если Supervisor подставит только Alpine без apt —
# используйте образ с debian в build.yaml или предсобранный image из реестра.
ARG BUILD_FROM=debian:bookworm-slim
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

# Chrome с проприетарными кодеками (404 / сбой установки → остаётся chromium без H.264 в WebRTC).
RUN apt-get update \
    && ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then \
         wget -q -O /tmp/chrome.deb \
           "https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb" \
           && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb \
           || echo "[loona-bridge build] Chrome arm64 не установлен — проверьте URL/deb"; \
       elif [ "$ARCH" = "amd64" ]; then \
         wget -q -O /tmp/chrome.deb \
           "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
           && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb \
           || echo "[loona-bridge build] Chrome amd64 не установлен"; \
       fi \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

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
