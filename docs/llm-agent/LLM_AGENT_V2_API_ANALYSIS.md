# @mcp-abap-adt/llm-agent v2.11.1 — API Analysis

> Analysis date: 2026-03-19
> Branch: `feature/rag-task-prep`
> Purpose: evaluate new features for cloud-llm-hub integration

## Current Usage in cloud-llm-hub

| Component | Status | Implementation |
|-----------|--------|----------------|
| **LLM** | Active | `makeLlm()` with `sap-ai-sdk` provider |
| **MCP** | Active | `MCPClientWrapper` → `McpClientAdapter` |
| **RAG** | Default | `InMemoryRag` (builder default) |
| **Pipeline** | Default | Hardcoded stages |
| **Resilience** | None | — |
| **Observability** | None | — |

## SmartAgentBuilder API

### Constructor Config

```typescript
interface SmartAgentBuilderConfig {
  mcp?: BuilderMcpConfig | BuilderMcpConfig[];
  agent?: Partial<SmartAgentConfig>;
  prompts?: BuilderPromptsConfig;
  sessionPolicy?: SessionPolicy;
}
```

> Note: LLM and RAG are NOT configured via constructor — they use fluent builder methods.

### Builder Methods (Full List)

#### LLM (required)

```typescript
.withMainLlm(llm: ILlm): this           // required
.withHelperLlm(llm: ILlm): this         // optional
.withClassifierLlm(llm: ILlm): this     // optional, falls back to mainLlm at temp=0.1
```

#### RAG & Search

```typescript
.withRag(stores: Partial<SmartAgentRagStores>): this
.withReranker(reranker: IReranker): this
.withQueryExpander(expander: IQueryExpander): this
.withRagQueryK(k: number): this
.withQueryExpansion(enabled: boolean): this
.withRagRetrieval(mode: 'auto' | 'always' | 'never'): this
.withRagTranslation(enabled: boolean): this
.withRagUpsert(enabled: boolean): this
```

#### MCP & Tools

```typescript
.withMcpClients(clients: IMcpClient[]): this
.withToolPolicy(policy: IToolPolicy): this
.withToolCache(cache: IToolCache): this
```

#### Pipeline

```typescript
.withPipeline(pipeline: StructuredPipelineDefinition): this
.withStageHandler(type: string, handler: IStageHandler): this
```

#### Orchestration

```typescript
.withMode(mode: 'hard' | 'pass' | 'smart'): this
.withMaxIterations(n: number): this
.withMaxToolCalls(n: number): this
.withTimeout(ms: number): this
.withClassifier(classifier: ISubpromptClassifier): this
.withAssembler(assembler: IContextAssembler): this
.withClassification(enabled: boolean): this
.withShowReasoning(enabled: boolean): this
```

#### Prompts

```typescript
// Via constructor config:
interface BuilderPromptsConfig {
  system?: string;
  classifier?: string;
  reasoning?: string;
  ragTranslate?: string;
  historySummary?: string;
}
```

#### Resilience

```typescript
.withCircuitBreaker(config?: CircuitBreakerConfig): this
```

#### Sessions & History

```typescript
.withSessionManager(manager: ISessionManager): this
.withSessionTokenBudget(budget: number): this
.withHistorySummarization(limit: number): this
.withHeartbeatInterval(ms: number): this
```

#### Observability

```typescript
.withLogger(logger: ILogger): this
.withTracer(tracer: ITracer): this
.withMetrics(metrics: IMetrics): this
```

#### Plugins & Skills

```typescript
.withPluginLoader(loader: IPluginLoader): this
.withSkillManager(manager: ISkillManager): this
```

#### Validation & Security

```typescript
.withOutputValidator(validator: IOutputValidator): this
.withInjectionDetector(detector: IPromptInjectionDetector): this
```

#### Token Tracking

```typescript
.withUsageProvider(getUsage: () => TokenUsage): this
```

#### Build

```typescript
.build(): Promise<SmartAgentHandle>
```

### SmartAgentHandle (build result)

