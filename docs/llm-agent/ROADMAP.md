# LLM Proxy Development Roadmap

## 🎯 Goal

Develop LLM Proxy as a separate module that:
- Accepts messages from consumers (UI or OData endpoints)
- Works with LLM through SAP AI Core
- Acts as an orchestrator between LLM and MCP (embedded mcp-abap-adt)
- Enables LLM to communicate with MCP tools through the agent

**Important:** `llm-agent` and `mcp-abap-adt` are peer components at the same level. `cloud-llm-hub` integrates both into a unified system. Almost all interactions between system components go through `llm-agent`.

## 📋 Current Status

### ✅ What's Already Done

1. **Basic llm-agent module** (`node_modules/@mcp-abap-adt/llm-agent/`)
   - ✅ Project structure
   - ✅ SAP Core AI Provider
   - ✅ MCP Client Wrapper
   - ✅ Base Agent and SapCoreAIAgent
   - ✅ Support for different transports (stdio, SSE, stream-http)

2. **Integration into cloud-llm-hub**
   - ✅ `srv/agent-service.cds` - OData service definition
   - ✅ `srv/agent-service.ts` - CAP service handlers
   - ✅ `srv/agent-manager.ts` - Agent instance management
   - ✅ `srv/agent-config.ts` - Configuration loading
   - ✅ Endpoints: Chat, GetHistory, ClearHistory, Health

3. **Configuration**
   - ✅ Environment variables support
   - ✅ SAP AI Core service binding integration
   - ✅ MCP destination configuration

### ⚠️ What Needs to be Done

1. **Service Registration**
   - ⚠️ Verify automatic registration of agent-service in CAP
   - ⚠️ Add explicit registration if needed

2. **Testing**
   - ⚠️ Unit tests for agent-manager
   - ⚠️ Integration tests for OData endpoints
   - ⚠️ E2E tests with real SAP AI Core

3. **Documentation**
   - ⚠️ API reference for developers
   - ⚠️ Deployment guide
   - ⚠️ Troubleshooting guide

## 🏗️ Architecture

**System Overview:**
`cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system. `llm-agent` and `mcp-abap-adt` are peer components at the same level. LLM communicates with MCP through `llm-agent`, making `llm-agent` the central orchestrator for most system interactions.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Cloud LLM Hub (Integration Platform)              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Consumer Layer                            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │  │
│  │  │   UI (Future) │  │ OData Endpoint│  │  Other APIs  │      │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │  │
│  └─────────┼──────────────────┼──────────────────┼──────────────┘  │
│            │                  │                  │                  │
│            └──────────────────┼──────────────────┘                  │
│                               │                                     │
│            ┌──────────────────▼──────────────────┐                 │
│            │      Agent Service (CAP)             │                 │
│            │  ┌──────────────────────────────┐   │                 │
│            │  │  agent-service.ts             │   │                 │
│            │  │  - Chat()                      │   │                 │
│            │  │  - GetHistory()                │   │                 │
│            │  │  - ClearHistory()              │   │                 │
│            │  │  - Health()                    │   │                 │
│            │  └──────────────┬─────────────────┘   │                 │
│            └─────────────────┼─────────────────────┘                 │
│                              │                                       │
│            ┌─────────────────▼─────────────────────┐                │
│            │      Agent Manager                      │                │
│            │  ┌──────────────────────────────┐     │                │
│            │  │  agent-manager.ts             │     │                │
│            │  │  - getAgent()                 │     │                │
│            │  │  - Caching & lifecycle        │     │                │
│            │  └──────────────┬─────────────────┘     │                │
│            └─────────────────┼───────────────────────┘                │
│                              │                                         │
│            ┌─────────────────▼───────────────────────┐              │
│            │         llm-agent                        │              │
│            │    (Central Orchestrator)               │              │
│            │  ┌──────────────────────────────┐        │              │
│            │  │  - Orchestrates LLM ↔ MCP  │        │              │
│            │  │  - Manages conversation     │        │              │
│            │  │  - Coordinates tool calls   │        │              │
│            │  └───────┬────────────┬────────┘        │              │
│            └───────────┼────────────┼─────────────────┘              │
│                        │            │                                  │
│        ┌───────────────┼────────────┼───────────────┐                │
│        │               │            │               │                │
│  ┌─────▼─────┐         │    ┌──────▼──────┐        │                │
│  │   LLM     │         │    │    MCP      │        │                │
│  │  Provider │         │    │   Client    │        │                │
│  └─────┬─────┘         │    └──────┬──────┘        │                │
│        │               │           │                │                │
│  ┌─────▼───────────────┼───────────▼───────────────┐                │
│  │   SAP AI Core       │   MCP Proxy               │                │
│  │ (service binding)   │   (CAP Service)            │                │
│  └─────┬───────────────┼───────────┬───────────────┘                │
│        │               │           │                                  │
│        │               │    ┌──────▼──────┐                          │
│        │               │    │ mcp-abap-adt │                          │
│        │               │    │ (embedded)   │                          │
│        │               │    └──────┬──────┘                          │
│        │               │           │                                  │
│  ┌─────▼───────────────┼───────────▼───────────────┐                 │
│  │      LLM            │   SAP ABAP System          │                 │
│  │  (via AI Core)     │   (via destination)        │                 │
│  └────────────────────┴────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- `llm-agent` and `mcp-abap-adt` are peer components (same level)
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` is separated as a subsystem because different LLM models work differently with MCP
- `cloud-llm-hub` integrates all components into a unified system

