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

1. **Basic llm-agent module** (`node_modules/@mcp-abap-adt/llm-proxy/`)
   - ✅ Project structure
   - ✅ SAP Core AI Provider
   - ✅ MCP Client Wrapper
   - ✅ Base Agent and SapCoreAIAgent
   - ✅ Support for different transports (stdio, SSE, stream-http)

2. **Integration into cloud-llm-hub**
   - ✅ `srv/agent-service.cds` - OData service definition
   - ✅ `srv/agent-service.ts` - CAP service handlers (simplified to direct LLM chat)
   - ✅ `srv/agent-manager.ts` - Agent instance management
   - ✅ `srv/agent-config.ts` - Configuration loading
   - ✅ Endpoints: Chat, GetHistory, ClearHistory, Health

3. **Configuration**
   - ✅ Environment variables support
   - ✅ SAP AI Core service binding integration
   - ✅ MCP destination configuration (optional for simple LLM-only mode)

4. **Simplified Implementation (Current)**
   - ✅ Direct LLM chat without MCP orchestration
   - ✅ Simple stateless endpoints
   - ✅ SAP AI Core integration via service binding

### ⚠️ What Needs to be Done

1. **SAP AI Core Integration Issues**
   - ⚠️ Fix OAuth2 token request (403 Forbidden)
   - ⚠️ Fix API endpoint (404 Not Found - may need deployment ID)
   - ⚠️ Verify model deployment in SAP AI Core Launchpad
   - ⚠️ Test with real SAP AI Core after deployment

2. **Testing**
   - ⚠️ Unit tests for agent-manager
   - ⚠️ Integration tests for OData endpoints
   - ⚠️ E2E tests with real SAP AI Core
   - ⚠️ Hybrid debugging setup verification

3. **Documentation**
   - ⚠️ API reference for developers
   - ⚠️ Deployment guide
   - ⚠️ Troubleshooting guide for SAP AI Core issues
   - ⚠️ Hybrid debugging guide (✅ Created)

4. **Future Enhancements (Phase 2)**
   - ⚠️ Add MCP orchestration (currently simplified to LLM-only)
   - ⚠️ Add conversation history storage
   - ⚠️ Add streaming support
   - ⚠️ Add UI integration

## 🏗️ Architecture

**System Overview:**
`cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system. `llm-agent` and `mcp-abap-adt` are peer components at the same level. LLM communicates with MCP through `llm-agent`, making `llm-agent` the central orchestrator for most system interactions.

**Current Simplified Architecture (Phase 1):**
```
Consumer (OData) 
    ↓
Agent Service (CAP)
    ↓
Agent Manager
    ↓
SAP AI Core Provider
    ↓
SAP AI Core (via service binding)
    ↓
LLM Response
```

**Future Full Architecture (Phase 2):**
```
Consumer (OData/UI) 
    ↓
Agent Service (CAP)
    ↓
Agent Manager
    ↓
┌─────────────┬─────────────┐
│ LLM Provider│  MCP Client │
│(SAP AI Core)│ (MCP Proxy) │
└──────┬──────┴──────┬──────┘
       │             │
       │    ┌────────▼────────┐
       │    │   MCP Proxy     │
       │    │  (CAP Service)  │
       │    └────────┬────────┘
       │             │
       │    ┌────────▼────────┐
       │    │  mcp-abap-adt  │
       │    │   (embedded)    │
       │    └────────┬────────┘
       │             │
       └─────────────┼─────────┐
                     │         │
            ┌────────▼─────────▼┐
            │   SAP ABAP System │
            └───────────────────┘
```

**Key Points:**
- `llm-agent` and `mcp-abap-adt` are peer components (same level)
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` is separated as a subsystem because different LLM models work differently with MCP
- `cloud-llm-hub` integrates all components into a unified system

## 📝 Development Phases

### Phase 1: Basic LLM Chat (Current) ✅

**Goal:** Simple LLM chat through SAP AI Core without MCP orchestration

**Status:** ✅ Implemented