```typescript
interface SmartAgentHandle {
  agent: SmartAgent;
  chat: ILlm['chat'];
  streamChat: ILlm['streamChat'];
  getUsage(): TokenUsage;
  close(): Promise<void>;
  circuitBreakers: CircuitBreaker[];
  ragStores: SmartAgentRagStores;
}
```

---

## New Features Available

### 1. LLM Providers

Factory function `makeLlm()` supports multiple providers:

```typescript
import { makeLlm } from '@mcp-abap-adt/llm-agent';

interface LlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk';
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  resourceGroup?: string;       // sap-ai-sdk only
  credentials?: SapAICoreCredentials;
}

const llm = makeLlm(config, temperature);
```

**Concrete classes**: `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapCoreAIProvider`

### 2. RAG Implementations

Three independent stores: **facts**, **feedback**, **state**.

#### InMemoryRag (current)
```typescript
new InMemoryRag({ namespace?, dedupThreshold? })
```
No persistence, no external dependencies.

#### VectorRag (hybrid vector + keyword)
```typescript
const embedder = resolveEmbedder({ embedder: 'openai', apiKey: '...' });
new VectorRag(embedder, {
  dedupThreshold?: number,
  namespace?: string,
  vectorWeight?: number,   // semantic search weight
  keywordWeight?: number,  // BM25 lexical weight
})
```
Supports `updateWeights()` for hot-reload.

#### QdrantRag (vector DB)
```typescript
new QdrantRag({
  url: string,
  collectionName: string,
  embedder: IEmbedder,
  apiKey?: string,
  timeoutMs?: number,
})
```

#### OllamaRag (local LLM embeddings)
```typescript
new OllamaRag({ ollamaUrl?, model?, timeoutMs? })
```

#### Embedders
```typescript
import { resolveEmbedder } from '@mcp-abap-adt/llm-agent';

// Built-in: OllamaEmbedder, OpenAiEmbedder
// Custom via builtInEmbedderFactories registry
```

### 3. Structured Pipeline

Replace hardcoded orchestration with declarative stages:

```typescript
interface StructuredPipelineDefinition {
  version: '1';
  stages: StageDefinition[];
}

interface StageDefinition {
  id: string;
  type: BuiltInStageType | ControlFlowType;
  config?: Record<string, unknown>;
  when?: string;                // condition expression
  stages?: StageDefinition[];   // for parallel/repeat
  after?: StageDefinition[];    // sequential follow-up
  maxIterations?: number;
  until?: string;
}
```

**Built-in stage types:**
`classify`, `translate`, `expand`, `rag-query`, `rag-upsert`, `rerank`, `tool-select`, `skill-select`, `assemble`, `tool-loop`, `summarize`

**Control flow types:**
`parallel`, `repeat`

**Custom stages:**
```typescript
builder.withStageHandler('my-stage', new MyStageHandler());
```

**Example pipeline:**
```typescript
builder.withPipeline({
  version: '1',
  stages: [
    { id: 'classify', type: 'classify' },
    { id: 'rag', type: 'rag-query' },
    { id: 'rerank', type: 'rerank' },
    { id: 'assemble', type: 'assemble' },
    { id: 'tool-loop', type: 'tool-loop' },
    { id: 'save', type: 'rag-upsert' },
  ],
});
```

### 4. Plugin System

File-based extensibility:

```typescript
import { FileSystemPluginLoader, getDefaultPluginDirs } from '@mcp-abap-adt/llm-agent';

builder.withPluginLoader(new FileSystemPluginLoader({
  dirs: getDefaultPluginDirs()  // ~/.config/llm-agent/plugins/, ./plugins/
}));

// Plugins can export:
interface PluginExports {
  stageHandlers?: Record<string, IStageHandler>;
  embedderFactories?: Record<string, EmbedderFactory>;
  reranker?: IReranker;
  queryExpander?: IQueryExpander;
  outputValidator?: IOutputValidator;
  skillManager?: ISkillManager;
}
```

### 5. Skills System

Agent skill discovery and execution:

```typescript
import { FileSystemSkillManager, ClaudeSkillManager, CodexSkillManager } from '@mcp-abap-adt/llm-agent';

// File-based skills
builder.withSkillManager(new FileSystemSkillManager({ dirs: ['./skills'] }));

// LLM-generated skills
builder.withSkillManager(new ClaudeSkillManager());
builder.withSkillManager(new CodexSkillManager());

interface ISkill {
  readonly name: string;
  readonly description: string;
  readonly meta: ISkillMeta;
  getContent(args?: string, options?: CallOptions): Promise<Result<string, SkillError>>;
  listResources(options?: CallOptions): Promise<Result<ISkillResource[], SkillError>>;
  readResource(path: string, options?: CallOptions): Promise<Result<string, SkillError>>;
}
```

### 6. Circuit Breakers (Resilience)

Auto-recovery on LLM/embedder failures:

```typescript
builder.withCircuitBreaker({
  failureThreshold: 5,       // open after 5 failures
  recoveryWindowMs: 30000,   // try recovery after 30s
});

// Wrapped implementations:
new CircuitBreakerLlm(llm, config);
new CircuitBreakerEmbedder(embedder, config);
new FallbackRag(primary, fallback, embedderBreaker);
```

States: `closed` → `open` → `half-open` → `closed`

### 7. Query Enhancement

#### Query Expansion (RAG)
```typescript
import { LlmQueryExpander } from '@mcp-abap-adt/llm-agent';

builder.withQueryExpander(new LlmQueryExpander(classifierLlm));
builder.withQueryExpansion(true);
```
Broadens RAG queries with synonyms/paraphrases.

#### Reranker
```typescript
import { LlmReranker } from '@mcp-abap-adt/llm-agent';

builder.withReranker(new LlmReranker(classifierLlm));
```
Re-scores RAG results using LLM for better relevance.

### 8. Session Management

Multi-turn token budget tracking:

```typescript
import { SessionManager } from '@mcp-abap-adt/llm-agent';

builder.withSessionManager(new SessionManager(8000));
builder.withSessionTokenBudget(8000);
builder.withHistorySummarization(20);  // compress after 20 messages
```

### 9. Observability

#### Logger
```typescript
interface ILogger {
  log(event: LogEvent): void;
}

// Event types: classify, rag_upsert, rag_query, llm_call,
// tool_call, pipeline_done, pipeline_error, tools_selected, rag_translate
```

#### Tracer (OpenTelemetry)
```typescript
builder.withTracer(tracer);   // ITracer with startSpan()
```

#### Metrics
```typescript
import { InMemoryMetrics } from '@mcp-abap-adt/llm-agent';

builder.withMetrics(new InMemoryMetrics());
// Counters and histograms for LLM calls, tool calls, RAG queries
```

### 10. Validation & Security

#### Output Validator
```typescript
builder.withOutputValidator(validator);

interface ValidationResult {
  valid: boolean;
  reason?: string;
  correctedContent?: string;
}
```

#### Prompt Injection Detection
```typescript
builder.withInjectionDetector(detector);

interface IPromptInjectionDetector {
  detect(text: string): { detected: boolean; pattern?: string };
}
```

#### Tool Policy
```typescript
builder.withToolPolicy(policy);

interface IToolPolicy {
  check(toolName: string): { allowed: boolean; reason?: string };
}
```

### 11. Tool Caching

Deduplication of identical tool calls:

```typescript
import { ToolCache } from '@mcp-abap-adt/llm-agent';

builder.withToolCache(new ToolCache());
```

---

## Key Types Reference

### CallOptions (passed to every async operation)

```typescript
interface CallOptions {
  trace?: { traceId: string; spanId?: string; baggage?: Record<string, string> };
  sessionId?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  ragFilter?: { namespace?: string };
  sessionLogger?: { logStep(name: string, data: unknown): void };
}
```

### Message

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}
```

### Result Type

```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

### IRag

```typescript
interface IRag {
  upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
  query(text: string, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}

interface RagMetadata {
  id?: string;
  ttl?: number;           // Unix timestamp (seconds)
  namespace?: string;      // tenant/user/session isolation
  [key: string]: unknown;
}
```

---

## Cloud Deployment: SAP BTP Cloud Foundry

cloud-llm-hub deploys as a CF application on SAP BTP. Key constraints:

