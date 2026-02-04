# Task: LLM Proxy Development for Cloud LLM Hub

## 📋 Task Description

Develop and integrate LLM Proxy into Cloud LLM Hub that will:
- Accept messages from consumers through OData endpoints (or future UI)
- Work with LLM through SAP AI Core for message processing
- Orchestrate communication between LLM and MCP (LLM communicates with MCP through the agent)
- Enable LLM to use MCP tools for interaction with ABAP system

**Architecture Context:**
- `cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system
- `llm-agent` and `mcp-abap-adt` are peer components at the same level
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` is separated as a subsystem because different LLM models work differently with MCP

## 🎯 Goal

Create a fully functional LLM Proxy that:
1. ✅ Accepts messages through CAP OData service (or future UI)
2. ✅ Works with LLM through SAP AI Core (service binding)
3. ✅ Orchestrates communication between LLM and MCP (as a peer component to mcp-abap-adt)
4. ✅ Enables LLM to communicate with MCP tools through the agent
5. ✅ Provides conversation history and management
6. ✅ Has health check endpoint

**Role in System:**
- Acts as central orchestrator for LLM-MCP communication
- Separated as subsystem to support different LLM models that work differently with MCP

## 🏗️ Architecture

**System Integration:**
`cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system. `llm-agent` and `mcp-abap-adt` are peer components at the same level.

```
┌─────────────────────────────────────────────────────────────┐
│              Cloud LLM Hub (Integration Platform)          │
│                                                             │
│  Consumer (UI/OData)                                        │
│      ↓                                                      │
│  Agent Service (CAP OData)                                  │
│      ↓                                                      │
│  Agent Manager (creates/caches agents)                      │
│      ↓                                                      │
│  ┌─────────────────┬─────────────────┐                     │
│  │  LLM Provider   │   MCP Client    │                     │
│  │ (SAP AI Core)   │  (MCP Proxy)    │                     │
│  └────────┬────────┴────────┬─────────┘                     │
│           │                  │                               │
│           │                  │                               │
│     ┌─────▼──────────────────▼─────┐                       │
│     │   SAP AI Core Service        │                       │
│     │   (via service binding)      │                       │
│     └──────────────┬───────────────┘                       │
│                    │                                         │
│     ┌──────────────┼───────────────┐                       │
│     │              │               │                       │
│     │    ┌─────────▼─────────┐     │                       │
│     │    │   MCP Proxy       │     │                       │
│     │    │   (CAP Service)   │     │                       │
│     │    └─────────┬─────────┘     │                       │
│     │              │               │                       │
│     │    ┌─────────▼─────────┐     │                       │
│     │    │  mcp-abap-adt     │     │                       │
│     │    │  (embedded)        │     │                       │
│     │    └─────────┬─────────┘     │                       │
│     └──────────────┼───────────────┘                       │
│                    │                                         │
│     ┌──────────────▼───────────────┐                       │
│     │   SAP ABAP System            │                       │
│     │   (via destination)          │                       │
│     └──────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

**Key Points:**
- `llm-agent` and `mcp-abap-adt` are peer components (same level)
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` acts as the central orchestrator for LLM-MCP communication

## 📝 Technical Requirements

### 1. OData Endpoints

The service must provide the following endpoints:

#### `POST /odata/v4/agent/Chat`
Send message to agent.

**Request:**
```json
{
  "message": "What ABAP classes are available?"
}
```

**Response:**
```json
{
  "@odata.context": "$metadata#Edm.String",
  "value": "Based on the available tools, I can help you find ABAP classes..."
}
```

**Processing:**
- Validate input message
- Get agent via `agent-manager.getAgent()`
- Call `agent.process(message)`
- Return response or error

#### `GET /odata/v4/agent/GetHistory()`
Get conversation history.

**Response:**
```json
{
  "@odata.context": "$metadata#ChatMessage",
  "value": [
    {
      "role": "user",
      "content": "What tools are available?",
      "timestamp": "2025-01-15T10:00:00.000Z"
    },
    {
      "role": "assistant",
      "content": "I have access to tools like...",
      "timestamp": "2025-01-15T10:00:01.000Z"
    }
  ]
}
```

#### `POST /odata/v4/agent/ClearHistory`
Clear conversation history.

**Response:**
```json
{
  "@odata.context": "$metadata#ClearHistoryResult",
  "success": true,
  "message": "Conversation history cleared successfully"
}
```

#### `GET /odata/v4/agent/Health()`
Service health check.

**Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "SAP Core AI",
  "llmDestination": "cloud-llm-hub-ai-core",
  "model": "gpt-4o-mini",
  "mcpDestination": "SAP_DEV_DEST",
  "timestamp": "2025-01-15T10:00:00.000Z"
}
```

