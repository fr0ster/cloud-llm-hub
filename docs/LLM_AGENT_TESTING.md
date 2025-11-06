# LLM Agent Testing Guide

## Prerequisites

To test the LLM agent in `cloud-llm-hub`, you need:

1. **OpenAI API Key** - Required for LLM provider
2. **Running cloud-llm-hub** - CAP service must be running
3. **MCP Proxy accessible** - Agent connects to MCP proxy endpoint (runs with CAP)
4. **SAP Configuration** - Either destination or direct SAP connection (passed via headers)

**Important Architecture Note:**
- Agent doesn't know about SAP destinations - it only works with MCP client
- `cloud-llm-hub` wrapper (`agent-manager.ts`) extracts SAP config from request headers
- Wrapper creates MCP client with proper headers and passes it to agent
- Agent is agnostic to SAP - it just works with MCP

## LLM Provider Configuration

API keys can be provided in three ways, depending on your environment:

### Option 1: HTTP Headers (Runtime Override)

Pass API keys via HTTP headers in each request (works for both local and BTP):

```bash
# OpenAI
X-OpenAI-API-Key: sk-proj-your-key-here
X-OpenAI-Model: gpt-4o-mini (optional)
X-OpenAI-Org: org-your-org-id (optional)
X-OpenAI-Project: proj-your-project-id (optional)

# Anthropic
X-Anthropic-API-Key: sk-ant-your-key-here
X-LLM-Provider: anthropic
X-Anthropic-Model: claude-3-5-sonnet-20241022 (optional)

# DeepSeek
X-DeepSeek-API-Key: sk-your-key-here
X-LLM-Provider: deepseek
X-DeepSeek-Model: deepseek-chat (optional)
```

### Option 2: Local Development (.env file)

For local development, create a `.env` file in the **project root** (`cloud-llm-hub/.env`):

```bash
# Option 1: Copy from agent's .env (recommended - if you already have it configured)
cp submodules/llm-agent/.env .env

# Option 2: Copy template (if starting fresh)
cp .env.template .env

# Edit .env with your API keys
nano .env  # or use your favorite editor
```

**Important:** 
- `.env` file location: `cloud-llm-hub/.env` (project root)
- **This `.env` file is from the agent** - it's the same configuration used by `submodules/llm-agent/.env`
- The agent's `.env` file (`submodules/llm-agent/.env`) is used for standalone agent testing
- The root `.env` file (`cloud-llm-hub/.env`) is used by cloud-llm-hub service for local development
- **Both files should have the same content** - you can copy from agent to root: `cp submodules/llm-agent/.env .env`

Example `.env` file (in project root - same as agent's .env):
```env
# OpenAI Configuration
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_MODEL=gpt-4o-mini
OPENAI_ORG=org-your-org-id
OPENAI_PROJECT=proj-your-project-id

# Anthropic (Claude) Configuration
ANTHROPIC_API_KEY=sk-ant-your-key-here
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# DeepSeek Configuration
DEEPSEEK_API_KEY=sk-your-key-here
DEEPSEEK_MODEL=deepseek-chat

# LLM Provider Selection
LLM_PROVIDER=openai
```

The `.env` file is automatically loaded when running locally (not in BTP).

**File Locations:**
- `cloud-llm-hub/.env` - **This is the agent's .env file** (copied from `submodules/llm-agent/.env`)
  - Used by `srv/env-setup.ts` for cloud-llm-hub service local development
  - Used by `tools/set-btp-env.js` for BTP deployment script
  - **Same content as agent's .env** - copy with: `cp submodules/llm-agent/.env .env`
- `submodules/llm-agent/.env` - Original agent's .env file
  - Used by `submodules/llm-agent/src/cli.ts` for standalone agent testing
  - **Copy this to root for cloud-llm-hub**: `cp submodules/llm-agent/.env .env`

### Option 3: BTP Deployment (Environment Variables)

For BTP deployment, set environment variables after deployment:

**Option A: Using npm script with .env file (recommended - no export needed):**
```bash
# 1. Create .env file with your API keys (see Option 2 above)
# 2. Run the script - it reads from .env automatically
npm run deploy:set-env
```

**Option B: Using npm script with exported variables:**
```bash
# Export variables first
export OPENAI_API_KEY="sk-proj-your-key-here"
export OPENAI_MODEL="gpt-4o-mini"

# Run script
npm run deploy:set-env
```

**Option C: Direct CF CLI (if you prefer):**
```bash
# Export variables
export OPENAI_API_KEY="sk-proj-your-key-here"
export OPENAI_MODEL="gpt-4o-mini"

# Set in CF directly
cf set-env cloud-llm-hub-srv OPENAI_API_KEY "$OPENAI_API_KEY"
cf set-env cloud-llm-hub-srv OPENAI_MODEL "$OPENAI_MODEL"
cf set-env cloud-llm-hub-srv OPENAI_ORG "$OPENAI_ORG"  # if set
cf set-env cloud-llm-hub-srv OPENAI_PROJECT "$OPENAI_PROJECT"  # if set
cf restage cloud-llm-hub-srv
```

**Why use the script?**
- ✅ Reads from `.env` file automatically (no need to export)
- ✅ Sets all variables at once
- ✅ Validates CF CLI and app existence
- ✅ Automatically restages the app
- ✅ Shows masked values for security

**Important Security Note:**
- ❌ **DO NOT** store API keys in `mta.yaml` (they would be committed to version control)
- ✅ **DO** set them via CF CLI after deployment
- ✅ **DO** use the `npm run deploy:set-env` script for convenience

**Priority Order:**
1. HTTP headers (highest priority - runtime override)
2. Environment variables (set via CF CLI or .env file)
3. Error if none provided

## Starting the Service

```bash
# Install dependencies (if not done)
npm install

# Build llm-agent submodule
cd submodules/llm-agent && npm install && npm run build && cd ../..

# Start CAP service
cds watch --profile development
```

The service will be available at `http://localhost:4004`.

## Testing with curl

### 1. Health Check

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "OpenAI",
  "timestamp": "2025-11-06T15:00:00.000Z"
}
```

### 2. Chat with Agent

**Using GET (with API key in header):**

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='What tools are available?')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-OpenAI-API-Key: sk-proj-your-key-here" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

**Or using POST (for longer messages):**

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-OpenAI-API-Key: sk-proj-your-key-here" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "What ABAP classes are available in the system?"
  }'
```

