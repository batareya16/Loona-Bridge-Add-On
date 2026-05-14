#!/bin/bash
set -euo pipefail

OPTIONS_FILE="${OPTIONS_FILE:-/data/options.json}"
CONFIG_JSON="/ha_config/.loona/bridge-config.json"
HA_WS_HOST="${HA_WS_HOST:-homeassistant}"

log() {
  echo "[loona-bridge] $*"
}

read_options() {
  local fps jpeg
  fps="10"
  jpeg="0.65"
  if [[ -f "$OPTIONS_FILE" ]]; then
    fps="$(jq -r '.fps // 10' "$OPTIONS_FILE")"
    jpeg="$(jq -r '.jpeg_quality // 0.65' "$OPTIONS_FILE")"
  fi
  echo "$fps|$jpeg"
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

# Show which Firefox Playwright will use.
log "=== PLAYWRIGHT DIAGNOSTIC ==="
log "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-not set}"
FF_BIN="$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" -name firefox -type f 2>/dev/null | head -1 || echo 'not found')"
log "Firefox binary: $FF_BIN"
if [[ -f "$FF_BIN" ]]; then
  log "Firefox version: $("$FF_BIN" --version 2>/dev/null || echo 'unknown')"
fi
log "=== END DIAGNOSTIC ==="

log "defaults from options: $(read_options)"

while true; do
  # Always wait for a valid (ws_port > 0) config before starting bridge.js.
  # This handles both the initial start AND restarts after _teardown() sets ws_port=0.
  wait_for_ha_config

  if [[ ! -f "$CONFIG_JSON" ]]; then
    log "config disappeared after wait — retrying ..."
    sleep 1
    continue
  fi

  IFS='|' read -r FPS JPEG < <(read_options)

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
  log "bridge.js exited code=$code — waiting for camera switch ON ..."
done
