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
#   APP           — target CF app name (default: cloud-llm-hub-srv)
#   BTP           — --btp parameter name for service-key lookup (default: mcp).
#                   Also the basename under ~/.config/mcp-abap-adt/service-keys/.
#   CONSUMER      — xsuaa service-instance the proxy authenticates with
#                   (default: cloud-llm-hub-auth — the server's own xsuaa with
#                   'authorization_code' grant + redirect-uris for localhost).
#                   The *-consumer xsuaa instances are client_credentials-only
#                   and cannot drive a browser OAuth flow.
#   CONSUMER_KEY  — service-key name on that instance (default: mcp).
#   PORT          — local HTTP port (default: 3001)
#   DESTINATION   — fallback when no CLI arg is provided
#
set -euo pipefail

DEST="${1:-${DESTINATION:-}}"
APP="${APP:-cloud-llm-hub-srv}"
BTP="${BTP:-mcp}"
CONSUMER="${CONSUMER:-cloud-llm-hub-auth}"
CONSUMER_KEY="${CONSUMER_KEY:-mcp}"
PORT="${PORT:-3001}"

have() { command -v "$1" >/dev/null 2>&1; }
have cf                  || { echo "ERROR: cf CLI not installed" >&2; exit 1; }
# mcp-abap-adt-proxy ships as @mcp-abap-adt/proxy in devDependencies; npm run
# puts node_modules/.bin on PATH so 'have' resolves the local install. The
# global brew/npm install still works as a fallback when run outside npm-script
# context.
have mcp-abap-adt-proxy  || { echo "ERROR: mcp-abap-adt-proxy not on PATH — run 'npm install' first" >&2; exit 1; }

# 1. Verify CF authentication is alive. `cf target` succeeds locally even when
#    the OAuth token has expired — only an actual API call reveals expiry. Use
#    a cheap one (`cf api`) and check the exit code.
if ! cf target >/dev/null 2>&1; then
  echo "ERROR: not logged into Cloud Foundry — run 'cf login --sso'" >&2
  exit 1
fi
TARGET=$(cf target 2>&1)
ORG=$(printf '%s\n'  "$TARGET" | awk -F': +' '/^org:/{print $2}')
SPACE=$(printf '%s\n' "$TARGET" | awk -F': +' '/^space:/{print $2}')
[[ -n "$ORG" && -n "$SPACE" ]] || {
  echo "ERROR: no org/space targeted — run 'cf target -o <org> -s <space>'" >&2
  exit 1
}

# 2. Probe the API to detect a stale token (cf target alone won't notice).
if ! cf orgs >/dev/null 2>&1; then
  echo "ERROR: CF auth token expired or invalid — run 'cf login --sso' to refresh" >&2
  exit 1
fi

# 3. Resolve the app's live route. `cf app` returns non-zero if the app doesn't
#    exist in the targeted space, which means we're connected to the wrong
#    subaccount. Fail with a clear message instead of producing an empty URL.
APP_INFO=$(cf app "$APP" 2>&1) || {
  echo "ERROR: app '$APP' not found in '$ORG' / '$SPACE'." >&2
  echo "       Either the app isn't deployed here, or you targeted the wrong subaccount." >&2
  echo "       Detail: $(printf '%s\n' "$APP_INFO" | head -1)" >&2
  exit 1
}
HOST=$(printf '%s\n' "$APP_INFO" | awk -F': *' '/^routes:/{print $2; exit}')
[[ -n "$HOST" ]] || {
  echo "ERROR: app '$APP' exists but has no route bound." >&2
  exit 1
}
[[ "$HOST" == *.* ]] || {
  echo "ERROR: route '$HOST' for app '$APP' looks malformed (no dot)." >&2
  exit 1
}
echo "✓ CF target:  $ORG / $SPACE"
echo "✓ App route:  $HOST"

# 4. Refresh the proxy's service-key for the targeted subaccount. mcp-abap-adt-proxy
#    keys cache by --btp name in ~/.config/mcp-abap-adt/service-keys/<btp>.json
#    and never re-fetches; switching CF target leaves the file pointing at the
#    OLD subaccount and the proxy returns a token whose audience does not match
#    the new app, surfacing as "500 + WrongAudienceError" downstream. Pull the
#    current credentials from cf and overwrite the cached file. Wipe any stored
#    OAuth session for the same name so the next request triggers a fresh
#    auth-code flow against the right tenant.
KEY_DIR="$HOME/.config/mcp-abap-adt/service-keys"
SESSION_DIR="$HOME/.config/mcp-abap-adt/sessions"
mkdir -p "$KEY_DIR" "$SESSION_DIR"
KEY_PATH="$KEY_DIR/${BTP}.json"

KEY_RAW=$(cf service-key "$CONSUMER" "$CONSUMER_KEY" 2>&1) || {
  echo "ERROR: cannot fetch CF service-key '$CONSUMER_KEY' from '$CONSUMER':" >&2
  printf '%s\n' "$KEY_RAW" | head -3 >&2
  echo "       Create one with:" >&2
  echo "         cf create-service-key $CONSUMER $CONSUMER_KEY" >&2
  exit 1
}
KEY_JSON=$(printf '%s\n' "$KEY_RAW" | sed -n '/^{/,$p')
[[ "$KEY_JSON" == \{* ]] || {
  echo "ERROR: CF service-key output for '$CONSUMER/$CONSUMER_KEY' did not contain a JSON body." >&2
  exit 1
}
NEW_ZONE=$(printf '%s\n' "$KEY_JSON" | grep -m1 '"identityzone"' | sed 's/.*"identityzone":[[:space:]]*"\([^"]*\)".*/\1/')
OLD_ZONE=""
[[ -f "$KEY_PATH" ]] && OLD_ZONE=$(grep -m1 '"identityzone"' "$KEY_PATH" 2>/dev/null | sed 's/.*"identityzone":[[:space:]]*"\([^"]*\)".*/\1/')
printf '%s\n' "$KEY_JSON" > "$KEY_PATH"
if [[ -n "$OLD_ZONE" && "$OLD_ZONE" != "$NEW_ZONE" ]]; then
  echo "✓ Service key: $CONSUMER/$CONSUMER_KEY ($NEW_ZONE) — replaced cached '$OLD_ZONE' key"
  rm -f "$SESSION_DIR/${BTP}.env"
else
  echo "✓ Service key: $CONSUMER/$CONSUMER_KEY ($NEW_ZONE)"
fi

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
