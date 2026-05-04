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

# Detect staging deploy from the current git branch / worktree dir name.
# Convention: any branch or worktree containing 'stg' or 'staging' (case-
# insensitive) gets a '-staging' suffix on the route, so an operator can
# tell prod and staging apart at a glance:
#   prod deploy:    <sub>-abap-dump-monitor.cfapps...
#   staging deploy: <sub>-abap-dump-monitor-staging.cfapps...
# The MTA ID stays 'abap-dump-monitor' either way, so the same CF space
# tracks ONE deployment (last cf deploy wins). For true prod+staging
# coexistence in one space, use Option C in DEPLOYMENT.md (separate
# mta-staging.yaml with renamed top-level ID).
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
WT_NAME="$(basename "$(realpath "$(git rev-parse --show-toplevel)")")"
SUFFIX=""
# Token boundary check — alphanumerics in the regex are anchors so the
# match doesn't fire on substrings like 'po(stg)res' inside
# 'feature/postgresql-support'. Underscore is NOT in [:alnum:], so
# 'foo_stg' still matches at the underscore boundary.
TOKEN_RE='(^|[^[:alnum:]])(stg|staging)([^[:alnum:]]|$)'
shopt -s nocasematch
if [[ "$BRANCH" =~ $TOKEN_RE ]] || [[ "$WT_NAME" =~ $TOKEN_RE ]]; then
  SUFFIX="-staging"
fi
shopt -u nocasematch
HOST="${SUBDOMAIN}-abap-dump-monitor${SUFFIX}"

HOST_EXT=".host.${SUBDOMAIN}${SUFFIX}.mtaext"
cat > "$HOST_EXT" <<EOF
_schema-version: '3.3.0'
ID: abap-dump-monitor.host.${SUBDOMAIN}${SUFFIX}
extends: abap-dump-monitor
parameters:
  APPROUTER_HOST: "${HOST}"
EOF

echo "Subaccount subdomain: $SUBDOMAIN"
echo "Detected env suffix:   ${SUFFIX:-<none, prod>}"
echo "APPROUTER_HOST:        $HOST"
echo "Generated override:    $HOST_EXT"

npx cds build
npx mbt build
cf deploy "mta_archives/abap-dump-monitor_1.0.0.mtar" -e ".mtaext,${HOST_EXT}" -f
