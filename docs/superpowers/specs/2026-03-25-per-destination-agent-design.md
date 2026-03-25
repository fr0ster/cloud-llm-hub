# Per-Destination SmartAgent Design

## Problem

The current singleton SmartAgent with destination hot-swap (`agentObj.deps.mcpClients = [newAdapter]`) causes tool calls to use the wrong SAP connection after switching destinations. Despite the tool list updating correctly, SearchObject returns data from the previous destination.

## Solution

Replace the singleton SmartAgent + hot-swap with a `Map<destinationName, SmartAgentHandle>`. Each destination gets its own SmartAgent instance with its own MCP client and tools RAG. Expensive resources (LLM, embedder, facts/feedback/state RAG, metrics) are shared across all agents.

## Architecture

### Shared Resources (created once)

| Resource | Purpose |
|----------|---------|
| `mainLlm` | Primary LLM (sap-ai-sdk) |
| `classifierLlm` | Cheaper model for classify/rerank |
| `sharedEmbedder` | Embedding API client with circuit breaker |
| `sharedRagStores.facts` | User knowledge facts (namespace-isolated) |
| `sharedRagStores.feedback` | User feedback (namespace-isolated) |
| `sharedRagStores.state` | Session state (namespace-isolated) |
| `metrics` | InMemoryMetrics counters |

### Per-Destination Resources

| Resource | Purpose |
|----------|---------|
| `SmartAgentHandle` | Full agent instance |
| `McpClientAdapter` | Embedded MCP client with SAP connection |
| `tools` IRag | Vectorized tool descriptions for RAG selection |

### State Changes in agent-manager.ts

**Remove:**
- `agentHandle: SmartAgentHandle | null` (singleton)
- `currentDestination: string | null` (global active destination)
- Destination hot-swap block in `getSmartAgent()`
- `rebuildPromise` / any rebuild logic tied to destination switching

**Add:**
- `agentHandles: Map<string, SmartAgentHandle>` — per-destination agents
- `sharedLlm: { mainLlm, classifierLlm }` — extracted shared LLM refs for model hot-swap

**Keep:**
- `destinationStates` map (status tracking, used by UI)
- `currentModel` (tracks active model across all agents)
- Model hot-swap (iterates all handles, updates `deps.mainLlm`)
- `sharedEmbedder`, `sharedRagStores`, `metrics`

### getSmartAgent(model?, destination?)

```
function getSmartAgent(model?, destination?):
  dest = destination ?? config.defaultDestination
  handle = agentHandles.get(dest)
  if (!handle) throw "Destination not ready"

  // Model switch: update ALL agents
  if (model && model !== currentModel):
    newLlm = makeLlm(model)
    for (h of agentHandles.values()):
      h.agent.deps.mainLlm = newLlm
    currentModel = model

  return handle
```

### initDestination(name)

Currently creates only MCP adapter + tools RAG. Now builds full SmartAgent:

```
async function initDestination(name):
  1. buildEmbeddedMcpAdapter(name)          // probe + connection + handlers
  2. createToolsRagStore()                   // vectorize tool descriptions
  3. SmartAgentBuilder(config)
       .withMainLlm(sharedMainLlm)
       .withClassifierLlm(sharedClassifierLlm)
       .withMcpClients([adapter])
       .withRag({ tools, ...sharedRagStores })
       .withPipeline(pipelineDefinition)
       .withStageHandler('classify', CustomClassifyHandler)
       .withStageHandler('rag-upsert', CustomRagUpsertHandler)
       .withStageHandler('tool-select', CustomToolSelectHandler)
       .withToolCache(new ToolCache())
       .withMetrics(metrics)
       .withSessionManager(new SessionManager())
       .withHistorySummarization(20)
       .withClientAdapter(new ClineClientAdapter())
       .build()
  4. agentHandles.set(name, handle)
  5. destinationStates.get(name).status = 'ready'
```

### Readiness

- `isAgentReady()` = `agentHandles.size > 0` (at least primary destination built)
- Background destinations build sequentially as before
- Unreachable retry every 5 min as before

### openai-handler.ts

No API changes. `getSmartAgent(model, dest)` returns `SmartAgentHandle` as before. The only difference is each call may return a different handle instance per destination.

Existing behavior preserved:
- Session clearing on destination switch (compare dest before/after)
- RAG namespace: `userId:destination`
- Rate-limit retry
- Stream/non-stream paths

### getCurrentDestination()

This function currently returns the global `currentDestination`. With per-destination agents, there's no single "current" destination — each request picks its own. The function is used in openai-handler.ts to detect destination switches within a request.

Change: `getCurrentDestination()` stays but tracks per-request state via the request flow in openai-handler.ts (destBefore/destAfter pattern already works — destBefore comes from previous request's destination header, destAfter from current).

Alternative: Track last-used destination per session in the session store, so `destBefore` is always accurate.

## What This Fixes

- Tool calls always use the correct SAP connection (no shared state)
- No risk of cross-destination data leakage via stale closures
- Destination switching is instant (just pick a different handle)
- Each agent's pipeline context is fully isolated

## What Stays The Same

- Model hot-swap (updates all agents' LLM — models are stateless)
- Background destination initialization flow
- Unreachable destination retry
- Destination probe at startup
- MCP tool timeout (60s)
- Session history clearing on destination switch
- RAG namespace isolation
