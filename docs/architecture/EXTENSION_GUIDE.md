# Cloud LLM Hub — Extension Guide

How to extend Cloud LLM Hub with persistent RAG, domain-specific knowledge stores, additional MCP servers, and custom ABAP/ADT tools.

## Current Architecture

```
SmartAgent (singleton, built via SmartAgentBuilder)
├── LLM: sap-ai-sdk pipeline → @sap-ai-sdk/orchestration → SAP AI Core
├── MCP: [ABAP] — MCPClientWrapper → McpClientAdapter → /mcp/stream/http
├── RAG: InMemoryRag (facts + feedback + state)
└── Classifier + Assembler (built-in defaults)
```

SmartAgent has **3 fixed RAG stores** and an **array of MCP clients**:

| Store | Purpose |
|-------|---------|
| `facts` | Tool descriptions, domain knowledge, documentation |
| `feedback` | User feedback, corrections, preferences |
| `state` | Session state, conversation context, working memory |

All 3 stores implement the same `IRag` interface:

```typescript
interface IRag {
  query(text: string, k: number, filter?: { namespace?: string }): Promise<RagResult[]>
  upsert(text: string, metadata: RagMetadata): Promise<void>
  delete(id: string): Promise<void>
}
```

---

## How to Add an MCP Client (Step-by-Step)

SmartAgent connects to MCP servers via `MCPClientWrapper` → `McpClientAdapter`. To add any MCP server (ABAP, JIRA, GitHub, custom, etc.), follow these steps.

### Step 1: Add config in `srv/agent-config.ts`

```typescript
// Add to AgentConfig interface:
export interface AgentConfig {
  // ... existing fields ...

  /** Additional MCP servers */
  mcpServers: McpServerConfig[];
}

export interface McpServerConfig {
  /** Unique name for logging/debugging */
  name: string;
  /** MCP server endpoint URL */
  url: string;
  /** Auth headers (Bearer token, API key, etc.) */
  headers?: Record<string, string>;
  /** Whether this server is enabled */
  enabled: boolean;
}
```

Load from env vars (comma-separated list or individual vars):

```typescript
// Simple approach — one var per server:
// LLM_AGENT_MCP_JIRA_URL=https://jira-mcp.example.com/mcp
// LLM_AGENT_MCP_JIRA_TOKEN=Bearer xxx
// LLM_AGENT_MCP_GITHUB_URL=https://github-mcp.example.com/mcp
// LLM_AGENT_MCP_GITHUB_TOKEN=Bearer yyy
```

### Step 2: Create MCP clients in `srv/agent-manager.ts`

```typescript
import { MCPClientWrapper } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '@mcp-abap-adt/llm-agent/dist/smart-agent/adapters/mcp-client-adapter';

// Build array of MCP adapters
const mcpAdapters: McpClientAdapter[] = [];

// 1. Always add the ABAP MCP client (existing self-loop)
const abapMcpClient = new MCPClientWrapper(buildMCPConfig(config, req));
mcpAdapters.push(new McpClientAdapter(abapMcpClient));

// 2. Add each configured MCP server
for (const server of config.mcpServers) {
  if (!server.enabled) continue;

  const client = new MCPClientWrapper({
    url: server.url,
    headers: server.headers,
  });
  mcpAdapters.push(new McpClientAdapter(client));

  log.info('Added MCP client', { name: server.name, url: server.url });
}

// 3. Pass all adapters to SmartAgentBuilder
builder.withMcpClients(mcpAdapters);
```

### Step 3: Add env vars in `mta.yaml` and `.mtaext`

```yaml
# mta.yaml — parameters section
LLM_AGENT_MCP_JIRA_URL:
LLM_AGENT_MCP_JIRA_TOKEN:

# mta.yaml — env section in cloud-llm-hub-srv module
LLM_AGENT_MCP_JIRA_URL: <LLM_AGENT_MCP_JIRA_URL>
LLM_AGENT_MCP_JIRA_TOKEN: <LLM_AGENT_MCP_JIRA_TOKEN>
```

```yaml
# .mtaext — actual values
LLM_AGENT_MCP_JIRA_URL: "https://jira-mcp.example.com/mcp/stream/http"
LLM_AGENT_MCP_JIRA_TOKEN: "Bearer your-jira-api-token"
```

### Step 4: Verify

