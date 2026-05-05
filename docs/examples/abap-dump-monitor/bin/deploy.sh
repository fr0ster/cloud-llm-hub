#!/usr/bin/env bash
# Convenience deploy script. Reads .mtaext (gitignored — real
# CLOUD_LLM_HUB_*, JIRA_* secrets; see .mtaext.example for the template),
# auto-derives APPROUTER_HOST = <subaccount-subdomain>-abap-dump-monitor
# from the targeted CF org, builds and deploys.
#
# CF Deploy Service tracks MTAs by ID, so each `cf deploy` overwrites the
# previous one — only ONE instance of this example exists in a CF space
# at a time. If you need true prod+staging coexistence, fork the example
# into a new repo with a renamed top-level MTA ID and module names.
#
# Usage: cf login --sso && cf target -o ... -s ... && bin/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .mtaext ]]; then
  echo "Missing .mtaext — copy .mtaext.example and fill in CLOUD_LLM_HUB_* and JIRA_* secrets first." >&2
  exit 1
fi

ORG=$(cf target | awk -F': +' '/^org:/{print $2}')
[[ -z "$ORG" ]] && { echo "Not logged into CF — run 'cf login' first" >&2; exit 1; }

SUBDOMAIN="${ORG##*_}"
[[ "$SUBDOMAIN" == "$ORG" ]] && {
  echo "Cannot derive subaccount subdomain from org '$ORG' — set APPROUTER_HOST manually in .mtaext" >&2
  exit 1
}

HOST="${SUBDOMAIN}-abap-dump-monitor"

# Discover the user's .mtaext ID — the host override must extend IT
# (chain: mta.yaml ← .mtaext ← .host.*.mtaext), not the base mta.yaml.
# MTA Deploy Service only applies one extension descriptor per parent ID;
# making both extend 'abap-dump-monitor' silently drops one of them with
# 'Provided but unused extension descriptors because extend another MTA
# ID or extends order is not correct'.
USER_EXT_ID="$(awk -F'[[:space:]]*:[[:space:]]*' '/^ID:/{print $2; exit}' .mtaext)"
[[ -z "$USER_EXT_ID" ]] && { echo "Cannot read 'ID:' from .mtaext" >&2; exit 1; }

HOST_EXT=".host.${SUBDOMAIN}.mtaext"
cat > "$HOST_EXT" <<EOF
_schema-version: '3.3.0'
ID: ${USER_EXT_ID}.host
extends: ${USER_EXT_ID}
parameters:
  APPROUTER_HOST: "${HOST}"
EOF

echo "Subaccount subdomain:    $SUBDOMAIN"
echo "APPROUTER_HOST:          $HOST"
echo "Generated host override: $HOST_EXT"

npx cds build
npx mbt build
cf deploy "mta_archives/abap-dump-monitor_1.0.0.mtar" -e ".mtaext,${HOST_EXT}" -f
