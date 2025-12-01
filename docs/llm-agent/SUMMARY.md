# LLM Agent - Quick Summary

## 📋 What is it?

LLM Agent is a module that:
- Accepts messages from consumers (UI or OData endpoints)
- Works with LLM through SAP AI Core for message processing
- Orchestrates communication between LLM and MCP (LLM communicates with MCP through the agent)
- Enables LLM to use MCP tools for interaction with ABAP system

**Architecture Context:**
- `cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system
- `llm-agent` and `mcp-abap-adt` are peer components at the same level
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`

## 🎯 Main Goal

Create a fully functional LLM Agent that:
- Works as a central orchestrator between LLM and MCP
- Accepts messages from consumers (UI, OData endpoints)
- Enables LLM to communicate with MCP (embedded mcp-abap-adt in cloud-llm-hub) through the agent
- Acts as a peer component to `mcp-abap-adt` at the same level in the system architecture

## 📁 Key Files

```
srv/
├── agent-service.cds          # OData service definition
├── agent-service.ts           # CAP service handlers ⭐
├── agent-manager.ts           # Agent management ⭐
└── agent-config.ts            # Configuration ⭐

submodules/llm-agent/          # LLM Agent module
```

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install
cd submodules/llm-agent && npm install && npm run build && cd ../..

# 2. Configure .env (optional for local development)
cp submodules/llm-agent/.env .env

# 3. Run
cds watch --profile development

# 4. Test
bash test/test-agent.sh
```

## 📚 Documentation

1. **[TASK.md](TASK.md)** - Detailed task description
   - Technical requirements
   - Acceptance criteria
   - Execution plan

2. **[ROADMAP.md](ROADMAP.md)** - Development roadmap
   - Current status
   - Development plan
   - Architecture

3. **[README.md](README.md)** - Developer guide
   - Quick start
   - Project structure
   - Debugging

4. **[LLM_AGENT_TESTING.md](../LLM_AGENT_TESTING.md)** - Testing guide
   - How to test
   - Request examples
   - Troubleshooting

## ✅ Current Status

### Already Done:
- ✅ Basic llm-agent module
- ✅ Integration into cloud-llm-hub
- ✅ OData endpoints (Chat, GetHistory, ClearHistory, Health)
- ✅ LLM integration through SAP AI Core
- ✅ MCP integration
- ✅ Agent caching

### Needs to be Done:
- ⚠️ Verify service registration
- ⚠️ Add tests
- ⚠️ Improve documentation

## 🔗 Endpoints

- `POST /odata/v4/agent/Chat` - send message
- `GET /odata/v4/agent/GetHistory()` - conversation history
- `POST /odata/v4/agent/ClearHistory` - clear history
- `GET /odata/v4/agent/Health()` - health check

## 🏗️ Architecture

**System Integration:**
`cloud-llm-hub` integrates `mcp-abap-adt`, `llm-agent`, and future UI into a unified system.

```
Consumer → Agent Service → Agent Manager → [LLM Provider + MCP Client]
                                              ↓
                                    SAP AI Core + MCP Proxy → mcp-abap-adt → ABAP System
```

**Key Points:**
- `llm-agent` and `mcp-abap-adt` are peer components (same level)
- LLM communicates with MCP **through** `llm-agent` (not directly)
- Almost all interactions between system components go through `llm-agent`
- `llm-agent` acts as the central orchestrator for LLM-MCP communication

## 📞 Next Steps

1. Read [TASK.md](TASK.md) for detailed task description
2. Read [README.md](README.md) to get started
3. Check code in `srv/agent-*.ts`
4. Run tests: `bash test/test-agent.sh`