- **No persistent writable filesystem** — CF containers are ephemeral, restaged on deploy/restart
- **No local services** — no Docker sidecar by default
- **Horizontal scaling** — multiple app instances share no in-process state
- **Read-only app directory** — files bundled with the app (deployed artifact) ARE readable

### llm-agent features: CF compatibility matrix

| Feature | Local dev | CF production | Adaptation needed |
|---------|-----------|---------------|-------------------|
| **makeLlm (sap-ai-sdk)** | Works | Works | None — uses AICORE_SERVICE_KEY / VCAP_SERVICES |
| **makeLlm (openai/anthropic/deepseek)** | Works | Works | API keys via env vars or SAP Credential Store |
| **InMemoryRag** | Works | Works (volatile) | OK for dev/PoC; data lost on restart, not shared across instances |
| **VectorRag** (in-memory + embedder) | Works | Works (volatile) | Same as InMemoryRag — needs external embedder (AI Core or OpenAI) |
| **QdrantRag** | Works (local Qdrant) | Possible via MTA sidecar | Not recommended for prod (see note) |
| **OllamaRag / OllamaEmbedder** | Works (local Ollama) | Not available | Replace with AI Core or OpenAI embedder |
| **OpenAiEmbedder** | Works | Works | API key via env or Credential Store |
| **FileSystemPluginLoader** | Works | Works (read-only) | Plugins bundled in app artifact, cannot be added at runtime |
| **FileSystemSkillManager** | Works | Works (read-only) | Skills bundled in `./skills/` dir, deployed with app |
| **CircuitBreaker** | Works | Works | None — per-instance state is sufficient |
| **ToolCache** (in-memory) | Works | Works (per-instance) | OK for single instance; not shared across multiple instances |
| **SessionManager** (in-memory) | Works | Works (per-instance) | Sessions lost on restart; for persistence use HANA |
| **InMemoryMetrics** | Works | Works (volatile) | OK for /v1/usage endpoint; for aggregated metrics use Cloud Logging |
| **Structured Pipeline** (programmatic) | Works | Works | None — pipeline defined in code or CDS config |
| **LlmQueryExpander / LlmReranker** | Works | Works | None — uses existing LLM, stateless |
| **ILogger / ITracer / IMetrics** | Works | Works | Custom impl to bridge to CAP log / SAP Cloud Logging |
| **IOutputValidator** | Works | Works | None — stateless |
| **IPromptInjectionDetector** | Works | Works | None — stateless |
| **IToolPolicy** | Works | Works | None — stateless |

> **Key insight:** Most features work on CF as-is or with read-only filesystem.
> The main gap is **persistence** — in-memory state (RAG data, sessions, metrics)
> is lost on restart and not shared across instances. This is solved by backing
> with BTP services (HANA, Cloud Logging, Redis).

> **Note on Qdrant via MTA:** Technically possible to deploy Qdrant as an MTA module
> (Docker container on CF). However **not recommended for production**:
> - Unmanaged — no monitoring, backups, or SLA from SAP
> - Consumes CF memory/CPU quota (Qdrant needs significant RAM)
> - No horizontal scaling without manual setup
> - Manual updates via MTA redeploy
>
> Acceptable as a **dev/staging option**. For production use SAP HANA Cloud Vector Engine.

### SAP BTP Services for persistence and operations

| BTP Service | Replaces | llm-agent integration |
|-------------|----------|----------------------|
| **SAP HANA Cloud (Vector Engine)** | InMemoryRag / VectorRag (volatile) | Custom `IRag` with `REAL_VECTOR` + `COSINE_SIMILARITY()` |
| **SAP AI Core** | — (already used for LLM) | `makeLlm({ provider: 'sap-ai-sdk' })` |
| **SAP AI Core (embedding deployments)** | OllamaEmbedder | Custom `IEmbedder` via AI Core inference API |
| **SAP Cloud Logging** | InMemoryMetrics | Custom `ITracer` / `IMetrics` → OpenTelemetry export |
| **Application Logging Service** | console.log | Custom `ILogger` → structured CF logs |
| **SAP Credential Store** | env var API keys | Secure storage for OpenAI/Anthropic keys |
| **Redis (hyperscaler option)** | in-memory ToolCache / SessionManager | Shared cache across CF instances |

---

