# Checklist: Testing LLM Agent

## ✅ Before Testing

### 1. Install Dependencies

```bash
# From project root
npm install

# Build llm-agent submodule
cd submodules/llm-agent
npm install
npm run build
cd ../..
```

### 2. Configure Environment Variables

**Option A: Using .env file (recommended)**

```bash
# Copy .env from agent (this is the agent's .env file)
cp submodules/llm-agent/.env .env

# Edit .env and ensure LLM_PROVIDER is set
nano .env
```

**Important:** The `.env` file in project root (`cloud-llm-hub/.env`) is **the same as the agent's .env** (`submodules/llm-agent/.env`). Copy it from agent: `cp submodules/llm-agent/.env .env`

**Option B: Export environment variables**

**Required:**
```bash
# LLM provider must be explicitly set
export LLM_PROVIDER="openai"
export OPENAI_API_KEY="sk-your-openai-api-key-here"
```

**Optional:**
```bash
# If MCP endpoint is not on localhost:4004
export MCP_ENDPOINT="http://your-host:port/mcp/stream/http"

# If you want to use a different OpenAI model
export OPENAI_MODEL="gpt-4o-mini"  # or gpt-4, gpt-3.5-turbo, etc.
```

### 3. Verify MCP Proxy is Running

MCP Proxy starts automatically with CAP service, but you can verify:

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/mcp/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

Expected: `{"status":"UP",...}`

### 4. Start CAP Service

```bash
cds watch --profile development
```

The service will be available at `http://localhost:4004`

## 🧪 Testing

### Quick Test (Ready Script)

```bash
# From project root
bash test/test-agent.sh
```

### Manual Testing

#### 1. Health Check

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

**Expected:**
```json
{
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "OpenAI",
  "timestamp": "..."
}
```

#### 2. Simple Chat (without SAP)

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6"
```

#### 3. Chat with SAP Destination

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='What tools are available?')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

#### 4. Chat with Direct SAP Parameters (without Destination)

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Chat(message='Hello')" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-URL: https://your-sap-system.example.com" \
  -H "X-SAP-Auth-Type: jwt" \
  -H "X-SAP-JWT-Token: your-jwt-token"
```

#### 5. Get History

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/GetHistory()" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

#### 6. Clear History

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/ClearHistory" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST"
```

## 🔍 What to Check

### Successful Testing Means:

1. ✅ Health check returns `status: "READY"`
2. ✅ `agentReady: true` - agent created
3. ✅ `mcpConnected: true` - agent connected to MCP
4. ✅ Chat returns response from LLM
5. ✅ History persists between requests
6. ✅ ClearHistory clears history

### Common Errors:

#### ❌ "LLM provider must be explicitly specified" or "OPENAI_API_KEY is required"
**Solution:** 
- Set `LLM_PROVIDER=openai` in `.env` file (copy from agent: `cp submodules/llm-agent/.env .env`)
- Or export: `export LLM_PROVIDER="openai"` and `export OPENAI_API_KEY="sk-..."`

#### ❌ "MCP client configuration required"
**Solution:** Verify MCP proxy is running (`/odata/v4/mcp/Health()`)

#### ❌ "Connection failed" or `mcpConnected: false`
**Solution:** 
- Verify CAP service is running
- Verify MCP proxy endpoint is accessible
- Check CAP service logs

#### ❌ Agent returns empty response
**Solution:**
- Verify OpenAI API key is valid
- Verify model is available (gpt-4o-mini by default)
- Check logs for errors

## 📝 Notes

1. **Destination vs Direct:** 
   - Use `X-SAP-Destination` for destination mode
   - Use `X-SAP-URL`, `X-SAP-Auth-Type`, etc. for direct mode

2. **Caching:**
   - Agent is cached by destination/config
   - History is stored in cached agent
   - Different destinations = different agents = different histories

3. **MCP Proxy:**
   - Starts automatically with CAP
   - Endpoint: `http://localhost:4004/mcp/stream/http`
   - Processes headers and creates embedded MCP server

## 🚀 Ready to Test!

If all items are completed, you can test:

```bash
# 1. Set OpenAI key
export OPENAI_API_KEY="sk-..."

# 2. Start service (in one terminal)
cds watch --profile development

# 3. Run tests (in another terminal)
bash test/test-agent.sh
```
