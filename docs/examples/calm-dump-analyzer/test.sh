#!/usr/bin/env bash
# Test the CALM Dump Analyzer on BTP.
#
# Uses Basic auth with XSUAA client credentials (clientid:clientsecret).
#
# Usage:
#   ./test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="calm-dump-analyzer-srv"
AUTH_INSTANCE="calm-dump-analyzer-auth"
KEY_NAME="test-key"

# Get app URL
echo "Getting service URL..."
APP_URL="https://$(cf app "$APP_NAME" 2>/dev/null | grep 'routes:' | awk '{print $2}')"
echo "URL: $APP_URL"

# Ensure service key exists
echo "Ensuring service key..."
cf service-key "$AUTH_INSTANCE" "$KEY_NAME" >/dev/null 2>&1 || \
  cf create-service-key "$AUTH_INSTANCE" "$KEY_NAME" >/dev/null 2>&1

# Extract clientid and clientsecret from service key
CREDS=$(cf service-key "$AUTH_INSTANCE" "$KEY_NAME" 2>/dev/null | tail -n +2)
# strict=False needed because cf service-key output may contain control characters
CLIENT_ID=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientid'])")
CLIENT_SECRET=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientsecret'])")

echo "Auth: Basic (clientid:clientsecret)"
echo ""

echo "=== Health ==="
curl -s "$APP_URL/odata/v4/analyzer/Health()" \
  -u "$CLIENT_ID:$CLIENT_SECRET" | python3 -m json.tool

echo ""
echo "=== Analyze Dump ==="
EVENT_JSON=$(cat "$SCRIPT_DIR/test-payload.json" | python3 -c "import sys,json; print(json.dumps(json.dumps(json.load(sys.stdin))))")
curl -s -X POST "$APP_URL/odata/v4/analyzer/AnalyzeDump" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"event\": $EVENT_JSON}" | python3 -m json.tool
