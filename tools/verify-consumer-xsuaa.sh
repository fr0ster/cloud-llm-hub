#!/usr/bin/env bash
# Verify a consumer xsuaa instance end-to-end:
#   1. Fetch service key → extract clientid/clientsecret/url
#   2. Request client_credentials token from xsuaa
#   3. Decode JWT payload (aud/iss/scope/zid/client_id)
#   4. Call a protected cloud-llm-hub-srv endpoint with the token
#
# Exit codes:
#   0 — token accepted (HTTP 200)
#   1 — token rejected (HTTP 401/403)
#   2 — unexpected response (other HTTP)
#
# Usage:
#   tools/verify-consumer-xsuaa.sh [SERVICE_INSTANCE] [SERVICE_KEY] SRV_URL TEST_SYSTEM
#
# Example:
#   tools/verify-consumer-xsuaa.sh cloud-llm-hub-analyst-consumer analyst-key \
#     https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com DEV.100

set -euo pipefail

SERVICE_INSTANCE="${1:-cloud-llm-hub-analyst-consumer}"
SERVICE_KEY="${2:-analyst-key}"
SRV_URL="${3:?SRV_URL is required (e.g. https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com)}"
TEST_SYSTEM="${4:?TEST_SYSTEM is required (e.g. DEV.100)}"

echo "Fetching service key ${SERVICE_KEY} for ${SERVICE_INSTANCE}..."
KEY_JSON=$(cf service-key "${SERVICE_INSTANCE}" "${SERVICE_KEY}" | sed -n '/^{/,/^}/p')
if [ -z "${KEY_JSON}" ]; then
  echo "FAIL: could not extract JSON body from cf service-key output" >&2
  exit 2
fi

read -r CLIENT_ID CLIENT_SECRET TOKEN_URL <<<"$(echo "${KEY_JSON}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const k=JSON.parse(d).credentials;
  process.stdout.write([k.clientid,k.clientsecret,k.url].join(' '));
});
")"

if [ -z "${CLIENT_ID}" ] || [ -z "${CLIENT_SECRET}" ] || [ -z "${TOKEN_URL}" ]; then
  echo "FAIL: missing clientid/clientsecret/url in service key credentials" >&2
  exit 2
fi

echo "Requesting client_credentials token from ${TOKEN_URL}/oauth/token..."
TOKEN_RESPONSE=$(curl -sS -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  "${TOKEN_URL}/oauth/token")

TOKEN=$(echo "${TOKEN_RESPONSE}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  if(!j.access_token){console.error('Token error:',JSON.stringify(j));process.exit(1);}
  process.stdout.write(j.access_token);
});
")

if [ -z "${TOKEN}" ]; then
  echo "FAIL: no access_token returned by xsuaa (see stderr)" >&2
  exit 2
fi

echo ""
echo "--- Token payload ---"
echo "${TOKEN}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const t=d.trim();
  const p=JSON.parse(Buffer.from(t.split('.')[1],'base64').toString('utf8'));
  console.log('aud:      ',JSON.stringify(p.aud));
  console.log('iss:      ',p.iss);
  console.log('scope:    ',JSON.stringify(p.scope));
  console.log('zid:      ',p.zid);
  console.log('client_id:',p.client_id);
});
"

echo ""
echo "--- Calling ${SRV_URL}/v1/destinations/resolve?system=${TEST_SYSTEM} ---"
HTTP_CODE=$(curl -sS -o /tmp/verify-consumer-xsuaa-resp.json -w "%{http_code}" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${SRV_URL}/v1/destinations/resolve?system=${TEST_SYSTEM}")

echo "HTTP ${HTTP_CODE}"
cat /tmp/verify-consumer-xsuaa-resp.json
echo ""

case "${HTTP_CODE}" in
  200)
    echo ""
    echo "PASS: token accepted by cloud-llm-hub-srv"
    exit 0
    ;;
  401|403)
    echo ""
    echo "FAIL: token rejected (HTTP ${HTTP_CODE}) — see docs/lessons/2026-04-19-xsuaa-cross-app-grants.md"
    exit 1
    ;;
  *)
    echo ""
    echo "WARN: unexpected HTTP ${HTTP_CODE} — token auth may have passed but endpoint returned ${HTTP_CODE}"
    exit 2
    ;;
esac
