#!/bin/bash

# Get XSUAA user token via browser authentication
# Usage: ./tools/get-user-token.sh [username] [password]
#
# This script opens a browser for user authentication and gets a token
# Alternative: Use password grant (less secure, for testing only)

set -e

DEFAULT_ENV="${DEFAULT_ENV:-default-env.json}"
USERNAME="${1:-}"
PASSWORD="${2:-}"

if [ ! -f "$DEFAULT_ENV" ]; then
  echo "❌ Error: $DEFAULT_ENV not found"
  echo "   Run: npm run update:env"
  exit 1
fi

# Extract XSUAA credentials
XSUAA_URL=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url // empty')
CLIENT_ID=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid // empty')
CLIENT_SECRET=$(cat "$DEFAULT_ENV" | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret // empty')

if [ -z "$XSUAA_URL" ] || [ -z "$CLIENT_ID" ]; then
  echo "❌ Error: XSUAA credentials not found in $DEFAULT_ENV"
  echo "   Run: npm run update:env"
  exit 1
fi

# Check if password grant is available (for testing)
if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
  echo "📡 Requesting user token via password grant (testing only)..."
  echo "⚠️  Warning: Password grant is less secure. Use browser flow in production."

  TOKEN=$(curl -s -X POST "$XSUAA_URL/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -u "$CLIENT_ID:$CLIENT_SECRET" \
    -d "grant_type=password" \
    -d "username=$USERNAME" \
    -d "password=$PASSWORD" | jq -r '.access_token // empty')

  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ Error: Failed to get user token"
    echo "   Check if password grant is enabled in XSUAA configuration"
    exit 1
  fi

  echo "✅ User token obtained successfully"
  echo ""
  echo "Use this token in your requests:"
  echo "  Authorization: Bearer $TOKEN"
  echo ""
  echo "Or export it:"
  echo "  export USER_TOKEN='$TOKEN'"
  exit 0
fi

# Browser-based authentication (recommended)
echo "🌐 Browser-based authentication"
echo ""
echo "To get a user token:"
echo ""
echo "1. Open this URL in your browser:"
echo ""
AUTH_URL="${XSUAA_URL}/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=http://localhost:8080/callback"
echo "   $AUTH_URL"
echo ""
echo "2. Login with your BTP credentials"
echo ""
echo "3. Copy the authorization code from the redirect URL"
echo ""
echo "4. Exchange the code for a token:"
echo ""
echo "   CODE=\"<authorization-code-from-url>\""
echo "   curl -X POST \"$XSUAA_URL/oauth/token\" \\"
echo "     -H \"Content-Type: application/x-www-form-urlencoded\" \\"
echo "     -u \"$CLIENT_ID:$CLIENT_SECRET\" \\"
echo "     -d \"grant_type=authorization_code\" \\"
echo "     -d \"code=\$CODE\" \\"
echo "     -d \"redirect_uri=http://localhost:8080/callback\" | jq -r '.access_token'"
echo ""
echo ""
echo "Alternative: Use password grant (for testing only):"
echo "  ./tools/get-user-token.sh <username> <password>"
echo ""
echo "⚠️  Note: Password grant must be enabled in xs-security.json"

