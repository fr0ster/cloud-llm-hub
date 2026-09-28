# Embedded Agent Usage

How cloud-llm-hub actually reaches the SmartAgent. Read alongside
`srv/agent-manager.ts`, which is the only place the agent is constructed.

> **Rewritten against the code.** Earlier revisions of this page described a
> different architecture — an HTTP hop to the proxy, a request-scoped accessor,
> a constructor-based agent and a single expiring cache. None of that matches
> the implementation; see git history if you need the previous text.

## The shape of it

```
handler (openai-handler.ts / anthropic-handler.ts / agent-mcp.ts)
  └── getSmartAgent(destination)          ← agent-manager.ts
        ├── one cached SmartAgentHandle PER DESTINATION (`agentHandles`)
        ├── LLM from makeHubLlm(LLM_AGENT_PROVIDER)   ← srv/lib/llm-factory.ts
        └── MCPClientWrapper { transport: 'embedded' } → McpClientAdapter
              └── HandlerExporter handlers, IN-PROCESS — no HTTP, no self-loop
```

The adapter is built once, over a **placeholder** connection. The real ABAP
connection is created per request and delivered to each tool call through
`connectionALS` (an `AsyncLocalStorage`). A tool call outside that scope throws —
which is why every agent entrance runs its pipeline inside that scope.

## Two caches, different lifetimes

Do not conflate them:

| Cache | Where | Lifetime |
|-------|-------|----------|
| `agentHandles` — the agent per destination | `agent-manager.ts` | Process lifetime. No TTL; cleared only on shutdown |
| `sessionStore` — chat history per session+user | `openai-handler.ts` | `SESSION_TTL_MS` = 30 minutes of inactivity |

The 30-minute figure belongs to conversation history, not to agents.

## Calling it

```typescript
import { getSmartAgent } from './agent-manager';

// `destination` is optional; it falls back to LLM_AGENT_MCP_DESTINATION.
const agent = await getSmartAgent(destination);
```

`getSmartAgent` waits, bounded by `LLM_AGENT_DESTINATION_INIT_WAIT_MS`
(default 90 s), for that destination to finish vectorizing rather than failing
fast. After the timeout an explicit-destination request throws a retryable 503.

Tool calls must run inside the per-request connection scope — see
`srv/lib/request-connection.ts` for `/v1/*` and `srv/agent-mcp.ts` for the
planner surface. Both establish the connection from the request's own `x-sap-*`
headers before invoking the agent.

## Adding another MCP server

The ABAP client is embedded and already wired. An external server is an
**addition**, never a replacement:

```typescript
import { MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';

const external = new McpClientAdapter(
  new MCPClientWrapper({ url: server.url, headers: server.headers }),
);

// The builder is called `.withMcpClients([mcpAdapter])` today — extend that
// array; dropping mcpAdapter costs the agent every ABAP tool.
builder.withMcpClients([mcpAdapter, external]);
```

Step-by-step guidance, including the RAG extension points, is in
[EXTENSION_GUIDE.md](../architecture/EXTENSION_GUIDE.md).

## See also

- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) §7 (agent pipeline) and §16 (honesty controller)
- [CONFIG_USAGE.md](CONFIG_USAGE.md) — the environment variables behind all of this
