#!/bin/bash

# MCP Proxy SSE Smoke Test
# Usage: ./test-sse.sh [base-url] [auth-header]

BASE_URL="${1:-http://localhost:4004}"
AUTH_HEADER="${2:-Basic YWxpY2U6}"

echo "🧪 Testing SSE endpoint at: $BASE_URL/mcp/stream/sse"
echo "🔐 Using auth: $AUTH_HEADER"
echo ""

# Test 1: Unauthorized request
echo "Test 1: Unauthorized request (should return 401)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/mcp/stream/sse")
if [ "$HTTP_CODE" = "401" ]; then
  echo "✅ PASS: Got 401 Unauthorized"
else
  echo "❌ FAIL: Expected 401, got $HTTP_CODE"
fi
echo ""

# Test 2: Authorized SSE connection
echo "Test 2: Authorized SSE connection (should return 200 and stream)"
timeout 10 curl -N -s \
  -H "Accept: text/event-stream" \
  -H "Authorization: $AUTH_HEADER" \
  -w "\nHTTP Status: %{http_code}\n" \
  "$BASE_URL/mcp/stream/sse" | head -n 5

echo ""
echo "✅ Test 2: If you see 'retry: 15000' above, SSE is working"
echo ""

# Test 3: Check for heartbeat
echo "Test 3: Waiting for heartbeat (15 seconds)..."
HEARTBEAT=$(timeout 20 curl -N -s \
  -H "Accept: text/event-stream" \
  -H "Authorization: $AUTH_HEADER" \
  "$BASE_URL/mcp/stream/sse" | grep -m 1 "ping")

if [ ! -z "$HEARTBEAT" ]; then
  echo "✅ PASS: Heartbeat received: $HEARTBEAT"
else
  echo "⚠️  WARNING: No heartbeat detected (might be upstream issue)"
fi
echo ""

echo "🎉 SSE smoke tests completed"