After adding a new MCP client, SmartAgent will:
1. Call `listTools()` on each MCP client during build
2. Merge all tools into a single flat list
3. Vectorize tool descriptions into RAG (for intent-based tool selection)
4. Use the correct MCP client when calling a tool (tracked internally)

Check via health endpoint:

```bash
curl http://localhost:4004/odata/v4/agent/Health() \
  -H "Authorization: Basic YWxpY2U6" | jq
```

The `mcp` array in the health response will show status of each connected MCP server.

### Summary: What to Touch

| File | Change |
|------|--------|
| `srv/agent-config.ts` | Add `McpServerConfig` interface + env var parsing |
| `srv/agent-manager.ts` | Loop over configs, create `MCPClientWrapper` + `McpClientAdapter` per server |
| `mta.yaml` | Add parameter placeholders + env vars |
| `.mtaext.template` | Add placeholder values |
| `.mtaext` | Add actual values |

That's it. No changes needed in `@mcp-abap-adt/core`, `openai-handler.ts`, or `agent-service.ts` — they are MCP-agnostic.

---

## Extension Scenarios

### Scenario 1: Persistent RAG (Replace In-Memory)

**Goal:** Agent remembers facts, feedback, and state across restarts.

**Backend options:**

| Backend | Pros | Cons |
|---------|------|------|
| SAP HANA Cloud Vector Engine | Native BTP, managed, scalable | Requires HANA Cloud instance |
| PostgreSQL + pgvector | Cheap, well-supported | Need to deploy/manage on BTP |
| Ollama embeddings + local file | Simple, no external deps | Not production-ready |

**Changes required:**

| File | Change |
|------|--------|
| `srv/rag/hana-vector-rag.ts` | **New.** Implement `IRag` interface for HANA Vector Engine |
| `srv/agent-config.ts` | Add env vars: `RAG_BACKEND`, `RAG_HANA_URL`, `RAG_HANA_SCHEMA` |
| `srv/agent-manager.ts` | Pass persistent RAG instances to `.withRag({ facts, feedback, state })` |
| `mta.yaml` | Add HANA Cloud resource binding |
| `.mtaext.template` | Add RAG backend config vars |

**Implementation pattern:**

```typescript
// srv/rag/hana-vector-rag.ts
import type { IRag } from '@mcp-abap-adt/llm-agent/dist/smart-agent/interfaces/rag';

export class HanaVectorRag implements IRag {
  constructor(private schema: string, private tableName: string) {}

  async query(text: string, k: number, filter?: { namespace?: string }) {
    // 1. Generate embedding via SAP AI Core
    // 2. SELECT with COSINE_SIMILARITY from HANA Vector column
    // 3. Filter by namespace if provided
    // 4. Return top-k results
  }

  async upsert(text: string, metadata: RagMetadata) {
    // 1. Generate embedding
    // 2. UPSERT into HANA table (id, text, embedding, metadata, namespace)
  }

  async delete(id: string) {
    // DELETE FROM table WHERE id = ?
  }
}
```

**In agent-manager.ts:**

```typescript
// Replace:
rag: { type: 'in-memory' }

// With:
const persistentRag = new HanaVectorRag(config.rag.schema, 'agent_memory');
builder.withRag({
  facts: persistentRag,
  feedback: persistentRag,
  state: persistentRag,
});
```

Using the same instance for all 3 stores is fine — data is separated by SmartAgent internally via metadata.

---

### Scenario 2: Domain-Specific Knowledge (ABAP Docs, Client Data)

**Goal:** Agent has access to ABAP programming knowledge and client-specific private data.

SmartAgent's `facts` store supports **namespaces** — use them to separate domains without changing the agent code.

**Architecture:**

```
facts store (single persistent backend)
├── namespace: "tools"            — MCP tool descriptions (auto-populated)
├── namespace: "abap-knowledge"   — SAP ABAP programming docs, patterns, best practices
├── namespace: "client-data"      — Client's private business data, configs, schemas
└── namespace: "general"          — General knowledge added at runtime
```

**Changes required:**

| File | Change |
|------|--------|
| `tools/ingest-abap-docs.ts` | **New.** Script to load ABAP knowledge into RAG with namespace `abap-knowledge` |
| `tools/ingest-client-data.ts` | **New.** Script to load client data into RAG with namespace `client-data` |
| `srv/agent-config.ts` | Add env vars for ingestion sources |

**Ingestion script pattern:**

