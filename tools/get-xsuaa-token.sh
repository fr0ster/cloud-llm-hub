#!/bin/bash

# Get XSUAA token from default-env.json for hybrid debugging
# Usage: ./tools/get-xsuaa-token.sh

set -e

DEFAULT_ENV="${DEFAULT_ENV:-default-env.json}"

if [ ! -f "$DEFAULT_ENV" ]; then
  echo "❌ Error: $DEFAULT_ENV not found"
  echo "   Run: npm run update:env"
  exit 1
fi

# Extract XSUAA credentials
XSUAA_URL=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url // empty')
CLIENT_ID=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid // empty')
CLIENT_SECRET=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret // empty')

if [ -z "$XSUAA_URL" ] || [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "❌ Error: XSUAA credentials not found in $DEFAULT_ENV"
  echo "   Run: npm run update:env"
  exit 1
fi

# Get token
echo "📡 Requesting OAuth token from: $XSUAA_URL"
TOKEN=$(curl -s -X POST "$XSUAA_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" | jq -r '.access_token // empty')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "❌ Error: Failed to get OAuth token"
  exit 1
fi

echo "✅ Token obtained successfully"
echo ""
echo "Use this token in your requests:"
echo "  Authorization: Bearer $TOKEN"
echo ""
echo "Or export it:"
echo "  export XSUAA_TOKEN='$TOKEN'"
echo "  curl -H \"Authorization: Bearer \$XSUAA_TOKEN\" http://localhost:4004/odata/v4/mcp/Health()"

