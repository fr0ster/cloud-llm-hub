# Testing LLM Agent After Deployment

## Prerequisites

After deploying to SAP BTP, ensure:

1. ✅ **SAP AI Core service** is bound to the app (via mta.yaml)
2. ✅ **SAP AI Core destination** (optional) - only if you want to use destination instead of service binding
3. ✅ **Models/providers** are configured in SAP AI Core Launchpad
4. ✅ **XSUAA token** for authentication

**Note:** If SAP AI Core service is bound via mta.yaml, you don't need to configure a destination. The service binding is used automatically. Destination is only needed if you want to point to a different AI Core instance or need additional configuration.

## Getting Your Deployment URL

After deployment, get your app URL:

```bash
# Get app URL
cf apps | grep cloud-llm-hub

# Or get from app info
cf app cloud-llm-hub-srv | grep urls
```

Example URL: `https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com`

## Getting XSUAA Token

For testing, you need an XSUAA token:

```bash
# Get token using CF CLI
cf oauth-token

# Or manually via OAuth endpoint
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

## Testing Scenarios

### Scenario 1: LLM Only (Without MCP)

Test the agent with LLM only, without MCP tools.

#### 1. Health Check

```bash
BASE_URL="https://your-app.cfapps.eu10.hana.ondemand.com"
TOKEN="your-xsuaa-token"

# Option 1: Using service binding (no destination needed)
curl -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -H "Accept: application/json" | jq '.'

# Option 2: Using destination (if configured)
curl -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -H "Accept: application/json" | jq '.'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": false,
  "llmProvider": "SAP Core AI",
  "destination": "SAP_AI_CORE_DEST",
  "model": "gpt-4o-mini",
  "timestamp": "2025-11-06T15:00:00.000Z"
}
```

**Note:** `mcpConnected: false` is expected for LLM-only mode (no MCP tools).

#### 2. Simple Chat (LLM Only)

```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -d '{
    "message": "Hello! Can you introduce yourself?"
  }' | jq '.'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#Edm.String",
  "value": "Hello! I'm an AI assistant powered by SAP AI Core..."
}
```

#### 3. Chat with Different Models

Test different LLM providers through SAP AI Core:

**OpenAI (via SAP AI Core):**
```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -d '{
    "message": "What is 2+2?"
  }' | jq '.'
```

**Anthropic (via SAP AI Core):**
```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: claude-3-5-sonnet-20241022" \
  -d '{
    "message": "What is 2+2?"
  }' | jq '.'
```

**DeepSeek (via SAP AI Core):**
```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: deepseek-chat" \
  -d '{
    "message": "What is 2+2?"
  }' | jq '.'
```

### Scenario 2: LLM + MCP (With Tools)

Test the agent with MCP tools integration.

#### 1. Health Check (With MCP)

```bash
curl -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -H "Accept: application/json" | jq '.'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "SAP Core AI",
  "destination": "SAP_AI_CORE_DEST",
  "model": "gpt-4o-mini",
  "timestamp": "2025-11-06T15:00:00.000Z"
}
```

**Note:** `mcpConnected: true` means agent can use MCP tools.

#### 2. Chat with MCP Tools

```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "What tools are available?"
  }' | jq '.'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#Edm.String",
  "value": "I have access to tools like 'GetProgram', 'GetClass', 'GetFunctionModule'..."
}
```

#### 3. Chat with Tool Execution

```bash
curl -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "List all ABAP classes in package Z_MY_PACKAGE"
  }' | jq '.'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#Edm.String",
  "value": "Here are the ABAP classes in package Z_MY_PACKAGE:\n1. ZCL_MY_CLASS\n2. ZCL_ANOTHER_CLASS\n..."
}
```

The agent will:
1. Receive user message
2. LLM decides to use MCP tool (e.g., `GetClass`)
3. Agent executes tool via MCP
4. Tool result is added as separate message (not user message!)
5. LLM processes tool result and generates final answer

## Quick Test Script

Create a test script for easy testing:

```bash
#!/bin/bash
# test/test-agent-btp.sh

BASE_URL="${BASE_URL:-https://your-app.cfapps.eu10.hana.ondemand.com}"
TOKEN="${TOKEN:-$(cf oauth-token)}"
AI_CORE_DEST="${SAP_CORE_AI_DESTINATION:-SAP_AI_CORE_DEST}"
MODEL="${SAP_CORE_AI_MODEL:-gpt-4o-mini}"
SAP_DEST="${SAP_DESTINATION:-}"