```typescript
// tools/ingest-abap-docs.ts
import { HanaVectorRag } from '../srv/rag/hana-vector-rag';

const rag = new HanaVectorRag(schema, 'agent_memory');

// Load ABAP documentation chunks
const docs = await loadAbapDocs('./data/abap-knowledge/');
for (const doc of docs) {
  await rag.upsert(doc.text, {
    namespace: 'abap-knowledge',
    source: doc.source,
    category: doc.category, // e.g. 'cds', 'rap', 'abap-syntax', 'fiori'
  });
}
```

**Data sources for ABAP knowledge:**
- SAP Help Portal documentation (scraped/exported)
- ABAP keyword reference
- RAP (RESTful ABAP Programming) patterns
- CDS view definitions and annotations
- Clean ABAP guidelines
- Custom code examples

**Client data ingestion:**
- SAP system metadata (via MCP tools: class list, table structures, etc.)
- Business process descriptions
- Custom ABAP code documentation
- JIRA ticket history (after JIRA MCP is connected)

---

### Scenario 3: Custom ABAP/ADT MCP Tools

**Goal:** Add new MCP tools for interacting with ABAP systems via ADT (ABAP Development Tools) API.

The ABAP MCP tools live in the `@mcp-abap-adt/core` package (separate repo). Cloud-llm-hub **does not implement ABAP tools** — it only proxies MCP requests to the embedded `@mcp-abap-adt` server via `/mcp/stream/http`.

**Where ABAP tools are defined:**

```
@mcp-abap-adt/core (external package)
└── src/tools/
    ├── search-object.ts      — search ABAP objects
    ├── read-class.ts         — read class source code
    ├── read-table.ts         — read table structure
    ├── execute-query.ts      — run SQL via ADT
    └── ...                   — other ADT tools
```

**Two options to add new ABAP/ADT tools:**

**Option A — Contribute to `@mcp-abap-adt/core` (recommended):**

If the tool is generic and useful for any ABAP system (e.g. "read CDS view", "list transport requests"), contribute it upstream:

1. Clone `@mcp-abap-adt` repo
2. Add tool in `src/tools/` following existing patterns
3. Register tool in the MCP server tool list
4. Publish new version of `@mcp-abap-adt/core`
5. Update version in `cloud-llm-hub/package.json`

No changes needed in cloud-llm-hub — the proxy passes all MCP requests through transparently.

**Option B — Custom MCP server with own ADT tools:**

If the tool is project-specific or experimental:

| File | Change |
|------|--------|
| `srv/custom-mcp-server.ts` | **New.** Standalone MCP server with custom ADT tools |
| `srv/agent-manager.ts` | Add second ABAP MCP client pointing to custom server |
| `srv/agent-config.ts` | Add config for custom MCP endpoint |

Pattern for custom ADT tool:

```typescript
// srv/custom-mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'custom-abap-tools', version: '1.0.0' });

server.tool('read_cds_view', { view_name: z.string() }, async ({ view_name }) => {
  // Use ADT API directly via @sap-cloud-sdk/http-client
  const response = await executeHttpRequest(destination, {
    method: 'GET',
    url: `/sap/bc/adt/ddic/ddl/sources/${view_name}`,
  });
  return { content: [{ type: 'text', text: response.data }] };
});
```

Then in `agent-manager.ts`, add it as another MCP client:

```typescript
builder.withMcpClients([
  abapAdapter,        // standard @mcp-abap-adt tools
  customAbapAdapter,  // custom ADT tools
]);
```

**Key point:** SmartAgent sees all tools from all MCP clients as a flat list. It does not care which server provides which tool — intent classification and tool selection happen automatically.

---

### Scenario 4: JIRA MCP Server

**Goal:** Agent can create/read/update JIRA issues, search tickets, manage sprints.

SmartAgent supports **multiple MCP clients** via `.withMcpClients([...])`. Adding JIRA is straightforward.

**Architecture:**

```
SmartAgent
├── MCP Client 1: ABAP → /mcp/stream/http → SAP ABAP system
└── MCP Client 2: JIRA → jira-mcp-server → Atlassian JIRA API
```

**Options for JIRA MCP server:**

| Option | Description |
|--------|-------------|
| External stdio process | Run `@modelcontextprotocol/server-jira` as child process |
| External HTTP server | Standalone JIRA MCP server exposing StreamableHTTP |
| Embedded in cloud-llm-hub | Custom JIRA handlers within the same CAP app |

