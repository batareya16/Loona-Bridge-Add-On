#!/bin/bash
# Run from Mac — uses Google Chrome (has H.264).
# HA WS server binds 0.0.0.0 so Mac can reach it directly.
#
# Usage:
#   sh start-bridge-mac.sh [ha-host]
#   Default ha-host: homeassistant.local
#
# Requires: ssh root@<ha-host> to work (HA SSH/Terminal add-on).

set -e
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
HA_HOST="${1:-homeassistant.local}"

echo "[loona] Fetching config from $HA_HOST ..."
CFG_RAW=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "root@$HA_HOST" \
  "cat /homeassistant/.loona/bridge-config.json 2>/dev/null || cat /config/.loona/bridge-config.json 2>/dev/null") || {
  echo ""
  echo "ERROR: SSH to root@$HA_HOST failed."
  echo "  1. Make sure the HA SSH & Terminal add-on is running."
  echo "  2. Or pass HA's IP directly:  sh start-bridge-mac.sh 192.168.1.100"
  exit 1
}

# Resolve HA LAN IP so ws_host points to the real address.
HA_IP=$(python3 -c "import socket; print(socket.gethostbyname('$HA_HOST'))" 2>/dev/null)
[ -z "$HA_IP" ] && HA_IP="$HA_HOST"
echo "[loona] HA IP: $HA_IP"

# Patch ws_host and ensure headless=true.
CFG=$(python3 - "$CFG_RAW" "$HA_IP" <<'PYEOF'
import json, sys
c = json.loads(sys.argv[1])
c['ws_host'] = sys.argv[2]
c['headless'] = True
print(json.dumps(c))
PYEOF
)

echo "[loona] ws_port=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['ws_port'])" "$CFG")"

export LOONA_BRIDGE_CONFIG="$CFG"
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
echo "[loona] Starting bridge.js with Google Chrome..."
exec node "$BRIDGE_DIR/bridge.js"
