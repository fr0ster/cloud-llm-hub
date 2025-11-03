#!/bin/bash

# Test destination access directly via Destination Service API
# Usage: ./test-destination-api.sh [destination-name]

DESTINATION="${1:-S4HANA_DEV}"

echo "🔍 Testing destination access via Destination Service API"
echo "   Destination: $DESTINATION"
echo ""

# Get destination service credentials from CF env
echo "📝 Getting destination service credentials..."
DEST_CREDS=$(cf env cloud-llm-hub-srv | grep -A 20 '"destination"' | grep -E '"clientid"|"clientsecret"|"uri"|"tokenServiceURL"')

CLIENT_ID=$(echo "$DEST_CREDS" | grep '"clientid"' | head -1 | cut -d'"' -f4)
CLIENT_SECRET=$(echo "$DEST_CREDS" | grep '"clientsecret"' | head -1 | cut -d'"' -f4)
URI=$(echo "$DEST_CREDS" | grep '"uri"' | head -1 | cut -d'"' -f4)
TOKEN_URL=$(echo "$DEST_CREDS" | grep -E '"tokenServiceURL"|"token_service_url"' | head -1 | cut -d'"' -f4)

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "❌ ERROR: Could not extract destination service credentials"
  exit 1
fi

echo "✅ Credentials extracted"
echo "   URI: $URI"
echo "   Token URL: $TOKEN_URL"
echo ""

# Get service token
echo "🔑 Getting destination service token..."
TOKEN_RESPONSE=$(curl -s -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Authorization: Basic $(echo -n "$CLIENT_ID:$CLIENT_SECRET" | base64)" \
  -d "grant_type=client_credentials")

SERVICE_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')

if [ -z "$SERVICE_TOKEN" ] || [ "$SERVICE_TOKEN" = "null" ]; then
  echo "❌ ERROR: Failed to get service token"
  echo "Response: $TOKEN_RESPONSE" | jq '.' 2>/dev/null || echo "$TOKEN_RESPONSE"
  exit 1
fi

echo "✅ Service token obtained"
echo ""

# Get destination
echo "🔍 Fetching destination configuration..."
DEST_URL="${URI}/destination-configuration/v1/destinations/${DESTINATION}"

DEST_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$DEST_URL")

HTTP_CODE=$(echo "$DEST_RESPONSE" | tail -n1)
DEST_BODY=$(echo "$DEST_RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Destination found!"
  echo ""
  echo "Configuration:"
  echo "$DEST_BODY" | jq '.' 2>/dev/null || echo "$DEST_BODY"
  exit 0
  
elif [ "$HTTP_CODE" = "404" ]; then
  echo "❌ Destination not found"
  echo ""
  echo "Possible reasons:"
  echo "  - Destination '$DESTINATION' does not exist in this subaccount"
  echo "  - Destination is in a different subaccount"
  echo "  - Destination name is incorrect"
  echo ""
  echo "Response:"
  echo "$DEST_BODY" | jq '.' 2>/dev/null || echo "$DEST_BODY"
  exit 1
  
else
  echo "❌ ERROR: HTTP $HTTP_CODE"
  echo ""
  echo "Response:"
  echo "$DEST_BODY" | jq '.' 2>/dev/null || echo "$DEST_BODY"
  exit 1
fi