**Recommended: External HTTP server** — deploy separately, connect via URL.

**Changes required:**

| File | Change |
|------|--------|
| `srv/agent-config.ts` | Add `LLM_AGENT_JIRA_MCP_URL`, `LLM_AGENT_JIRA_API_TOKEN` |
| `srv/agent-manager.ts` | Create second MCPClientWrapper + McpClientAdapter, add to `.withMcpClients([abap, jira])` |
| `mta.yaml` | Add JIRA env vars |
| `.mtaext.template` | Add JIRA config placeholders |

**In agent-manager.ts:**

```typescript
// ABAP MCP client (existing)
const abapMcpClient = new MCPClientWrapper(buildMCPConfig(config, req));
const abapAdapter = new McpClientAdapter(abapMcpClient);

// JIRA MCP client (new)
const jiraMcpClient = new MCPClientWrapper({
  url: config.jira.mcpUrl,
  headers: {
    Authorization: `Bearer ${config.jira.apiToken}`,
  },
});
const jiraAdapter = new McpClientAdapter(jiraMcpClient);

// Pass both to SmartAgent
builder.withMcpClients([abapAdapter, jiraAdapter]);
```

SmartAgent will automatically discover tools from both MCP servers and use the appropriate one based on intent classification.

---

### Scenario 4: All Together (Full Production Setup)

**Architecture after all extensions:**

```
CAP Express (port 4004)
├── /mcp/stream/http              → MCP proxy (ABAP)
├── /odata/v4/agent/Chat          → SmartAgent.process()
├── /v1/chat/completions          → SmartAgent (OpenAI-compatible)
├── /v1/models                    → model list
└── /v1/usage                     → token usage

SmartAgent
├── LLM: SAP AI Core (gpt-4o-mini / claude-3-5-sonnet / deepseek-chat)
├── MCP Clients:
│   ├── ABAP → /mcp/stream/http → SAP system
│   └── JIRA → jira-mcp-server → Atlassian API
├── RAG (persistent, HANA Vector):
│   ├── facts:    abap-knowledge + client-data + tools (namespaced)
│   ├── feedback: user corrections and preferences
│   └── state:    session context, working memory
└── Classifier + Assembler (built-in)
```

**Complete file change matrix:**

| File | S1: Persistent RAG | S2: Knowledge | S3: ABAP Tools | S4: JIRA |
|------|:-:|:-:|:-:|:-:|
| `srv/rag/hana-vector-rag.ts` | **New** | Reuse | — | — |
| `srv/agent-config.ts` | Modify | Modify | Modify | Modify |
| `srv/agent-manager.ts` | Modify | — | Modify | Modify |
| `tools/ingest-abap-docs.ts` | — | **New** | — | — |
| `tools/ingest-client-data.ts` | — | **New** | — | — |
| `srv/custom-mcp-server.ts` | — | — | **New** (Option B) | — |
| `@mcp-abap-adt/core` | — | — | Modify (Option A) | — |
| `mta.yaml` | Modify | — | — | Modify |
| `.mtaext.template` | Modify | Modify | Modify | Modify |

**New env vars summary:**

| Variable | Scenario | Default | Description |
|----------|----------|---------|-------------|
| `RAG_BACKEND` | 1 | `in-memory` | `in-memory`, `hana`, `postgresql` |
| `RAG_HANA_URL` | 1 | — | HANA Cloud connection URL |
| `RAG_HANA_SCHEMA` | 1 | `AGENT` | Schema for vector tables |
| `RAG_EMBEDDING_MODEL` | 1,2 | `text-embedding-ada-002` | Model for embeddings |
| `LLM_AGENT_JIRA_MCP_URL` | 3 | — | JIRA MCP server URL |
| `LLM_AGENT_JIRA_API_TOKEN` | 3 | — | JIRA API token |

---

## Implementation Order

Recommended sequence:

1. **Persistent RAG** — foundation for everything else
2. **ABAP Knowledge ingestion** — immediate value for ABAP development assistant
3. **Custom ABAP/ADT tools** — extend ABAP capabilities (contribute to `@mcp-abap-adt/core` or build custom)
4. **JIRA MCP** — extends agent capabilities to project management
5. **Client Data ingestion** — requires understanding of client's data model

Each scenario is independent and can be implemented incrementally.
