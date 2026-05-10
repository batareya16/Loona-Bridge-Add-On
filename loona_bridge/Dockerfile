# Supervisor подставляет свой BUILD_FROM — часто это минимальный Alpine без Node.
# Поэтому Node и npm ставим только через apk, база — чистый alpine (совпадает с ash-сборкой).
ARG BUILD_FROM=alpine:3.21
FROM ${BUILD_FROM}

RUN apk add --no-cache \
    nodejs \
    npm \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    jq \
    dumb-init

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
