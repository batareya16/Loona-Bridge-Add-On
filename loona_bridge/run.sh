#!/bin/bash
set -euo pipefail

OPTIONS_FILE="${OPTIONS_FILE:-/data/options.json}"
CONFIG_JSON="/ha_config/.loona/bridge-config.json"
HA_WS_HOST="${HA_WS_HOST:-homeassistant}"

log() {
  echo "[loona-bridge] $*"
}

read_options() {
  local fps jpeg chrome_opt
  fps="10"
  jpeg="0.65"
  chrome_opt=""
  if [[ -f "$OPTIONS_FILE" ]]; then
    fps="$(jq -r '.fps // 10' "$OPTIONS_FILE")"
    jpeg="$(jq -r '.jpeg_quality // 0.65' "$OPTIONS_FILE")"
    chrome_opt="$(jq -r '.chrome_path // "" | select(length > 0)' "$OPTIONS_FILE")"
  fi
  echo "$fps|$jpeg|$chrome_opt"
}

pick_chrome() {
  local custom="$1"
  if [[ -n "$custom" && -x "$custom" ]]; then
    echo "$custom"
    return 0
  fi
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome \
           /usr/bin/chromium /usr/bin/chromium-browser; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

wait_for_ha_config() {
  while true; do
    if [[ -f "$CONFIG_JSON" ]]; then
      if jq -e '.ws_port != null and (.ws_port | tonumber) > 0' "$CONFIG_JSON" >/dev/null 2>&1; then
        return 0
      fi
    fi
    log "waiting for $CONFIG_JSON (Loona camera switch — BridgeManager must write ws_port) ..."
    sleep 3
  done
}

IFS='|' read -r FPS JPEG CHROME_OPT < <(read_options)

if ! CHROME_BIN="$(pick_chrome "$CHROME_OPT")"; then
  log "ERROR: no executable browser found. Install Chrome/Chromium or set chrome_path in add-on options."
  exit 1
fi

log "browser: $CHROME_BIN"
log "defaults from options: fps=$FPS jpeg_quality=$JPEG"

export CHROME_PATH="$CHROME_BIN"
export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"

wait_for_ha_config

while true; do
  if [[ ! -f "$CONFIG_JSON" ]]; then
    log "config disappeared — waiting ..."
    wait_for_ha_config
  fi

  IFS='|' read -r FPS JPEG CHROME_OPT < <(read_options)
  if CHROME_BIN="$(pick_chrome "$CHROME_OPT")"; then
    export CHROME_PATH="$CHROME_BIN"
    export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"
  fi

  export LOONA_BRIDGE_CONFIG="$(
    jq -c --arg host "$HA_WS_HOST" --arg fps "$FPS" --arg jpeg "$JPEG" \
      '.ws_host = $host
       | .fps = ($fps | tonumber)
       | .jpeg_quality = ($jpeg | tonumber)' \
      "$CONFIG_JSON"
  )"

  log "starting node bridge.js (ws_host=$HA_WS_HOST) ..."
  set +e
  node /opt/loona-bridge/bridge.js
  code=$?
  set -e
  log "bridge.js exited code=$code — retry in 5s"
  sleep 5
done
