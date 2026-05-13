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

pick_browser() {
  local custom="$1"
  if [[ -n "$custom" ]]; then
    if [[ -x "$custom" ]]; then
      echo "$custom"
      return 0
    fi
    log "ERROR: chrome_path is set but not executable: $custom"
    return 1
  fi
  # RPi experiment: prefer chromium-browser from Raspberry Pi repo, then chromium.
  for c in /usr/bin/chromium-browser /usr/bin/chromium; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  log "ERROR: Chromium binary not found. Set chrome_path in add-on options."
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

# ── Runtime diagnostics (visible in HA add-on log) ───────────────────────────
log "=== CHROMIUM DIAGNOSTIC ==="
log "arch: $(dpkg --print-architecture 2>/dev/null || uname -m)"
log "chromium packages: $(dpkg -l 2>/dev/null | grep chromium | awk '{print $2" "$3}' | tr '\n' ' ')"
log "chromium binary: $(ls -la /usr/bin/chromium* 2>/dev/null | tr '\n' ' ')"
CHROMIUM_REAL="$(readlink -f /usr/bin/chromium 2>/dev/null || echo 'not found')"
log "chromium real path: $CHROMIUM_REAL"
CHROMIUM_DIR="$(dirname "$CHROMIUM_REAL" 2>/dev/null)"
log "libffmpeg.so search: $(find /usr/lib /usr/local/lib -name libffmpeg.so 2>/dev/null | tr '\n' ' ' || echo 'none found')"
log "libffmpeg in chromium dir: $(ls -la "$CHROMIUM_DIR/libffmpeg.so" 2>/dev/null || echo 'NOT FOUND')"
log "=== END DIAGNOSTIC ==="
# ─────────────────────────────────────────────────────────────────────────────

IFS='|' read -r FPS JPEG CHROME_OPT < <(read_options)

if ! CHROME_BIN="$(pick_browser "$CHROME_OPT")"; then
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
  if CHROME_BIN="$(pick_browser "$CHROME_OPT")"; then
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
