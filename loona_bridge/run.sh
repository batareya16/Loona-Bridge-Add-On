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
#   2. ws_host from bridge-config.json. bridge_mgr.py provides either Core's
#      hassio-network IP or 127.0.0.1 when Core shares the host namespace.
#      The Docker gateway 172.30.x.1 is never usable for this WebSocket.
#   3. getent hosts homeassistant  (correct inside Docker, may give .1 on host)
#   4. python3 socket.gethostbyname
#   5. literal "homeassistant" (last-resort, let Firefox DNS try)
is_usable_config_host() {
  local h="$1"
  # The add-on has host_network=true. When HA Core is host-networked too,
  # 127.0.0.1 is the correct shared loopback address. The only known bad
  # address is the hassio Docker gateway (.1), where Core does not listen.
  [[ -n "$h" && ! "$h" =~ ^172\.30\..*\.1$ ]]
}

is_usable_discovered_host() {
  local h="$1"
  # DNS from a host-network add-on commonly resolves "homeassistant" to the
  # Docker gateway. Do not use it when Core did not give us an explicit host.
  [[ -n "$h" && "$h" != "127.0.0.1" && ! "$h" =~ ^172\.30\..*\.1$ ]]
}

resolve_ha_host() {
  local h cfg_host candidate
  h="${HA_WS_HOST:-}"
  # An explicit override is intentionally trusted: it may name a non-Docker
  # endpoint used by advanced installations.
  if [[ -n "$h" ]]; then
    echo "$h"
    return 0
  fi
  if [[ -z "$h" && -f "$CONFIG_JSON" ]]; then
    cfg_host="$(jq -r '.ws_host // ""' "$CONFIG_JSON" 2>/dev/null)"
    # 172.30.x.1 is the Docker gateway, not the HA Core container.
    if is_usable_config_host "$cfg_host"; then
      h="$cfg_host"
    fi
  fi
  if [[ -z "$h" ]]; then
    candidate=$(getent hosts homeassistant 2>/dev/null | awk 'NR==1{print $1}')
    if is_usable_discovered_host "$candidate"; then
      h="$candidate"
    fi
  fi
  if [[ -z "$h" ]]; then
    candidate=$(python3 -c "import socket; print(socket.gethostbyname('homeassistant'))" 2>/dev/null || true)
    if is_usable_discovered_host "$candidate"; then
      h="$candidate"
    fi
  fi
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

config_signature() {
  [[ -f "$CONFIG_JSON" ]] || return 0
  jq -r '[.ws_port // 0, .channel // "", .token // ""] | @tsv' "$CONFIG_JSON" 2>/dev/null
}

wait_for_ha_config() {
  local previous_signature="${1:-}" signature
  while true; do
    if [[ -f "$CONFIG_JSON" ]]; then
      if jq -e '.ws_port != null and (.ws_port | tonumber) > 0' "$CONFIG_JSON" >/dev/null 2>&1; then
        signature="$(config_signature)"
        if [[ -z "$previous_signature" || "$signature" != "$previous_signature" ]]; then
          BRIDGE_CONFIG_SIGNATURE="$signature"
          return 0
        fi
      fi
    fi
    log "waiting for a new Loona camera session in $CONFIG_JSON ..."
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

last_config_signature=""
while true; do
  # Always wait for a valid (ws_port > 0) config before starting bridge.js.
  # This handles both the initial start AND restarts after _teardown() sets ws_port=0.
  wait_for_ha_config "$last_config_signature"

  if [[ ! -f "$CONFIG_JSON" ]]; then
    log "config disappeared after wait — retrying ..."
    sleep 1
    continue
  fi

  # Resolve HA host AFTER config is available so we can read ws_host from it.
  RESOLVED_HOST="$(resolve_ha_host)"
  if [[ -z "$RESOLVED_HOST" ]]; then
    last_config_signature="$BRIDGE_CONFIG_SIGNATURE"
    log "HA WS host is invalid or unavailable; refusing to launch Firefox. Waiting for a new camera session ..."
    continue
  fi
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
  last_config_signature="$BRIDGE_CONFIG_SIGNATURE"
  log "bridge.js exited code=$code — waiting for a new camera session ..."
done
