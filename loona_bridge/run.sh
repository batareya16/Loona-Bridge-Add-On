#!/bin/bash
set -euo pipefail

OPTIONS_FILE="${OPTIONS_FILE:-/data/options.json}"
CONFIG_JSON="/ha_config/.loona/bridge-config.json"

# resolve_ha_host: determine HA Core WebSocket address.
# Called AFTER wait_for_ha_config so bridge-config.json exists and contains
# the ws_host written by bridge_mgr.py (HA Core's actual container IP).
#
# Priority:
#   1. $HA_WS_HOST env var (explicit override — useful for development)
#   2. ws_host from bridge-config.json IF it is a container IP (172.30.x.x)
#      bridge_mgr.py discovers this via a UDP connect trick from inside Core.
#      With host_network=true the bridge gateway 172.30.32.1 is the Pi's own
#      interface — nothing listens there.  The container IP (e.g. .2) is the
#      one reachable from the host network namespace.
#   3. getent hosts homeassistant  (correct inside Docker, may give .1 on host)
#   4. python3 socket.gethostbyname
#   5. literal "homeassistant" (last-resort, let Firefox DNS try)
resolve_ha_host() {
  local h
  h="${HA_WS_HOST:-}"
  if [[ -z "$h" && -f "$CONFIG_JSON" ]]; then
    local cfg_host
    cfg_host="$(jq -r '.ws_host // ""' "$CONFIG_JSON" 2>/dev/null)"
    if [[ "$cfg_host" =~ ^172\.30\. ]]; then
      h="$cfg_host"
    fi
  fi
  if [[ -z "$h" ]]; then
    h=$(getent hosts homeassistant 2>/dev/null | awk 'NR==1{print $1}')
  fi
  if [[ -z "$h" ]]; then
    h=$(python3 -c "import socket; print(socket.gethostbyname('homeassistant'))" 2>/dev/null || true)
  fi
  [[ -z "$h" ]] && h="homeassistant"
  echo "$h"
}

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

  # Resolve HA host AFTER config is available so we can read ws_host from it.
  RESOLVED_HOST="$(resolve_ha_host)"
  log "HA WS host resolved: $RESOLVED_HOST"

  IFS='|' read -r FPS JPEG < <(read_options)

  export LOONA_BRIDGE_CONFIG="$(
    jq -c --arg host "$RESOLVED_HOST" --arg fps "$FPS" --arg jpeg "$JPEG" \
      '.ws_host = $host
       | .fps = ($fps | tonumber)
       | .jpeg_quality = ($jpeg | tonumber)' \
      "$CONFIG_JSON"
  )"

  log "starting node bridge.js (ws_host=$RESOLVED_HOST) ..."
  set +e
  node /opt/loona-bridge/bridge.js
  code=$?
  set -e
  log "bridge.js exited code=$code — waiting for camera switch ON ..."
done
