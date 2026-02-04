#!/bin/bash

# Test OData endpoints for LLM Agent after deployment
# Usage: ./test/test-agent-odata.sh
# Or from project root: bash test/test-agent-odata.sh

BASE_URL="${BASE_URL:-}"
TOKEN="${TOKEN:-}"

# Get URL and token if not provided
if [ -z "$BASE_URL" ]; then
  BASE_URL=$(cf app cloud-llm-hub-srv 2>/dev/null | grep -E "urls:|routes:" | head -1 | awk '{print $2}' || echo "")
  if [ -z "$BASE_URL" ]; then
    # Try alternative method
    BASE_URL=$(cf apps 2>/dev/null | grep "cloud-llm-hub-srv" | awk '{print $NF}' || echo "")
  fi
  if [ -z "$BASE_URL" ]; then
    echo "❌ Could not get app URL. Set BASE_URL environment variable:"
    echo "   export BASE_URL='https://your-app.cfapps.eu10.hana.ondemand.com'"
    exit 1
  fi
  # Ensure URL starts with https://
  if [[ ! "$BASE_URL" =~ ^https?:// ]]; then
    BASE_URL="https://$BASE_URL"
  fi
fi

if [ -z "$TOKEN" ]; then
  # Try to get token from XSUAA service instance (correct audience)
  SERVICE_KEY_JSON=$(cf service-key cloud-llm-hub-auth test-key 2>/dev/null | sed -n '/^{/,/^}/p' | jq -r '.credentials // empty' 2>/dev/null)
  
  if [ -n "$SERVICE_KEY_JSON" ] && [ "$SERVICE_KEY_JSON" != "null" ] && [ "$SERVICE_KEY_JSON" != "" ]; then
    XSUAA_URL=$(echo "$SERVICE_KEY_JSON" | jq -r '.url // empty')
    CLIENT_ID=$(echo "$SERVICE_KEY_JSON" | jq -r '.clientid // empty')
    CLIENT_SECRET=$(echo "$SERVICE_KEY_JSON" | jq -r '.clientsecret // empty')
    
    if [ -n "$XSUAA_URL" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] && [ "$XSUAA_URL" != "null" ]; then
      echo "🔐 Getting token from XSUAA service instance..."
      TOKEN_RESPONSE=$(curl -s -X POST "$XSUAA_URL/oauth/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=client_credentials" \
        -d "client_id=$CLIENT_ID" \
        -d "client_secret=$CLIENT_SECRET")
      TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
      if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
        echo "✅ Token obtained from XSUAA service instance"
      fi
    fi
  fi
  
  # Fallback to cf oauth-token if XSUAA method failed
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "⚠️  Could not get token from XSUAA service key, trying cf oauth-token..."
    TOKEN=$(cf oauth-token 2>/dev/null | sed 's/^bearer //i' || echo "")
  fi
  
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ Could not get XSUAA token. Set TOKEN environment variable:"
    echo "   export TOKEN='your-xsuaa-token'"
    echo "   Or ensure service key 'test-key' exists: cf create-service-key cloud-llm-hub-auth test-key"
    exit 1
  fi
fi

MODEL="${SAP_CORE_AI_MODEL:-gpt-4o-mini}"
SAP_DEST="${SAP_DESTINATION:-}"

echo "🧪 Testing LLM Agent OData Endpoints"
echo "===================================="
echo "Base URL: $BASE_URL"
echo "Model: $MODEL"
if [ -n "$SAP_DEST" ]; then
  echo "SAP Destination: $SAP_DEST (MCP enabled)"
else
  echo "SAP Destination: not set (LLM only mode)"
fi
echo ""

# 1. Health Check
echo "1️⃣ Health Check..."
echo "GET $BASE_URL/odata/v4/agent/Health()"
RESPONSE=$(curl -s -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Model: $MODEL" \
  ${SAP_DEST:+-H "X-SAP-Destination: $SAP_DEST"} \
  -H "Accept: application/json")

echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
echo ""

# Check if agent is ready
AGENT_READY=$(echo "$RESPONSE" | jq -r '.agentReady // false')
MCP_CONNECTED=$(echo "$RESPONSE" | jq -r '.mcpConnected // false')

if [ "$AGENT_READY" = "true" ]; then
  echo "✅ Agent is ready"
else
  echo "⚠️  Agent is not ready"
fi

if [ -n "$SAP_DEST" ]; then
  if [ "$MCP_CONNECTED" = "true" ]; then
    echo "✅ MCP is connected"
  else
    echo "⚠️  MCP is not connected"
  fi
fi

echo ""

# 2. Chat Test (LLM Only)
echo "2️⃣ Chat Test (LLM Only)..."
echo "GET $BASE_URL/odata/v4/agent/Chat(message='Hello! Can you introduce yourself?')"
# URL encode the message
MESSAGE="Hello! Can you introduce yourself?"
MESSAGE_ENCODED=$(echo "$MESSAGE" | jq -sRr @uri)
RESPONSE=$(curl -s -X GET \
  "$BASE_URL/odata/v4/agent/Chat(message='$MESSAGE_ENCODED')" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Model: $MODEL" \
  -H "Accept: application/json")

echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
echo ""

# 3. Chat Test (LLM + MCP) - if SAP destination provided
if [ -n "$SAP_DEST" ]; then
  echo "3️⃣ Chat Test (LLM + MCP)..."
  echo "GET $BASE_URL/odata/v4/agent/Chat(message='What tools are available?')"
  MESSAGE="What tools are available?"
  MESSAGE_ENCODED=$(echo "$MESSAGE" | jq -sRr @uri)
  RESPONSE=$(curl -s -X GET \
    "$BASE_URL/odata/v4/agent/Chat(message='$MESSAGE_ENCODED')" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    -H "X-SAP-Destination: $SAP_DEST" \
    -H "Accept: application/json")
  
  echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
  echo ""
fi

# 4. Get History
echo "4️⃣ Get History..."
echo "GET $BASE_URL/odata/v4/agent/GetHistory()"
RESPONSE=$(curl -s -X GET \
  "$BASE_URL/odata/v4/agent/GetHistory()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Model: $MODEL" \
  -H "Accept: application/json")

echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
echo ""

# 5. Clear History
echo "5️⃣ Clear History..."
echo "POST $BASE_URL/odata/v4/agent/ClearHistory"
RESPONSE=$(curl -s -X POST \
  "$BASE_URL/odata/v4/agent/ClearHistory" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Model: $MODEL")

echo "$RESPONSE" | jq '.' || echo "$RESPONSE"
echo ""

echo "✅ Test completed!"
echo ""
echo "💡 Tips:"
echo "   - All LLM providers are accessed through SAP AI Core"
echo "   - Service binding is used automatically (no destination needed)"
echo "   - Set SAP_CORE_AI_MODEL to choose model (gpt-4o-mini, claude-3-5-sonnet, deepseek-chat, etc.)"
echo "   - Set SAP_DESTINATION to enable MCP tools integration"
echo "   - Install jq for better JSON formatting: sudo apt install jq"
echo ""
echo "📝 Example usage:"
echo "   export SAP_CORE_AI_MODEL='gpt-4o-mini'"
echo "   export SAP_DESTINATION='SAP_DEV_DEST'  # Optional, for MCP"
echo "   bash test/test-agent-odata.sh"