**Features:**
- ✅ OData endpoint for chat (`POST /odata/v4/agent/Chat`)
- ✅ Direct LLM provider integration (SAP AI Core)
- ✅ Health check endpoint
- ✅ Stateless implementation (no history storage)
- ✅ Configuration via environment variables

**Remaining Tasks:**
- ⚠️ Fix SAP AI Core integration issues (OAuth2, API endpoint)
- ⚠️ Test with real SAP AI Core after deployment
- ⚠️ Setup hybrid debugging for cloud-only endpoints

### Phase 2: MCP Integration (Future)

**Goal:** Add MCP orchestration to enable LLM to use ABAP tools

**Features:**
- ⚠️ MCP client integration
- ⚠️ Tool calling orchestration
- ⚠️ Conversation history with tool results
- ⚠️ Error handling and fallback

### Phase 3: UI Integration (Future)

**Goal:** Add web UI for agent interaction

**Features:**
- ⚠️ Web interface
- ⚠️ Real-time chat
- ⚠️ Tool results visualization
- ⚠️ Conversation history UI

## 🚀 Immediate Next Steps

### 1. Deploy and Test (Priority: High)

1. **Deploy to BTP:**
   ```bash
   npx mbt build
   cf deploy gen/mta_archives/cloud-llm-hub_*.mtar
   ```

2. **Download Environment Variables:**
   ```bash
   npm run update:env
   ```

3. **Setup Hybrid Debugging:**
   - See `docs/development/HYBRID_DEBUG_SETUP.md`
   - Test cloud-only endpoints locally

4. **Verify SAP AI Core Integration:**
   - Check service binding in `default-env.json`
   - Test OAuth2 token request
   - Test API endpoint
   - Verify model deployment

### 2. Fix SAP AI Core Issues (Priority: High)

**Issues to resolve:**
- OAuth2 token request returns 403
- API endpoint returns 404 (may need deployment ID)

**Actions:**
- Verify OAuth2 endpoint URL
- Check if deployment ID is required in API path
- Verify model is deployed in SAP AI Core Launchpad
- Test with correct API endpoint format

### 3. Testing (Priority: Medium)

- [ ] Unit tests for agent-manager
- [ ] Integration tests for OData endpoints
- [ ] E2E tests with real SAP AI Core
- [ ] Hybrid debugging verification

### 4. Documentation (Priority: Medium)

- [ ] API reference
- [ ] Deployment guide
- [ ] Troubleshooting guide for SAP AI Core
- [x] Hybrid debugging guide

## 📚 Related Documentation

- **[TASK.md](../../llm-proxy/TASK.md)** - Detailed task description
- **[README.md](../../llm-proxy/README.md)** - Developer guide
- **[HYBRID_DEBUG_SETUP.md](../HYBRID_DEBUG_SETUP.md)** - Hybrid debugging setup
- **[SAP_AI_CORE_ISSUE.md](../../SAP_AI_CORE_ISSUE.md)** - Known SAP AI Core issues

## ✅ Completion Checklist

### Phase 1: Basic LLM Chat
- [x] OData endpoints implemented
- [x] SAP AI Core provider integration
- [x] Configuration loading
- [x] Health check endpoint
- [ ] SAP AI Core integration tested and working
- [ ] Hybrid debugging setup verified
- [ ] Unit tests written
- [ ] Integration tests written
- [ ] Documentation updated

### Phase 2: MCP Integration (Future)
- [ ] MCP client integration
- [ ] Tool calling orchestration
- [ ] Conversation history with tools
- [ ] Error handling and fallback

### Phase 3: UI Integration (Future)
- [ ] Web interface
- [ ] Real-time chat
- [ ] Tool results visualization

## 📞 Questions?

If you have questions:
1. Check documentation in `docs/llm-agent/*.md`
2. Check code in `srv/agent-*.ts`
3. Check examples in `test/test-agent.sh`
4. See troubleshooting in `docs/SAP_AI_CORE_ISSUE.md`
