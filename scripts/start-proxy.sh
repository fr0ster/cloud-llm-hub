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
# Per-worktree config:
#   ./proxy.yaml at repo root (deploy branches commit their own).
#   Recognised keys: httpPort, btpDestination, x-sap-destination, consumer,
#   consumer_key, app. Env vars + CLI args still win over yaml.
#
set -euo pipefail

# 0. Load per-worktree proxy.yaml if present (deploy branches keep their own).
#    Parsed with grep/awk — no yaml dep. Keys at root level only.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
YAML="$REPO_ROOT/proxy.yaml"
yaml_get() { grep -E "^${1}:" "$YAML" 2>/dev/null | head -1 | awk -F': *' '{print $2}' | tr -d '"' | tr -d "'" | xargs; }
YAML_PORT=""
YAML_BTP=""
YAML_DEST=""
YAML_CONSUMER=""
YAML_CONSUMER_KEY=""
YAML_APP=""
if [[ -f "$YAML" ]]; then
  YAML_PORT=$(yaml_get httpPort)
  YAML_BTP=$(yaml_get btpDestination)
  YAML_DEST=$(grep -E '^[[:space:]]*x-sap-destination:' "$YAML" | head -1 | awk -F': *' '{print $2}' | tr -d '"' | tr -d "'" | xargs)
  YAML_CONSUMER=$(yaml_get consumer)
  YAML_CONSUMER_KEY=$(yaml_get consumerKey)
  YAML_APP=$(yaml_get app)
  echo "✓ Loaded $YAML"
fi

DEST="${1:-${DESTINATION:-${YAML_DEST:-}}}"
APP="${APP:-${YAML_APP:-cloud-llm-hub-srv}}"
BTP="${BTP:-${YAML_BTP:-mcp}}"
CONSUMER="${CONSUMER:-${YAML_CONSUMER:-cloud-llm-hub-auth}}"
CONSUMER_KEY="${CONSUMER_KEY:-${YAML_CONSUMER_KEY:-mcp}}"
PORT="${PORT:-${YAML_PORT:-3001}}"

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

fetch_key() { cf service-key "$CONSUMER" "$CONSUMER_KEY" 2>&1; }
extract_json() { printf '%s\n' "$1" | sed -n '/^{/,$p'; }

KEY_RAW=$(fetch_key) || true
KEY_JSON=$(extract_json "$KEY_RAW")
if [[ "$KEY_JSON" != \{* ]]; then
  # Key not yet created in this subaccount — try to create it on demand.
  echo "→ service-key '$CONSUMER_KEY' on '$CONSUMER' missing — creating…"
  if ! cf create-service-key "$CONSUMER" "$CONSUMER_KEY" >/dev/null 2>&1; then
    echo "ERROR: cf create-service-key '$CONSUMER' '$CONSUMER_KEY' failed." >&2
    echo "       Check that service instance '$CONSUMER' exists in this space." >&2
    exit 1
  fi
  KEY_RAW=$(fetch_key) || {
    echo "ERROR: still cannot fetch CF service-key '$CONSUMER_KEY' from '$CONSUMER' after create:" >&2
    printf '%s\n' "$KEY_RAW" | head -3 >&2
    exit 1
  }
  KEY_JSON=$(extract_json "$KEY_RAW")
  [[ "$KEY_JSON" == \{* ]] || {
    echo "ERROR: CF service-key output for '$CONSUMER/$CONSUMER_KEY' did not contain a JSON body after create." >&2
    exit 1
  }
fi
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
