#!/usr/bin/env bash
# Build and deploy abap-dump-monitor to the targeted CF org/space.
#
# Reads .mtaext (gitignored — must contain real CLOUD_LLM_HUB_*, JIRA_*
# values; see .mtaext.example for the template), then layers a generated
# extension on top that sets APPROUTER_HOST to "<subaccount-subdomain>-abap-dump-monitor"
# so the route is unique per subaccount on the same CF landscape.
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

HOST_EXT=".host.${SUBDOMAIN}.mtaext"
cat > "$HOST_EXT" <<EOF
_schema-version: '3.3.0'
ID: abap-dump-monitor.host.${SUBDOMAIN}
extends: abap-dump-monitor
parameters:
  APPROUTER_HOST: "${SUBDOMAIN}-abap-dump-monitor"
EOF

echo "Subaccount subdomain: $SUBDOMAIN"
echo "Generated host override: $HOST_EXT"

npx cds build
npx mbt build
cf deploy "mta_archives/abap-dump-monitor_1.0.0.mtar" -e ".mtaext,${HOST_EXT}" -f