## 📝 Detailed Task Description

### Task: LLM Proxy Development for Cloud LLM Hub

**Context:**
Cloud LLM Hub integrates `mcp-abap-adt` (MCP server for ABAP), `llm-agent` (LLM orchestrator), and future UI into a unified system. `llm-agent` and `mcp-abap-adt` are peer components at the same level. The LLM Proxy:
- Accepts messages from consumers (OData endpoints or future UI)
- Works with LLM through SAP AI Core for message processing
- Orchestrates communication between LLM and MCP (LLM communicates with MCP through the agent)
- Enables LLM to use MCP tools for interaction with ABAP system

**Architecture Note:**
- `llm-agent` is separated as a subsystem because different LLM models work differently with MCP
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` acts as the central orchestrator for LLM-MCP communication

**Input:**
- User message (text)
- Configuration through environment variables
- SAP AI Core service binding (via VCAP_SERVICES)
- MCP destination for ABAP system

**Output:**
- LLM response (text)
- Conversation history
- Service health status

**Technical Requirements:**

1. **OData Endpoints:**
   - `POST /odata/v4/agent/Chat` - send message
   - `GET /odata/v4/agent/GetHistory()` - get history
   - `POST /odata/v4/agent/ClearHistory` - clear history
   - `GET /odata/v4/agent/Health()` - health check

2. **LLM Integration:**
   - Use SAP AI Core through service binding
   - Support different models (gpt-4o-mini, claude-3-5-sonnet, etc.)
   - Configuration via env vars (LLM_AGENT_MODEL, LLM_AGENT_TEMPERATURE, etc.)

3. **MCP Integration:**
   - Connect to MCP Proxy via HTTP transport
   - Use same destination as MCP Proxy
   - Automatic detection of available tools

4. **Caching:**
   - Cache agents by configuration
   - TTL: 30 minutes
   - Conversation history stored in cached agent

**Acceptance Criteria:**

1. ✅ OData endpoints work correctly
2. ✅ LLM integration through SAP AI Core works
3. ✅ MCP integration works (ability to call tools)
4. ✅ Caching works correctly
5. ✅ Health endpoint shows correct status
6. ✅ Error handling works (fallback to LLM-only mode)
7. ✅ Logging is sufficient for debugging

**Files to Work With:**

- `srv/agent-service.ts` - main service logic
- `srv/agent-manager.ts` - agent management
- `srv/agent-config.ts` - configuration
- `srv/agent-service.cds` - OData service definition
- `node_modules/@mcp-abap-adt/llm-agent/` - agent module

**Dependencies:**

- SAP AI Core service binding (via mta.yaml)
- MCP destination (configured in Destination service)
- llm-agent submodule (already exists)

## 🚀 Development Plan

### Phase 1: Verification and Completion (1-2 days)

1. **Service Registration Check**
   - [ ] Verify if CAP automatically loads agent-service
   - [ ] Add explicit registration if needed
   - [ ] Verify endpoints are accessible

2. **Basic Functionality Testing**
   - [ ] Health endpoint works
   - [ ] Chat endpoint works with LLM only
   - [ ] Chat endpoint works with MCP integration
   - [ ] GetHistory works
   - [ ] ClearHistory works

3. **Bug Fixes**
   - [ ] Fix identified issues
   - [ ] Improve error handling
   - [ ] Add logging where needed

### Phase 2: Testing and Documentation (2-3 days)

1. **Unit Tests**
   - [ ] Tests for agent-manager
   - [ ] Tests for agent-config
   - [ ] Tests for agent-service handlers

2. **Integration Tests**
   - [ ] E2E tests for OData endpoints
   - [ ] Tests with real SAP AI Core
   - [ ] Tests with real MCP Proxy

3. **Documentation**
   - [ ] API reference
   - [ ] Deployment guide
   - [ ] Troubleshooting guide
   - [ ] Code comments

### Phase 3: Optimization and Improvements (1-2 days)

1. **Optimization**
   - [ ] Improve caching
   - [ ] Optimize MCP connection
   - [ ] Add metrics

2. **UX Improvements**
   - [ ] Improve error messages
   - [ ] Add more detailed information in Health endpoint
   - [ ] Add streaming support (if needed)

## 📚 Developer Documentation

### Getting Started

1. **Clone and Setup:**
   ```bash
   git clone <repo>
   cd cloud-llm-hub
   npm install
   npm install @mcp-abap-adt/llm-agent
   npm install
   npm run build
   cd ../..
   ```

2. **Environment Variables Setup:**
   ```bash
   # Create .env file in project root
   cp .env.template .env
   # Fill values:
   # LLM_AGENT_MODEL=gpt-4o-mini
   # LLM_AGENT_TEMPERATURE=0.7
   # LLM_AGENT_MAX_TOKENS=2000
   # LLM_AGENT_MCP_DESTINATION=SAP_DEV_DEST
   ```

3. **Run Locally:**
   ```bash
   cds watch --profile development
   ```

4. **Testing:**
   ```bash
   # Health check
   curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
     -H "Authorization: Basic YWxpY2U6"
   
   # Chat
   curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     -d '{"message": "Hello"}'
   ```

### Code Structure

```
srv/
├── agent-service.cds          # OData service definition
├── agent-service.ts            # CAP service handlers
├── agent-manager.ts            # Agent instance management
└── agent-config.ts             # Configuration loading

