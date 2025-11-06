# Quick Start: Testing LLM Agent

## Quick Start

### 1. Install Dependencies

```bash
# Install main project dependencies
npm install

# Build llm-agent submodule
cd submodules/llm-agent
npm install
npm run build
cd ../..
```

### 2. Configure Environment Variables

**Option A: Using .env file (recommended for local development)**

```bash
# Copy .env from agent (if you already configured it)
cp submodules/llm-agent/.env .env

# Or create from template
cp .env.template .env

# Edit .env and add your API keys
nano .env
```

**Important:** The `.env` file in project root (`cloud-llm-hub/.env`) is **the same as the agent's .env** (`submodules/llm-agent/.env`). Copy it from agent: `cp submodules/llm-agent/.env .env`

**Option B: Export environment variables**

```bash
# Required: LLM provider (must be explicitly set)
export LLM_PROVIDER="openai"

# Required: OpenAI API key
export OPENAI_API_KEY="sk-your-key-here"

# Optional: MCP endpoint (defaults to http://localhost:4004/mcp/stream/http)
export MCP_ENDPOINT="http://localhost:4004/mcp/stream/http"

# Optional: SAP destination (can also be passed via header)
export SAP_DESTINATION="SAP_DEV_DEST"
```

### 3. Start the Service

```bash
cds watch --profile development
```

The service will be available at `http://localhost:4004`.

### 4. Test

#### Option 1: Use the Ready Script

```bash
# From project root
bash test/test-agent.sh

# Or from test directory
cd test
./test-agent.sh
```

#### Option 2: Manual curl

```bash
# Health check
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"

# Chat (with SAP destination)
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"

# Note: Agent doesn't know about destination - cloud-llm-hub wrapper handles it
```

#### Option 3: Postman

1. Create a new request
2. URL: `http://localhost:4004/odata/v4/agent/Chat(message='Hello')`
3. Method: GET
4. Headers:
   - `Authorization: Basic YWxpY2U6`
   - `X-SAP-Destination: SAP_DEV_DEST`

## What You Need for Testing

✅ **Required:**
- OpenAI API key (`OPENAI_API_KEY`)
- Running CAP service (`cds watch`)
- Accessible MCP proxy endpoint

✅ **Recommended:**
- Configured SAP destination or direct SAP parameters
- `jq` for JSON response formatting

## Available Endpoints

- `GET /odata/v4/agent/Health()` - check agent status
- `GET /odata/v4/agent/Chat(message='...')` - send message
- `GET /odata/v4/agent/GetHistory()` - get conversation history
- `POST /odata/v4/agent/ClearHistory` - clear history

## Detailed Documentation

- [LLM_AGENT_TESTING.md](LLM_AGENT_TESTING.md) - complete testing guide
- [LLM_AGENT_EMBEDDED_USAGE.md](LLM_AGENT_EMBEDDED_USAGE.md) - embedded usage
- [LLM_AGENT_CONFIG_USAGE.md](LLM_AGENT_CONFIG_USAGE.md) - configuration