### 2. LLM Integration

**Requirements:**
- Use SAP AI Core through service binding
- Service binding is named `cloud-llm-hub-ai-core` (from mta.yaml)
- Support different models through configuration
- Configuration via environment variables:
  - `LLM_AGENT_MODEL` - model (gpt-4o-mini, claude-3-5-sonnet, etc.)
  - `LLM_AGENT_TEMPERATURE` - temperature (default: 0.7)
  - `LLM_AGENT_MAX_TOKENS` - max tokens (default: 2000)

**Implementation:**
- Use `SapCoreAIProvider` from `node_modules/@mcp-abap-adt/llm-proxy`
- Create provider in `agent-manager.ts`
- Get service binding from `VCAP_SERVICES`

### 3. MCP Integration

**Requirements:**
- Connect to MCP Proxy (which embeds `mcp-abap-adt`) via HTTP transport
- Orchestrate communication between LLM and MCP (LLM communicates with MCP through the agent)
- Use same destination as MCP Proxy
- Automatic detection of available tools
- Fallback to LLM-only mode if MCP unavailable

**Implementation:**
- Use `MCPClientWrapper` from `node_modules/@mcp-abap-adt/llm-proxy`
- Endpoint: `http://localhost:4004/mcp/stream/http` (locally)
- Endpoint: auto-detect from request headers (on BTP)
- Pass destination via `X-SAP-Destination` header
- Agent acts as orchestrator: LLM → Agent → MCP Proxy → mcp-abap-adt → ABAP System

### 4. Configuration

**Environment Variables:**
```bash
# LLM Configuration
LLM_AGENT_MODEL=gpt-4o-mini
LLM_AGENT_TEMPERATURE=0.7
LLM_AGENT_MAX_TOKENS=2000

# MCP Configuration
LLM_AGENT_MCP_DESTINATION=SAP_DEV_DEST
LLM_AGENT_MCP_ENDPOINT=http://localhost:4004/mcp/stream/http  # optional
```

**Service Binding:**
- SAP AI Core service binding via `mta.yaml`
- Resource name: `cloud-llm-hub-ai-core`
- Access via `VCAP_SERVICES`

### 5. Caching

**Requirements:**
- Cache agents by configuration
- TTL: 30 minutes
- Conversation history stored in cached agent
- Cache key: `agent:config:${mcpDestination}:${model}`

## 📁 Files to Work With

### Main Files

1. **`srv/agent-service.ts`** - CAP service handlers
   - Register handlers for OData endpoints
   - Validate input data
   - Handle errors

2. **`srv/agent-manager.ts`** - Agent instance management
   - Create agents
   - Cache agents
   - Create LLM provider
   - Create MCP client

3. **`srv/agent-config.ts`** - Configuration loading
   - Load configuration from env vars
   - Get SAP AI Core service binding
   - Validate configuration

4. **`srv/agent-service.cds`** - OData service definition
   - Define service and types
   - Define functions and actions

### llm-agent Module

5. **`node_modules/@mcp-abap-adt/llm-proxy/src/agents/sap-core-ai-agent.ts`** - SAP AI Core agent
6. **`node_modules/@mcp-abap-adt/llm-proxy/src/llm-providers/sap-core-ai.ts`** - SAP AI Core provider
7. **`node_modules/@mcp-abap-adt/llm-proxy/src/mcp/client.ts`** - MCP client wrapper

