#!/usr/bin/env bash
# Convenience deploy script. Reads .mtaext (gitignored — real
# CLOUD_LLM_HUB_*, JIRA_* secrets; see .mtaext.example for the template),
# auto-derives APPROUTER_HOST from the CF org's subaccount subdomain to
# avoid landscape host collisions, then runs cds + mbt build + cf deploy.
#
# URL produced: <subaccount-subdomain>-abap-dump-monitor.cfapps.<landscape>
# (matches cloud-llm-hub's per-subaccount host pattern.)
#
# For CUSTOMERS that want BOTH prod and staging in the same CF space,
# duplicate this example's mta.yaml as mta-staging.yaml with a renamed
# top-level ID (e.g. 'abap-dump-monitor-staging'), commit a per-env
# .mtaext.staging that 'extends:' that ID and uses a -staging APPROUTER_HOST,
# and drive each environment with its own deploy invocation. CF Deploy
# Service tracks MTAs by ID; same-ID deploys overwrite each other regardless
# of route, which is why distinct prod/staging in one space need distinct
# MTA descriptors. See cloud-llm-hub's tools/deploy.sh for the full pattern.
#
# For PROD-only single-instance deploys, just commit a per-subaccount
# .mtaext on the deploy/<env> branch with the desired APPROUTER_HOST and
# run: cf deploy ... -e .mtaext  (no host override needed).
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