**With Anthropic:**

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-Anthropic-API-Key: sk-ant-your-key-here" \
  -H "X-LLM-Provider: anthropic" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "What tools are available?"
  }'
```

**With DeepSeek:**

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-DeepSeek-API-Key: sk-your-key-here" \
  -H "X-LLM-Provider: deepseek" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "What tools are available?"
  }'
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#Edm.String",
  "value": "Based on the available tools, I can help you find ABAP classes..."
}
```

### 3. Get Conversation History

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/GetHistory()" \
  -H "Authorization: Basic YWxpY2U6"
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#ChatMessage",
  "value": [
    {
      "role": "user",
      "content": "What tools are available?",
      "timestamp": "2025-11-06T15:00:00.000Z"
    },
    {
      "role": "assistant",
      "content": "Based on the available tools...",
      "timestamp": "2025-11-06T15:00:01.000Z"
    }
  ]
}
```

### 4. Clear History

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/ClearHistory" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#ClearHistoryResult",
  "success": true,
  "message": "Conversation history cleared successfully"
}
```

## Testing with Postman

### Setup

1. **Create a new request**
2. **Set URL:** `http://localhost:4004/odata/v4/agent/Chat`
3. **Method:** GET or POST
4. **Headers:**
   - `Authorization: Basic YWxpY2U6`
   - `X-SAP-Destination: SAP_DEV_DEST` (if using destination mode)
   - `Content-Type: application/json` (for POST)

### GET Request Example

**URL:**
```
http://localhost:4004/odata/v4/agent/Chat(message='Hello, what can you do?')
```

**Headers:**
```
Authorization: Basic YWxpY2U6
X-SAP-Destination: SAP_DEV_DEST
```

### POST Request Example

**URL:**
```
http://localhost:4004/odata/v4/agent/Chat
```

**Headers:**
```
Authorization: Basic YWxpY2U6
Content-Type: application/json
X-SAP-Destination: SAP_DEV_DEST
```

**Body (JSON):**
```json
{
  "message": "List all available ABAP tools and explain what they do"
}
```

## Testing Scenarios

### Scenario 1: Basic Chat

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

### Scenario 2: Query Available Tools

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='What MCP tools are available?')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

### Scenario 3: Complex Query

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "message": "Can you help me find all ABAP classes that contain the word 'Customer' in their name?"
  }'
```

## Troubleshooting

### Error: "OPENAI_API_KEY environment variable is required"

**Solution:** Set the environment variable:
```bash
export OPENAI_API_KEY="sk-your-key-here"
```

### Error: "MCP client configuration required"

**Solution:** Ensure MCP endpoint is accessible and headers are correct. Check:
- MCP proxy is running
- Endpoint URL is correct
- Authentication headers are valid

### Error: "Connection failed" or "MCP server not ready"

**Solution:**
1. Check MCP proxy health: `GET /odata/v4/mcp/Health()`
2. Verify SAP destination is configured correctly
3. Check MCP proxy logs for connection errors

### Agent returns empty response

**Possible causes:**
1. LLM API key is invalid
2. MCP tools are not accessible
3. Network connectivity issues

**Debug steps:**
1. Check agent health: `GET /odata/v4/agent/Health()`
2. Verify MCP connection: Check `mcpConnected` in health response
3. Check CAP service logs for errors

## Quick Test Script

A test script is available at `test/test-agent.sh`:

```bash
# Make it executable (if not already)
chmod +x test/test-agent.sh

# Run from project root
bash test/test-agent.sh

# Or from test directory
cd test
./test-agent.sh
```

## Expected Behavior

1. **First request:** Agent initializes, connects to MCP proxy, gets tools list
2. **Subsequent requests:** Agent reuses connection, processes messages faster
3. **History:** Maintains conversation context across requests
4. **Errors:** Returns descriptive error messages

## Next Steps

After basic testing works:
1. Test with different LLM models
2. Test with different SAP destinations
3. Test conversation context (multi-turn conversations)
4. Test error handling (invalid destinations, network issues)

