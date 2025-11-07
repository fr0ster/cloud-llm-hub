#!/bin/bash

# Test script for LLM Agent on BTP (after deployment)
# Usage: ./test/test-agent-btp.sh
# Or from project root: bash test/test-agent-btp.sh

BASE_URL="${BASE_URL:-https://your-app.cfapps.eu10.hana.ondemand.com}"
TOKEN="${TOKEN:-$(cf oauth-token 2>/dev/null || echo '')}"
AI_CORE_DEST="${SAP_CORE_AI_DESTINATION:-SAP_AI_CORE_DEST}"
MODEL="${SAP_CORE_AI_MODEL:-gpt-4o-mini}"
SAP_DEST="${SAP_DESTINATION:-}"

echo "🧪 Testing LLM Agent on BTP"
echo "================================"
echo "Base URL: $BASE_URL"
echo "AI Core Destination: $AI_CORE_DEST"
echo "Model: $MODEL"
if [ -n "$SAP_DEST" ]; then
  echo "SAP Destination: $SAP_DEST (MCP enabled)"
else
  echo "SAP Destination: not set (LLM only mode)"
fi
echo ""

# Check if token is available
if [ -z "$TOKEN" ]; then
  echo "⚠️  Warning: XSUAA token not found."
  echo "   Get token using: cf oauth-token"
  echo "   Or set TOKEN environment variable:"
  echo "   export TOKEN='your-xsuaa-token'"
  echo ""
  echo "   For manual token:"
  echo "   curl -X POST \"https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token\" \\"
  echo "     -H \"Content-Type: application/x-www-form-urlencoded\" \\"
  echo "     -d \"grant_type=client_credentials\" \\"
  echo "     -d \"client_id=<client-id>\" \\"
  echo "     -d \"client_secret=<client-secret>\""
  echo ""
fi

# Health Check
echo "1️⃣ Health Check..."
echo "GET $BASE_URL/odata/v4/agent/Health()"
if [ -n "$TOKEN" ] && [ -n "$AI_CORE_DEST" ]; then
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Health()" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    ${SAP_DEST:+-H "X-SAP-Destination: $SAP_DEST"} \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: TOKEN or SAP_CORE_AI_DESTINATION not set"
fi
echo ""

# LLM Only Test
echo "2️⃣ Chat Test (LLM Only)..."
echo "POST $BASE_URL/odata/v4/agent/Chat"
if [ -n "$TOKEN" ] && [ -n "$AI_CORE_DEST" ]; then
  curl -s -X POST \
    "$BASE_URL/odata/v4/agent/Chat" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    -d '{"message": "Hello! Can you introduce yourself?"}' | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: TOKEN or SAP_CORE_AI_DESTINATION not set"
fi
echo ""

# LLM + MCP Test (if SAP destination provided)
if [ -n "$SAP_DEST" ]; then
  echo "3️⃣ Chat Test (LLM + MCP)..."
  echo "POST $BASE_URL/odata/v4/agent/Chat"
  if [ -n "$TOKEN" ] && [ -n "$AI_CORE_DEST" ]; then
    curl -s -X POST \
      "$BASE_URL/odata/v4/agent/Chat" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
      -H "X-SAP-Core-AI-Model: $MODEL" \
      -H "X-SAP-Destination: $SAP_DEST" \
      -d '{"message": "What tools are available?"}' | jq '.' || echo "❌ Failed"
  else
    echo "   ⚠️  Skipped: TOKEN or SAP_CORE_AI_DESTINATION not set"
  fi
  echo ""
else
  echo "3️⃣ Chat Test (LLM + MCP)..."
  echo "   ⚠️  Skipped: SAP_DESTINATION not set"
  echo "   Set SAP_DESTINATION to test MCP integration:"
  echo "   export SAP_DESTINATION='SAP_DEV_DEST'"
  echo ""
fi

# Get History
echo "4️⃣ Get History..."
echo "GET $BASE_URL/odata/v4/agent/GetHistory()"
if [ -n "$TOKEN" ]; then
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/GetHistory()" \
    -H "Authorization: Bearer $TOKEN" \
    ${AI_CORE_DEST:+-H "X-SAP-Core-AI-Destination: $AI_CORE_DEST"} \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: TOKEN not set"
fi
echo ""

echo "✅ Test completed!"
echo ""
echo "💡 Tips:"
echo "   - All LLM providers are accessed through SAP AI Core"
echo "   - SAP_CORE_AI_DESTINATION: Name of destination pointing to SAP AI Core"
echo "   - SAP_CORE_AI_MODEL: Model name (gpt-4o-mini, claude-3-5-sonnet, deepseek-chat, etc.)"
echo "   - SAP_DESTINATION: SAP destination for MCP tools (optional)"
echo "   - Get token: cf oauth-token"
echo "   - Install jq for better JSON formatting: sudo apt install jq"
echo ""
echo "📝 Example usage:"
echo "   export BASE_URL='https://your-app.cfapps.eu10.hana.ondemand.com'"
echo "   export SAP_CORE_AI_DESTINATION='SAP_AI_CORE_DEST'"
echo "   export SAP_CORE_AI_MODEL='gpt-4o-mini'"
echo "   export SAP_DESTINATION='SAP_DEV_DEST'  # Optional, for MCP"
echo "   bash test/test-agent-btp.sh"
echo ""
echo "📚 See docs/AGENT_TESTING_AFTER_DEPLOYMENT.md for detailed guide"

