#!/usr/bin/env bash
# Test the CALM Dump Analyzer on BTP.
#
# Tests both auth methods:
# 1. Basic auth (clientid:clientsecret) — for service-to-service integration
# 2. Bearer JWT token — for OAuth2 clients
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

# Extract credentials from service key
CREDS=$(cf service-key "$AUTH_INSTANCE" "$KEY_NAME" 2>/dev/null | tail -n +2)
CLIENT_ID=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientid'])")
CLIENT_SECRET=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientsecret'])")
TOKEN_URL=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['url'])")

# Get JWT token for Bearer auth test
echo "Getting JWT token..."
TOKEN=$(curl -s -X POST "$TOKEN_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

EVENT_JSON=$(cat "$SCRIPT_DIR/test-payload.json" | python3 -c "import sys,json; print(json.dumps(json.dumps(json.load(sys.stdin))))")

echo ""
echo "=========================================="
echo "Test 1: Basic Auth (clientid:clientsecret)"
echo "=========================================="

echo "=== Health (Basic) ==="
curl -s -w "\nHTTP %{http_code}\n" "$APP_URL/odata/v4/analyzer/Health()" \
  -u "$CLIENT_ID:$CLIENT_SECRET" | python3 -m json.tool 2>/dev/null || true

echo ""
echo "=== AnalyzeDump (Basic) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$APP_URL/odata/v4/analyzer/AnalyzeDump" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"event\": $EVENT_JSON}" | python3 -m json.tool 2>/dev/null || true

echo ""
echo "=========================================="
echo "Test 2: Bearer JWT Token"
echo "=========================================="

echo "=== Health (Bearer) ==="
curl -s -w "\nHTTP %{http_code}\n" "$APP_URL/odata/v4/analyzer/Health()" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null || true

echo ""
echo "=== AnalyzeDump (Bearer) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$APP_URL/odata/v4/analyzer/AnalyzeDump" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"event\": $EVENT_JSON}" | python3 -m json.tool 2>/dev/null || true

echo ""
echo "=========================================="
echo "Test 3: No Auth (should fail)"
echo "=========================================="
curl -s -w "\nHTTP %{http_code}\n" "$APP_URL/odata/v4/analyzer/Health()" | head -3
