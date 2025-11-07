#!/bin/bash

# Quick test script for LLM Agent
# Usage: ./test/test-agent.sh
# Or from project root: bash test/test-agent.sh
#
# For BTP deployment testing, see: docs/AGENT_TESTING_AFTER_DEPLOYMENT.md

BASE_URL="${BASE_URL:-http://localhost:4004}"
AUTH="${AUTH:-Basic YWxpY2U6}"
AI_CORE_DEST="${SAP_CORE_AI_DESTINATION:-SAP_AI_CORE_DEST}"
MODEL="${SAP_CORE_AI_MODEL:-gpt-4o-mini}"
SAP_DEST="${SAP_DESTINATION:-}"

echo "🧪 Testing LLM Agent Service"
echo "================================"
echo "Base URL: $BASE_URL"
echo "AI Core Destination: $AI_CORE_DEST"
echo "Model: $MODEL"
echo ""

# Check if SAP AI Core destination is provided (optional - service binding can be used instead)
if [ -z "$AI_CORE_DEST" ] && [ -z "$SAP_CORE_AI_DESTINATION" ]; then
  echo "ℹ️  Info: SAP_CORE_AI_DESTINATION not set."
  echo "   Service binding from mta.yaml will be used automatically."
  echo "   To use destination instead, set:"
  echo "   export SAP_CORE_AI_DESTINATION='SAP_AI_CORE_DEST'"
  echo ""
fi

echo "1️⃣ Health Check..."
echo "GET $BASE_URL/odata/v4/agent/Health()"
if [ -n "$AI_CORE_DEST" ]; then
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Health()" \
    -H "Authorization: $AUTH" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    ${SAP_DEST:+-H "X-SAP-Destination: $SAP_DEST"} \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed or jq not installed"
else
  curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Health()" \
    -H "Authorization: $AUTH" \
    -H "Accept: application/json" | jq '.' || echo "❌ Failed or jq not installed"
fi
echo ""

echo "2️⃣ Chat Test (LLM Only)..."
echo "POST $BASE_URL/odata/v4/agent/Chat"
if [ -n "$AI_CORE_DEST" ]; then
  curl -s -X POST \
    "$BASE_URL/odata/v4/agent/Chat" \
    -H "Authorization: $AUTH" \
    -H "Content-Type: application/json" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    -d '{"message": "Hello! Can you introduce yourself?"}' | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: SAP_CORE_AI_DESTINATION not set"
fi
echo ""

echo "3️⃣ Chat Test (LLM + MCP)..."
echo "POST $BASE_URL/odata/v4/agent/Chat"
if [ -n "$AI_CORE_DEST" ] && [ -n "$SAP_DEST" ]; then
  curl -s -X POST \
    "$BASE_URL/odata/v4/agent/Chat" \
    -H "Authorization: $AUTH" \
    -H "Content-Type: application/json" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    -H "X-SAP-Destination: $SAP_DEST" \
    -d '{"message": "What tools are available?"}' | jq '.' || echo "❌ Failed"
else
  echo "   ⚠️  Skipped: SAP_CORE_AI_DESTINATION or SAP_DESTINATION not set"
  echo "   Set both to test LLM + MCP:"
  echo "   export SAP_CORE_AI_DESTINATION='SAP_AI_CORE_DEST'"
  echo "   export SAP_DESTINATION='SAP_DEV_DEST'"
fi
echo ""

echo "4️⃣ Get History..."
echo "GET $BASE_URL/odata/v4/agent/GetHistory()"
curl -s -X GET \
  "$BASE_URL/odata/v4/agent/GetHistory()" \
  -H "Authorization: $AUTH" \
  ${AI_CORE_DEST:+-H "X-SAP-Core-AI-Destination: $AI_CORE_DEST"} \
  -H "Accept: application/json" | jq '.' || echo "❌ Failed"
echo ""

echo "✅ Test completed!"
echo ""
echo "💡 Tips:"
echo "   - All LLM providers are accessed through SAP AI Core"
echo "   - Service binding from mta.yaml is used automatically (no destination needed)"
echo "   - Optional: Set SAP_CORE_AI_DESTINATION to use destination instead of service binding"
echo "   - Set SAP_CORE_AI_MODEL to choose model (gpt-4o-mini, claude-3-5-sonnet, deepseek-chat, etc.)"
echo "   - Set SAP_DESTINATION to enable MCP tools integration"
echo "   - For BTP deployment testing, see: docs/AGENT_TESTING_AFTER_DEPLOYMENT.md"
echo "   - Install jq for better JSON formatting: sudo apt install jq"
echo ""
echo "📝 Example for LLM only (using service binding):"
echo "   export SAP_CORE_AI_MODEL='gpt-4o-mini'"
echo "   bash test/test-agent.sh"
echo ""
echo "📝 Example for LLM only (using destination):"
echo "   export SAP_CORE_AI_DESTINATION='SAP_AI_CORE_DEST'"
echo "   export SAP_CORE_AI_MODEL='gpt-4o-mini'"
echo "   bash test/test-agent.sh"
echo ""
echo "📝 Example for LLM + MCP:"
echo "   export SAP_CORE_AI_MODEL='gpt-4o-mini'"
echo "   export SAP_DESTINATION='SAP_DEV_DEST'"
echo "   bash test/test-agent.sh"

