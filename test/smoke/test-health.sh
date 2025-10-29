#!/bin/bash

# MCP Proxy Health Check
# Usage: ./test-health.sh [base-url]

BASE_URL="${1:-http://localhost:4004}"

echo "🏥 Testing Health endpoint at: $BASE_URL/mcp/Health"
echo ""

RESPONSE=$(curl -s "$BASE_URL/mcp/Health")
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/mcp/Health")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  if echo "$RESPONSE" | grep -q '"status":"UP"'; then
    echo "✅ PASS: Health check successful"
    exit 0
  else
    echo "❌ FAIL: Response missing 'status:UP'"
    exit 1
  fi
else
  echo "❌ FAIL: Expected 200, got $HTTP_CODE"
  exit 1
fi
