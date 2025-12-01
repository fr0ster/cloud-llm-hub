# LLM Agent - Developer Guide

## 🎯 Quick Start

### 1. Environment Setup

```bash
# Clone repository (if not done)
git clone <repo-url>
cd cloud-llm-hub

# Install dependencies
npm install

# Build llm-agent submodule
cd submodules/llm-agent
npm install
npm run build
cd ../..
```

### 2. Configuration

**Local Development:**

Create `.env` file in project root:

```bash
# Copy from agent submodule (if already configured)
cp submodules/llm-agent/.env .env

# Or create new
cat > .env << EOF
# LLM Configuration (via SAP AI Core)
# On BTP service binding is used, here for local development
LLM_AGENT_MODEL=gpt-4o-mini
LLM_AGENT_TEMPERATURE=0.7
LLM_AGENT_MAX_TOKENS=2000

# MCP Configuration
LLM_AGENT_MCP_DESTINATION=SAP_DEV_DEST
LLM_AGENT_MCP_ENDPOINT=http://localhost:4004/mcp/stream/http
EOF
```

**Important:** On BTP, configuration is loaded from environment variables set via `mta.yaml` or CF CLI.

### 3. Run

```bash
# Start CAP service
cds watch --profile development
```

Service will be available at `http://localhost:4004`

### 4. Testing

```bash
# Health check
curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6" | jq

# Chat (LLM only)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! Can you introduce yourself?"}' | jq

# Chat (with MCP)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{"message": "What tools are available?"}' | jq

# Or use ready script
bash test/test-agent.sh
```

## 📁 Project Structure

```
cloud-llm-hub/
├── srv/
│   ├── agent-service.cds          # OData service definition
│   ├── agent-service.ts           # CAP service handlers ⭐
│   ├── agent-manager.ts            # Agent instance management ⭐
│   └── agent-config.ts             # Configuration loading ⭐
│
├── submodules/
│   └── llm-agent/                  # LLM Agent module
│       ├── src/
│       │   ├── agents/
│       │   │   └── sap-core-ai-agent.ts
│       │   ├── llm-providers/
│       │   │   └── sap-core-ai.ts
│       │   └── mcp/
│       │       └── client.ts
│       └── package.json
│
└── docs/
    └── llm-agent/
        ├── ROADMAP.md              # Detailed roadmap
        ├── TASK.md                 # Task description
        └── README.md               # This file
```

## 🔧 Key Files to Work With

### 1. `srv/agent-service.ts` - CAP Service Handlers

**What it does:**
- Registers OData endpoints (Chat, GetHistory, ClearHistory, Health)
- Validates input data
- Handles errors
- Calls agent-manager to get agent

**Key Functions:**
- `srv.on('Chat', ...)` - message processing
- `srv.on('GetHistory', ...)` - get history
- `srv.on('ClearHistory', ...)` - clear history
- `srv.on('Health', ...)` - health check

**Example:**
```typescript
srv.on('Chat', async (req: Request) => {
  const message = req.data.message as string;
  const agent = await getAgent(req);
  const response = await agent.process(message);
  return response.message;
});
```

### 2. `srv/agent-manager.ts` - Agent Management

**What it does:**
- Creates and caches agents
- Creates LLM provider through SAP AI Core
- Creates MCP client to connect to MCP Proxy
- Manages agent lifecycle

**Key Functions:**
- `getAgent(req)` - get/create agent
- `createLLMProvider(config)` - create LLM provider
- `buildMCPConfig(config, req)` - build MCP configuration
- `clearAgentCache()` - clear cache

**Example:**
```typescript
const agent = await getAgent(req);
// Agent is automatically connected to MCP and LLM
```

### 3. `srv/agent-config.ts` - Configuration

**What it does:**
- Loads configuration from environment variables
- Gets SAP AI Core service binding from VCAP_SERVICES
- Validates configuration

**Key Functions:**
- `getAgentConfig()` - get configuration
- `loadAgentConfig()` - load configuration
- `getAICoreServiceBinding()` - get service binding

**Environment Variables:**
- `LLM_AGENT_MODEL` - LLM model
- `LLM_AGENT_TEMPERATURE` - temperature
- `LLM_AGENT_MAX_TOKENS` - max tokens
- `LLM_AGENT_MCP_DESTINATION` - MCP destination

## 🔄 Data Flow Architecture

```
1. Consumer (UI/OData) → POST /odata/v4/agent/Chat
   ↓
2. agent-service.ts → validation → getAgent(req)
   ↓
3. agent-manager.ts → load configuration
   ↓
4. Create LLM Provider (SAP AI Core)
   ↓
5. Create MCP Client (MCP Proxy)
   ↓
6. Create Agent (SapCoreAIAgent)
   ↓
7. agent.process(message)
   ↓
8. LLM processes message + calls MCP tools
   ↓
9. Return response
```

## 🧪 Testing

### Unit Tests

```bash
# Run unit tests (if available)
npm run test:unit
```

### Integration Tests

```bash
# Run integration tests
npm test
```

### Manual Testing

```bash
# Use ready script
bash test/test-agent.sh

# Or manually via curl (see above)
```

## 🐛 Debugging

### Logging

Use `cds.log()` for logging:

```typescript
const log = cds.log('agent-service');
log.info('Message', { data });
log.debug('Debug info', { data });
log.warn('Warning', { data });
log.error('Error', { error });
```

### Health Check

Check status via health endpoint:

```bash
curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6" | jq
```

Expected result:
```json
{
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "SAP Core AI",
  "model": "gpt-4o-mini",
  "mcpDestination": "SAP_DEV_DEST"
}
```

### Common Issues

**Issue:** Agent service not registered

**Solution:**
- CAP automatically loads files named `service-name.ts`
- Check if `srv/agent-service.ts` file exists
- Check logs on startup - should see "Registering AgentService handlers"

**Issue:** SAP AI Core service binding not found

**Solution:**
- Check `mta.yaml` - is resource `cloud-llm-hub-ai-core` present
- Check `VCAP_SERVICES` - is service binding present
- Check service name in `agent-config.ts` (default: `aicore` or `ai-core`)

**Issue:** MCP connection failed

**Solution:**
- Check if MCP Proxy is running: `GET /odata/v4/mcp/Health()`
- Check if destination is configured
- Check logs for error details
- Agent works in LLM-only mode if MCP unavailable

## 📚 Additional Resources

- [LLM Agent Roadmap](ROADMAP.md) - detailed development roadmap
- [LLM Agent Task](TASK.md) - task description and acceptance criteria
- [LLM Agent Testing Guide](../LLM_AGENT_TESTING.md) - testing guide
- [LLM Agent Embedded Usage](../LLM_AGENT_EMBEDDED_USAGE.md) - usage examples
- [LLM Agent Config Usage](../LLM_AGENT_CONFIG_USAGE.md) - configuration

## ✅ Completion Checklist

- [ ] All OData endpoints work
- [ ] LLM integration works through SAP AI Core
- [ ] MCP integration works
- [ ] Caching works correctly
- [ ] Health endpoint shows correct status
- [ ] Error handling works
- [ ] Logging is sufficient
- [ ] Unit tests written
- [ ] Integration tests written
- [ ] Documentation updated
- [ ] Code review passed

## 📞 Questions?

If you have questions:
1. Check documentation in `docs/llm-agent/*.md`
2. Check code in `srv/agent-*.ts`
3. Check examples in `test/test-agent.sh`
4. Contact the team for clarifications

