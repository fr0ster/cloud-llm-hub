#!/bin/bash

# Quick test script for a destination probe
# Usage: ./test-probe-s4hana.sh

SERVICE_URL="${SERVICE_URL:?SERVICE_URL is required (e.g. https://<subaccount>-cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com)}"
DESTINATION="${1:-S4HANA_DEV}"

echo "🧪 Testing destination probe for: $DESTINATION"
echo "   Service: $SERVICE_URL"
echo ""

# Get XSUAA token
echo "📝 Getting XSUAA token..."
TOKEN=$(cf oauth-token 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ ERROR: Failed to get XSUAA token"
  echo "   Make sure you are logged in: cf login"
  exit 1
fi

echo "✅ Token obtained"
echo ""

# Test probe endpoint (CAP function)
echo "🔍 Probing destination..."
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$SERVICE_URL/mcp/ProbeDestination?destination=$DESTINATION")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ SUCCESS! Response:"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  echo ""
  
  # Extract key information
  CONNECTIVITY=$(echo "$BODY" | jq -r '.connectivity // "unknown"' 2>/dev/null)
  PROXY_TYPE=$(echo "$BODY" | jq -r '.proxyType // "unknown"' 2>/dev/null)
  PROBE_STATUS=$(echo "$BODY" | jq -r '.probe.status // "unknown"' 2>/dev/null)
  SAP_CLIENT=$(echo "$BODY" | jq -r '.sapClient // "unknown"' 2>/dev/null)
  
  echo "📊 Summary:"
  echo "   Connectivity: $CONNECTIVITY"
  echo "   Proxy Type: $PROXY_TYPE"
  echo "   SAP Client: $SAP_CLIENT"
  echo "   Probe Status: $PROBE_STATUS"
  
  if [ "$PROBE_STATUS" = "200" ]; then
    echo ""
    echo "✅ Destination connection successful!"
    exit 0
  else
    echo ""
    echo "⚠️  WARNING: Probe returned status $PROBE_STATUS"
    exit 1
  fi
  
elif [ "$HTTP_CODE" = "403" ]; then
  echo "❌ FORBIDDEN: Access denied"
  echo "   Check that you have MCP_Connector role assigned"
  echo ""
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
  
elif [ "$HTTP_CODE" = "400" ]; then
  echo "❌ BAD REQUEST: Invalid destination name"
  echo ""
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
  
elif [ "$HTTP_CODE" = "502" ]; then
  echo "❌ BAD GATEWAY: Destination resolution or connection failed"
  echo ""
  echo "Possible causes:"
  echo "  - Destination '$DESTINATION' not found in BTP"
  echo "  - Invalid destination configuration"
  echo "  - Network connectivity issues"
  echo "  - Cloud Connector not configured (for on-premise)"
  echo ""
  echo "Error details:"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
  
else
  echo "❌ UNEXPECTED ERROR: HTTP $HTTP_CODE"
  echo ""
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
fi