## Architecture Decision: Service, not Platform

cloud-llm-hub is a **pre-configured service**, not a runtime-configurable integration platform.

**What it IS:**
- A service configured before deployment (code, mta.yaml, env vars)
- Exposes MCP protocol and OpenAI-compatible API for consumers
- Managed via OData endpoints
- Integrates with SAP ABAP systems as a fixed, tested configuration

**What it is NOT:**
- Not a platform like OpenClaw or SAP Integration Suite
- Not a runtime-configurable orchestrator with hot-reload pipelines
- Not a place where users add plugins/skills at runtime

**Implications for llm-agent feature selection:**
- Features that improve **service quality** (RAG, resilience, caching) — YES
- Features that improve **security and stability** (circuit breakers, validation) — YES
- Features configured **at build/deploy time** (pipeline in code, bundled prompts) — YES
- Features for **runtime extensibility** (hot-reload pipeline, plugin discovery, DB-backed config) — NO
- Features that turn cloud-llm-hub into an **integration platform** — NO

---

## Integration Recommendations for cloud-llm-hub

### Priority 1 — Core service quality

Improve response quality and resilience. All configured in code, deployed as part of the app.
SAP AI Core already available — use it for both LLM and embeddings.

| Feature | Effort | Value |
|---------|--------|-------|
| **VectorRag + AI Core Embedder** | Custom `IEmbedder` impl | Semantic search in RAG (hybrid vector + BM25) |
| **Circuit Breaker** | 1 line | Auto-recovery on SAP AI Core outages |
| **Tool Cache** | 1 line | Avoid duplicate tool calls within conversation |
| **Session management** | 2 lines | Token budget control per conversation |
| **History summarization** | 1 line | Long conversation support |

**VectorRag setup** — in-memory semantic search via SAP AI Core embeddings:

```typescript
// Custom IEmbedder using SAP AI Core embedding deployment
const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-ada-002',
  resourceGroup: config.llm.resourceGroup,
});

// VectorRag: in-memory hybrid search (vector + keyword)
const vectorRag = new VectorRag(embedder, {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
});

builder.withRag({
  facts: vectorRag,
  feedback: vectorRag,
  state: new InMemoryRag(),
});
```

> `SapAiCoreEmbedder` — custom `IEmbedder` implementation to build.
> Uses `@sap-ai-sdk/orchestration` or AI Core inference API for embedding calls.
> Interface: `embed(text: string): Promise<number[]>`

> In-memory VectorRag is lost on restart — acceptable for a service where RAG
> accumulates knowledge during session. For cross-restart persistence see Priority 3.

### Priority 2 — Service hardening

Security, observability, response quality. All stateless, configured in code.

| Feature | Effort | Value |
|---------|--------|-------|
| **Query expansion** | 2 lines | Better RAG search via LLM paraphrasing |
| **Reranker** | 2 lines | Better RAG relevance scoring |
| **Tool Policy** | `IToolPolicy` impl | Restrict MCP tools per user role (complements exposition) |
| **Output Validator** | `IOutputValidator` impl | Validate/sanitize LLM responses before returning |
| **Prompt injection detection** | `IPromptInjectionDetector` impl | Security hardening for user input |
| **ILogger → CAP log** | `ILogger` impl | Bridge llm-agent events to `cds.log()` for CF log drain |

### Priority 3 — Persistent RAG (requires SAP HANA Cloud)

Replace in-memory VectorRag with persistent storage. RAG knowledge survives restarts
and is shared across CF instances.

| Feature | Effort | Value |
|---------|--------|-------|
| **HANA Vector IRag** | Custom `IRag` implementation | Persistent semantic search via HANA Vector Engine |
| **HANA-backed sessions** | Custom `ISessionManager` | Conversations survive restarts |

**HANA Vector Engine approach:**
- `REAL_VECTOR` columns + `COSINE_SIMILARITY()` (HANA Cloud 2024 QRC1+)
- Implement `IRag` interface with CDS entities + native HANA vector queries
- Embeddings via SAP AI Core (same `SapAiCoreEmbedder` from Priority 1)
- Namespace isolation for multi-tenant RAG

### Pipeline configuration