echo "🧪 Testing LLM Agent on BTP"
echo "================================"
echo "Base URL: $BASE_URL"
echo "AI Core Destination: $AI_CORE_DEST"
echo "Model: $MODEL"
echo ""

# Health Check
echo "1️⃣ Health Check..."
curl -s -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: $MODEL" \
  ${SAP_DEST:+-H "X-SAP-Destination: $SAP_DEST"} \
  -H "Accept: application/json" | jq '.' || echo "❌ Failed"
echo ""

# LLM Only Test
echo "2️⃣ Chat Test (LLM Only)..."
curl -s -X POST \
  "$BASE_URL/odata/v4/agent/Chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
  -H "X-SAP-Core-AI-Model: $MODEL" \
  -d '{"message": "Hello! Can you introduce yourself?"}' | jq '.' || echo "❌ Failed"
echo ""

# LLM + MCP Test (if SAP destination provided)
if [ -n "$SAP_DEST" ]; then
  echo "3️⃣ Chat Test (LLM + MCP)..."
  curl -s -X POST \
    "$BASE_URL/odata/v4/agent/Chat" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-SAP-Core-AI-Destination: $AI_CORE_DEST" \
    -H "X-SAP-Core-AI-Model: $MODEL" \
    -H "X-SAP-Destination: $SAP_DEST" \
    -d '{"message": "What tools are available?"}' | jq '.' || echo "❌ Failed"
  echo ""
fi

echo "✅ Test completed!"
```

**Usage:**
```bash
# Set variables
export BASE_URL="https://your-app.cfapps.eu10.hana.ondemand.com"
export SAP_CORE_AI_DESTINATION="SAP_AI_CORE_DEST"
export SAP_CORE_AI_MODEL="gpt-4o-mini"
export SAP_DESTINATION="SAP_DEV_DEST"  # Optional, for MCP testing

# Run script
bash test/test-agent-btp.sh
```

## Troubleshooting

### ❌ "SAP AI Core access is required"

**Solution:**
- **If using service binding (recommended):** Ensure SAP AI Core service is bound via mta.yaml. No additional configuration needed.
- **If using destination:** 
  - Set `SAP_CORE_AI_DESTINATION` environment variable in CF:
    ```bash
    cf set-env cloud-llm-hub-srv SAP_CORE_AI_DESTINATION SAP_AI_CORE_DEST
    cf restage cloud-llm-hub-srv
    ```
  - Or pass via header: `X-SAP-Core-AI-Destination: SAP_AI_CORE_DEST`
  - Configure destination in Destination service (BTP Cockpit) pointing to your AI Core instance

### ❌ "SAP AI Core API error"

**Solution:**
- Verify SAP AI Core destination is configured in Destination service
- Check destination URL points to correct AI Core instance
- Verify models are configured in SAP AI Core Launchpad
- Check AI Core service is bound to app: `cf services | grep ai-core`

### ❌ `mcpConnected: false` when expecting `true`

**Solution:**
- Verify SAP destination is configured (for MCP connection)
- Check MCP proxy is accessible: `curl $BASE_URL/odata/v4/mcp/Health()`
- Verify `X-SAP-Destination` header is provided
- Check CAP service logs for MCP connection errors

### ❌ "401 Unauthorized"

**Solution:**
- Get fresh XSUAA token: `cf oauth-token`
- Verify token is not expired
- Check XSUAA service is bound: `cf services | grep xsuaa`

## Environment Variables

After deployment, set these environment variables (all optional if using service binding):

```bash
# Optional: Only if using destination instead of service binding
cf set-env cloud-llm-hub-srv SAP_CORE_AI_DESTINATION SAP_AI_CORE_DEST

# Optional (can also be passed via headers)
cf set-env cloud-llm-hub-srv SAP_CORE_AI_MODEL gpt-4o-mini
cf set-env cloud-llm-hub-srv SAP_CORE_AI_TEMPERATURE 0.7
cf set-env cloud-llm-hub-srv SAP_CORE_AI_MAX_TOKENS 2000

# Restage to apply changes
cf restage cloud-llm-hub-srv
```

**Note:** If SAP AI Core service is bound via mta.yaml, you don't need to set `SAP_CORE_AI_DESTINATION`. The service binding is used automatically.

## Next Steps

- [LLM_AGENT_TESTING.md](LLM_AGENT_TESTING.md) - Complete testing guide
- [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) - Deployment checklist
- [AGENT_TEST_CHECKLIST.md](AGENT_TEST_CHECKLIST.md) - Test checklist

