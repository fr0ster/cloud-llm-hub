#!/bin/bash

# Quick test script for LLM Agent
# Usage: ./test/test-agent.sh
# Or from project root: bash test/test-agent.sh

BASE_URL="${BASE_URL:-http://localhost:4004}"
AUTH="${AUTH:-Basic YWxpY2U6}"
DEST="${SAP_DESTINATION:-SAP_DEV_DEST}"

echo "🧪 Testing LLM Agent Service"
echo "================================"
echo ""

echo "1️⃣ Health Check..."
echo "GET $BASE_URL/odata/v4/agent/Health()"
curl -s -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: $AUTH" \
  -H "Accept: application/json" | jq '.' || echo "❌ Failed or jq not installed"
echo ""

# Check if API key is provided
if [ -z "$OPENAI_API_KEY" ]; then
  echo "⚠️  Warning: OPENAI_API_KEY not set. Set it to test Chat endpoints:"
  echo "   export OPENAI_API_KEY='sk-proj-your-key-here'"
  echo ""
fi

echo "2️⃣ Chat Test (Simple)..."
echo "GET $BASE_URL/odata/v4/agent/Chat(message='Hello')"
if [ -n "$OPENAI_API_KEY" ]; then
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Chat(message='Hello')" \
    -H "Authorization: $AUTH" \
    -H "X-OpenAI-API-Key: $OPENAI_API_KEY" \
    -H "X-SAP-Destination: $DEST" \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: OPENAI_API_KEY not set"
fi
echo ""

echo "3️⃣ Chat Test (Query Tools)..."
echo "GET $BASE_URL/odata/v4/agent/Chat(message='What tools are available?')"
if [ -n "$OPENAI_API_KEY" ]; then
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Chat(message='What tools are available?')" \
    -H "Authorization: $AUTH" \
    -H "X-OpenAI-API-Key: $OPENAI_API_KEY" \
    -H "X-SAP-Destination: $DEST" \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: OPENAI_API_KEY not set"
fi
echo ""

echo "4️⃣ Get History..."
echo "GET $BASE_URL/odata/v4/agent/GetHistory()"
curl -s -X GET \
  "$BASE_URL/odata/v4/agent/GetHistory()" \
  -H "Authorization: $AUTH" \
  -H "Accept: application/json" | jq '.' || echo "❌ Failed"
echo ""

echo "✅ Test completed!"
echo ""
echo "💡 Tips:"
echo "   - Set OPENAI_API_KEY environment variable OR pass X-OpenAI-API-Key header"
echo "   - API keys can be passed via headers (X-OpenAI-API-Key, X-Anthropic-API-Key, X-DeepSeek-API-Key)"
echo "   - Or set environment variables: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY"
echo "   - Ensure MCP proxy is running"
echo "   - Check SAP destination is configured"
echo "   - Install jq for better JSON formatting: sudo apt install jq"
echo ""
echo "📝 Example with API key in header:"
echo "   curl -X GET \"$BASE_URL/odata/v4/agent/Chat(message='Hello')\" \\"
echo "     -H \"Authorization: $AUTH\" \\"
echo "     -H \"X-OpenAI-API-Key: sk-proj-your-key-here\""

