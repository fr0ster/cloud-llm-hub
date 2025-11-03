#!/bin/bash

# MCP Proxy Destination Probe Test
# Usage: ./test-destination-probe.sh [base-url] [destination-name] [auth-header]
#
# Examples:
#   ./test-destination-probe.sh http://localhost:4004 MY_DESTINATION "Basic YWxpY2U6"
#   ./test-destination-probe.sh https://app.cfapps.eu10.hana.ondemand.com MY_DESTINATION "Bearer <token>"

BASE_URL="${1:-http://localhost:4004}"
DESTINATION="${2:-}"
AUTH_HEADER="${3:-Basic YWxpY2U6}"

if [ -z "$DESTINATION" ]; then
  echo "❌ ERROR: Destination name is required"
  echo "Usage: $0 [base-url] <destination-name> [auth-header]"
  echo ""
  echo "Example:"
  echo "  $0 http://localhost:4004 SAP_DEV_HTTP \"Basic YWxpY2U6\""
  exit 1
fi

echo "🔍 Testing Destination Probe endpoint"
echo "   URL: $BASE_URL/mcp/ProbeDestination"
echo "   Destination: $DESTINATION"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $AUTH_HEADER" \
  "$BASE_URL/mcp/ProbeDestination?destination=$DESTINATION")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo "Response:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  if echo "$BODY" | grep -q '"destination"'; then
    echo "✅ PASS: Destination probe successful"
    
    # Extract key fields
    CONNECTIVITY=$(echo "$BODY" | jq -r '.connectivity // "unknown"' 2>/dev/null)
    PROXY_TYPE=$(echo "$BODY" | jq -r '.proxyType // "unknown"' 2>/dev/null)
    PROBE_STATUS=$(echo "$BODY" | jq -r '.probe.status // "unknown"' 2>/dev/null)
    
    echo "   Connectivity: $CONNECTIVITY"
    echo "   Proxy Type: $PROXY_TYPE"
    echo "   Probe Status: $PROBE_STATUS"
    
    if [ "$PROBE_STATUS" != "200" ] && [ "$PROBE_STATUS" != "unknown" ]; then
      echo "⚠️  WARNING: Probe returned non-200 status: $PROBE_STATUS"
      exit 1
    fi
    
    exit 0
  else
    echo "❌ FAIL: Response missing destination field"
    exit 1
  fi
elif [ "$HTTP_CODE" = "403" ]; then
  echo "❌ FAIL: Access denied - check authentication"
  exit 1
elif [ "$HTTP_CODE" = "400" ]; then
  echo "❌ FAIL: Bad request - check destination name parameter"
  exit 1
elif [ "$HTTP_CODE" = "502" ]; then
  echo "❌ FAIL: Bad gateway - destination resolution or connection failed"
  echo "   Check:"
  echo "   - Destination service binding"
  echo "   - Destination configuration in BTP"
  echo "   - Connectivity proxy (for on-premise)"
  exit 1
else
  echo "❌ FAIL: Unexpected status code: $HTTP_CODE"
  exit 1
fi