node_modules/@mcp-abap-adt/llm-agent/
├── src/
│   ├── agents/
│   │   └── sap-core-ai-agent.ts # SAP AI Core agent
│   ├── llm-providers/
│   │   └── sap-core-ai.ts      # SAP AI Core provider
│   └── mcp/
│       └── client.ts           # MCP client wrapper
└── package.json
```

### Key Concepts

1. **Agent Manager:**
   - Creates and caches agents
   - Loads configuration from env vars
   - Creates LLM provider through SAP AI Core
   - Creates MCP client to connect to MCP Proxy

2. **Agent Service:**
   - OData endpoints for agent interaction
   - Request processing from consumers
   - Input validation
   - Error handling

3. **Configuration:**
   - Loading from environment variables
   - SAP AI Core service binding from VCAP_SERVICES
   - MCP destination from env vars

### Debugging

1. **Logging:**
   - Use `cds.log('agent-service')` for logging
   - Levels: debug, info, warn, error

2. **Health Endpoint:**
   - Check status via `/odata/v4/agent/Health()`
   - Check `agentReady` and `mcpConnected`

3. **Common Issues:**
   - SAP AI Core service binding not found → check mta.yaml
   - MCP destination not found → check env vars
   - Connection failed → check MCP Proxy health

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

## 📞 Contacts and Questions

If you have questions during development:
1. Check documentation in `docs/llm-agent/*.md`
2. Check code in `srv/agent-*.ts`
3. Check examples in `test/test-agent.sh`
4. Contact the team for clarifications
