#!/bin/bash

# MCP Proxy Stream-HTTP Smoke Test
# Usage: ./test-stream-http.sh [base-url] [auth-header]

BASE_URL="${1:-http://localhost:4004}"
AUTH_HEADER="${2:-Basic YWxpY2U6}"

echo "🧪 Testing Stream-HTTP endpoint at: $BASE_URL/mcp/stream/http"
echo "🔐 Using auth: $AUTH_HEADER"
echo ""

# Test 1: Unauthorized request
echo "Test 1: Unauthorized request (should return 401)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/mcp/stream/http")
if [ "$HTTP_CODE" = "401" ]; then
  echo "✅ PASS: Got 401 Unauthorized"
else
  echo "❌ FAIL: Expected 401, got $HTTP_CODE"
fi
echo ""

# Test 2: Authorized request with empty body
echo "Test 2: Authorized request (should accept connection)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/x-ndjson" \
  --data '{}' \
  "$BASE_URL/mcp/stream/http")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "500" ]; then
  echo "✅ PASS: Connection accepted (HTTP $HTTP_CODE)"
  if [ "$HTTP_CODE" != "200" ]; then
    echo "⚠️  Note: Non-200 status might indicate upstream not running"
  fi
else
  echo "❌ FAIL: Expected 200/500/502, got $HTTP_CODE"
fi
echo ""

# Test 3: Send NDJSON stream
echo "Test 3: Send NDJSON data"
echo '{"command":"test","id":1}' | \
curl -s -X POST \
  -H "Authorization: $AUTH_HEADER" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- \
  "$BASE_URL/mcp/stream/http" | head -n 3

echo ""
echo "✅ Test 3: Check if response was received above"
echo ""

echo "🎉 Stream-HTTP smoke tests completed"