## ✅ Acceptance Criteria

### Functionality

- [ ] `POST /odata/v4/agent/Chat` works correctly
- [ ] `GET /odata/v4/agent/GetHistory()` returns history
- [ ] `POST /odata/v4/agent/ClearHistory` clears history
- [ ] `GET /odata/v4/agent/Health()` shows correct status
- [ ] LLM integration works through SAP AI Core
- [ ] MCP integration works (ability to call tools)
- [ ] Caching works correctly
- [ ] Fallback to LLM-only mode works

### Code Quality

- [ ] Code follows code style guide
- [ ] All functions have JSDoc comments
- [ ] Error handling is correct
- [ ] Logging is sufficient for debugging
- [ ] No console.log (use cds.log)

### Testing

- [ ] Health endpoint tested
- [ ] Chat endpoint tested (LLM only)
- [ ] Chat endpoint tested (with MCP)
- [ ] GetHistory tested
- [ ] ClearHistory tested
- [ ] Error handling tested

### Documentation

- [ ] Code has comments
- [ ] API endpoints documented
- [ ] Configuration documented
- [ ] Troubleshooting guide updated

## 🚀 Execution Plan

### Step 1: Current State Verification (1 day)

1. Verify all files exist
2. Verify CAP automatically loads agent-service
3. Run service locally
4. Test basic functionality

### Step 2: Completion and Fixes (2-3 days)

1. Add explicit agent-service registration if needed
2. Fix identified bugs
3. Improve error handling
4. Add logging

### Step 3: Testing (1-2 days)

1. Write unit tests
2. Write integration tests
3. Test with real SAP AI Core
4. Test with real MCP Proxy

### Step 4: Documentation (1 day)

1. Update API reference
2. Update deployment guide
3. Update troubleshooting guide
4. Add code comments

## 🧪 Testing

### Local Testing

```bash
# 1. Start service
cds watch --profile development

# 2. Health check
curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"

# 3. Chat (LLM only)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'

# 4. Chat (with MCP)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{"message": "What tools are available?"}'

# 5. Get History
curl -X GET "http://localhost:4004/odata/v4/agent/GetHistory()" \
  -H "Authorization: Basic YWxpY2U6"

# 6. Clear History
curl -X POST "http://localhost:4004/odata/v4/agent/ClearHistory" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json"
```

### Using Test Script

```bash
# From project root
bash test/test-agent.sh
```

## 🐛 Troubleshooting

### Issue: Agent service not registered

**Solution:**
- Check if `srv/agent-service.ts` file exists
- Check if CAP automatically loads services
- Add explicit registration in `srv/server.ts` if needed

### Issue: SAP AI Core service binding not found

**Solution:**
- Check `mta.yaml` - is resource `cloud-llm-hub-ai-core` present
- Check `VCAP_SERVICES` - is service binding present
- Check service name in `agent-config.ts`

### Issue: MCP connection failed

**Solution:**
- Check if MCP Proxy is running: `GET /odata/v4/mcp/Health()`
- Check if destination is configured
- Check if endpoint is correct
- Check logs for error details

### Issue: LLM not responding

**Solution:**
- Check if model is configured in SAP AI Core
- Check if API key is correct (if used)
- Check logs for error details
- Check if service binding has correct credentials

## 📚 Additional Resources

- [LLM Proxy Roadmap](ROADMAP.md) - detailed roadmap
- [LLM Proxy Testing Guide](../LLM_PROXY_TESTING.md) - testing guide
- [LLM Proxy Embedded Usage](../LLM_PROXY_EMBEDDED_USAGE.md) - usage examples
- [LLM Proxy Config Usage](../LLM_PROXY_CONFIG_USAGE.md) - configuration

## 📞 Questions?

If you have questions:
1. Check documentation in `docs/llm-proxy/*.md`
2. Check code in `srv/agent-*.ts`
3. Check examples in `test/test-agent.sh`
4. Contact the team for clarifications
