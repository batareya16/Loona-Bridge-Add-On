# arm64: RPi Chromium + chromium-codecs-ffmpeg-extra (SOFTWARE H.264 via FFmpeg).
#        Debian Bookworm chromium has NO H.264 (stub libffmpeg.so, no -extra pkg).
#        RPi repo provides chromium-codecs-ffmpeg-extra with proprietary codecs.
# amd64: Google Chrome (H.264 built-in).
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
    if [ "$ARCH" = "arm64" ]; then \
      # Raspberry Pi archive — provides chromium + chromium-codecs-ffmpeg-extra
      # (software H.264 via FFmpeg, no Pi hardware needed, works in Docker).
      curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/raspberrypi-archive-keyring.gpg; \
      echo "deb [signed-by=/usr/share/keyrings/raspberrypi-archive-keyring.gpg] \
        https://archive.raspberrypi.com/debian/ bookworm main" \
        > /etc/apt/sources.list.d/raspi.list; \
      apt-get update; \
      # chromium-codecs-ffmpeg-extra provides libffmpeg.so WITH H.264/AAC.
      # Without it Chromium has a stub libffmpeg.so → framesReceived=0 forever.
      apt-get install -y --no-install-recommends \
        chromium \
        chromium-codecs-ffmpeg-extra; \
      rm /etc/apt/sources.list.d/raspi.list; \
    else \
      # amd64: Google Chrome has H.264 built-in.
      curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        -o /tmp/chrome.deb; \
      dpkg -i /tmp/chrome.deb || apt-get install -f -y; \
      rm /tmp/chrome.deb; \
      ln -sf /usr/bin/google-chrome /usr/bin/chromium; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loona-bridge

COPY bridge/package.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

RUN npm install --omit=dev \
    && npm cache clean --force

COPY bridge/ ./

ENV NODE_ENV=production

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/run.sh"]