Pipeline is part of the service definition — configured in code at build time.
No hot-reload needed (service is pre-configured before deployment).

```typescript
// Pipeline defined in code (type-safe, versioned, tested)
const pipeline: StructuredPipelineDefinition = {
  version: '1',
  stages: [
    { id: 'classify', type: 'classify' },
    { id: 'rag-query', type: 'rag-query' },
    { id: 'assemble', type: 'assemble' },
    { id: 'tool-loop', type: 'tool-loop' },
  ],
};

builder.withPipeline(pipeline);
```

For environment-specific overrides (e.g. disable classification in dev),
use CDS config profiles:

```jsonc
// package.json — production pipeline
{
  "cds": {
    "requires": {
      "llm-agent": {
        "pipeline": { "version": "1", "stages": [...] }
      }
    }
  }
}
```

### Features NOT applicable

These features turn cloud-llm-hub into a platform, which is not the goal:

| Feature | Why not for cloud-llm-hub |
|---------|--------------------------|
| Hot-reload pipeline from DB | Service is pre-configured, not runtime-configurable |
| Runtime plugin discovery | Plugins are part of the app build, not discovered at runtime |
| Runtime skill management | Skills are bundled with the app if needed |
| Multi-provider LLM fallback | Service uses one configured LLM provider (SAP AI Core) |
| SAP Feature Flags for pipeline | Over-engineering for a pre-configured service |

---

### Target builder configuration

```typescript
import {
  SmartAgentBuilder,
  makeLlm,
  VectorRag,
  InMemoryRag,
  ToolCache,
  SessionManager,
  LlmQueryExpander,
  LlmReranker,
} from '@mcp-abap-adt/llm-agent';
import { SapAiCoreEmbedder } from './lib/sap-ai-core-embedder';

const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-ada-002',
  resourceGroup: config.llm.resourceGroup,
});

const vectorRag = new VectorRag(embedder, {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
});

const builder = new SmartAgentBuilder({
  agent: {
    maxIterations: config.agent.maxIterations,
    mode: config.agent.mode,
  },
})
  .withMainLlm(mainLlm)
  .withClassifierLlm(classifierLlm)
  .withMcpClients([mcpAdapter])

  // Priority 1 — semantic RAG + resilience
  .withRag({
    facts: vectorRag,
    feedback: vectorRag,
    state: new InMemoryRag(),
  })
  .withCircuitBreaker({ failureThreshold: 5, recoveryWindowMs: 30000 })
  .withToolCache(new ToolCache())
  .withSessionManager(new SessionManager(8000))
  .withHistorySummarization(20)

  // Priority 2 — quality + security
  .withQueryExpander(new LlmQueryExpander(classifierLlm))
  .withReranker(new LlmReranker(classifierLlm))
  .withLogger(cdsLogAdapter)

  // Pipeline (configured in code)
  .withPipeline(pipeline);
```

```
┌──────────────────────────────────────────────────┐
│              cloud-llm-hub (CF)                  │
│                                                  │
│  Consumers ──→ MCP Protocol (/mcp/stream/http)   │
│             ──→ OpenAI API  (/v1/*)              │
│             ──→ OData       (/odata/v4/agent/*)  │
│                                                  │
│  SmartAgent (pre-configured)                     │
│   ├── LLM: SAP AI Core ─────────────────────────│──→ SAP AI Core
│   ├── Embedder: SAP AI Core ────────────────────│──→ SAP AI Core
│   ├── RAG: VectorRag (in-memory / HANA) ────────│──→ SAP HANA Cloud
│   ├── MCP: McpClientAdapter ────────────────────│──→ MCP Proxy → ABAP
│   ├── Pipeline: classify → rag → assemble → tool│
│   ├── Circuit Breaker ──────────────────────────│
│   └── Logger → cds.log() ──────────────────────│──→ CF Log Drain
└──────────────────────────────────────────────────┘
```

### Implementation roadmap

1. **Now**: Priority 1 — VectorRag + AI Core embedder, circuit breaker, tool cache, sessions
2. **Next**: Priority 2 — query expansion, reranker, tool policy, output validation, logger
3. **When HANA available**: Priority 3 — HANA Vector IRag for persistent RAG
