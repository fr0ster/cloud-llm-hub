#!/usr/bin/env bash
# start-proxy.sh — start mcp-abap-adt-proxy against the currently targeted
# cloud-llm-hub-srv app. Resolves the app's live route via `cf app`, so the
# proxy always points at the latest deployment without manual URL editing.
#
# Usage:
#   npm run proxy                   # no destination — server uses its configured default
#   npm run proxy S4HANA_DEV        # override destination
#
# Environment overrides:
#   APP         — target CF app name (default: cloud-llm-hub-srv)
#   BTP         — --btp parameter name for service-key lookup (default: mcp)
#   PORT        — local HTTP port (default: 3001)
#   DESTINATION — fallback when no CLI arg is provided
#
set -euo pipefail

DEST="${1:-${DESTINATION:-}}"
APP="${APP:-cloud-llm-hub-srv}"
BTP="${BTP:-mcp}"
PORT="${PORT:-3001}"

have() { command -v "$1" >/dev/null 2>&1; }
have cf                  || { echo "cf CLI not installed" >&2; exit 1; }
have mcp-abap-adt-proxy  || { echo "mcp-abap-adt-proxy not installed" >&2; exit 1; }

HOST=$(cf app "$APP" 2>/dev/null | awk -F': *' '/^routes:/{print $2; exit}')
[[ -n "$HOST" ]] || {
  echo "cannot resolve route for app '$APP' — run 'cf target' on the right subaccount first" >&2
  exit 1
}

URL="https://${HOST}"
if [[ -n "$DEST" ]]; then
  echo "proxying :$PORT → $URL (destination=$DEST, btp=$BTP)"
  exec mcp-abap-adt-proxy --transport=streamable-http --btp="$BTP" \
    --url="$URL" \
    --http-port="$PORT" \
    --header "x-sap-destination=$DEST"
else
  echo "proxying :$PORT → $URL (btp=$BTP, destination from server default)"
  exec mcp-abap-adt-proxy --transport=streamable-http --btp="$BTP" \
    --url="$URL" \
    --http-port="$PORT"
fi
