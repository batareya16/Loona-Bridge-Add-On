# Raspberry Pi experiment: use RPi Chromium build + codecs on ARM64.
ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        dumb-init \
        jq \
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

RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl gnupg ca-certificates; \
    \
    if [ "$ARCH" = "arm64" ]; then \
      # 1. СКАЧИВАЕМ КЛЮЧ (правильный путь)
      curl -fsSL https://raspberrypi.org | gpg --dearmor -o /usr/share/keyrings/raspberrypi-archive-keyring.gpg; \
      \
      # 2. ДОБАВЛЯЕМ РЕПОЗИТОРИЙ (обязательно archive... и bookworm)
      echo "deb [signed-by=/usr/share/keyrings/raspberrypi-archive-keyring.gpg] http://raspberrypi.org bookworm main" > /etc/apt/sources.list.d/raspi.list; \
      \
      apt-get update; \
      \
      # 3. УСТАНОВКА (в Bookworm пакет называется просто chromium, но из этого репо он с патчами)
      apt-get install -y --no-install-recommends \
        chromium \
        chromium-common \
        libavcodec-extra \
        libexif12 \
        libgl1-mesa-dri; \
        \
      # Создаем симлинк, чтобы Puppeteer всегда находил путь chromium-browser
      ln -s /usr/bin/chromium /usr/bin/chromium-browser; \
    else \
      apt-get install -y --no-install-recommends chromium; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loona-bridge

COPY bridge/package.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN npm install --omit=dev \
    && npm cache clean --force

COPY bridge/ ./

ENV NODE_ENV=production

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
