# Configurable providers — embedder, RAG backend, destination source

**Status:** draft for review · **Date:** 2026-09-29

## TL;DR

- The LLM provider is already chosen in configuration (`LLM_AGENT_PROVIDER`).
  The **embedder**, the **RAG backend** and the **source of SAP destinations**
  are not: the code hard-wires `VectorRag` / `InMemoryRag` in three places and
  derives the embedder from the LLM provider.
- Add three settings next to `LLM_AGENT_PROVIDER`, read in one place
  (`agent-config.ts`), turned into instances in one place (a composition
  module), and handed to the components that use them.
- Qdrant becomes a real backend for every store the hub keeps (tool corpus,
  conversation history, user collections), on BTP or anywhere else.
- A local run is then just one configuration: Ollama for the LLM and the
  embeddings, Qdrant for RAG, destinations from the environment. It runs the
  full agent against a real SAP system, over the same connection class as
  production.

## 1. Problem

| What | Today | Where |
|---|---|---|
| LLM | configurable: `sap-ai-sdk` / `openai` / `anthropic` / `deepseek` | `agent-config.ts:135`, `lib/llm-factory.ts` |
| Embedder | follows the LLM provider: `sap-ai-sdk` → AI Core, anything else → OpenAI `/embeddings` at the LLM's base URL | `agent-manager.ts:995-1036` |
| RAG backend | `LLM_AGENT_RAG_TYPE`: `in-memory`, or anything else meaning in-process `VectorRag` | `agent-manager.ts:1000, 1070-1082, 1100-1111` |
| User collections | `CollectionRegistry` has a `RagBackend` contract and a `qdrant` placeholder nobody registers | `rag-collections.ts:60-106, 405-406` |
| Destinations | BTP Destination Service only (OnPremise + Basic), falling back to `LLM_AGENT_MCP_DESTINATION` | `lib/btp-destinations.ts:132-160` |

Consequences:

- Nothing the hub learns survives a restart. All vectors live in process
  memory, and a non-AI-Core embedder re-vectorizes the whole tool corpus on
  every start.
- The `qdrant-rag` and `ollama-embedder` packages are dependencies but unused.
- A local run cannot give the agent SAP tools without BTP: the agent paths only
  know destinations, and destinations only come from BTP.

## 2. Goals and non-goals

**Goals**

1. Choose the embedder, the RAG backend and the destination source in
   configuration, independently of each other and of the LLM provider.
2. Qdrant as a backend for all three RAG stores, with the tool corpus
   persisted: a restart with an unchanged embedder does no embedding work.
3. A local run of the full agent against a real SAP system, without BTP,
   through `CloudSdkAbapConnection`, the class production uses.
4. A local kit: an env template, a Qdrant compose file, one npm script, and a
   document.

**Non-goals**

- HANA / pg-vector backends. The design leaves room for them (§4.2), and the
  `poc-hana-rag` fork adds HANA later.
- Moving collections to llm-agent's `IRagProvider` catalog model. The hub keeps
  its own `CollectionRegistry` and owner-in-name isolation.
- A configuration file. Configuration stays in environment variables: on BTP
  from the fork's `.mtaext`, locally from `.env`.
- Changing the default behaviour. With none of the new variables set, the hub
  builds exactly what it builds today.

## 3. Configuration

All parsed in `srv/agent-config.ts` into typed config. No component reads
`process.env` for these (rule: configuration belongs to the builder).

| Variable | Values | Default (= today) |
|---|---|---|
| `LLM_AGENT_EMBEDDER` | `sap-ai-core` \| `openai` \| `ollama` | `sap-ai-core` if `LLM_AGENT_PROVIDER=sap-ai-sdk`, else `openai` |
| `LLM_AGENT_EMBEDDING_MODEL` | model name | `text-embedding-3-small` (existing variable) |
| `LLM_AGENT_EMBEDDER_URL` | base URL | `openai`: `LLM_AGENT_BASE_URL`; `ollama`: `http://localhost:11434` |
| `LLM_AGENT_EMBEDDER_API_KEY` | secret | `openai`: `LLM_AGENT_API_KEY` |
| `LLM_AGENT_RAG_BACKEND` | `in-memory` \| `vector` \| `qdrant` | derived from `LLM_AGENT_RAG_TYPE`: `in-memory` → `in-memory`, anything else → `vector` |
| `LLM_AGENT_QDRANT_URL` | URL | none; required when the backend is `qdrant` |
| `LLM_AGENT_QDRANT_API_KEY` | secret | none (unauthenticated Qdrant) |
| `LLM_AGENT_QDRANT_PREFIX` | collection-name prefix | `cloud-llm-hub` |
| `LLM_AGENT_DESTINATION_SOURCE` | `btp` \| `env` | `btp` |

- `LLM_AGENT_RAG_TYPE` stays accepted and is mapped as above. A value set in
  both places must agree, or startup fails.
- **Fail fast on shape, degrade on outage.** An unknown value, `qdrant` without
  a URL, or `in-memory` together with an explicit embedder all throw at
  bootstrap: that is a deployment mistake. An unreachable Qdrant or embedder at
  runtime degrades through `FallbackRag` to keyword search, as the vector path
  does today.
- No timeouts are introduced. `QdrantRag` has no default timeout and we pass
  none (rule: the consumer closes the connection).

## 4. Design

### 4.1 Composition module

New `srv/lib/providers.ts`. It is the only code that turns the typed config into
instances. It builds three things, once, at startup:

- **`embedder: IEmbedder | null`**
  - `ollama` / `openai`: `resolveEmbedder` from `@mcp-abap-adt/llm-agent-rag`;
  - `sap-ai-core`: the hub's own `SapAiCoreEmbedder`, passed through
    `composeEmbedder`;
  - every embedder is wrapped in the existing `CircuitBreakerEmbedder`;
  - `null` for `in-memory`.
- **`rag: RagStoreFactory`**, with
  `create(name, opts?: { queryPreprocessors, documentEnrichers }) → Promise<IRag>`:
  - `in-memory`: `InMemoryRag`;
  - `vector`: `FallbackRag(VectorRag(...), InMemoryRag, breaker)`, exactly
    today's construction;
  - `qdrant`: `FallbackRag(makeRag({ type: 'qdrant', ... }), InMemoryRag, breaker)`.
    The collection name is `<prefix>-<name>`, adapted to Qdrant's naming rules;
  - the factory also exposes `deleteStore(name)` for backends whose stores are
    physical.
- **`destinations: DestinationSource`**, either `BtpDestinationSource` or
  `EnvDestinationSource` (§4.4).

`agent-manager.ts` gets these through an `initProviders(providers)` call from
`server.ts` bootstrap. It stops reading config to decide what to build:

- `getOrCreateEmbedder` is replaced by `providers.embedder`;
- `createToolsRagStore`, `getSharedHistoryRag` and `getCollectionRegistry` ask
  `providers.rag` for their stores;
- `CollectionRegistry` registers the configured backend as its default through
  its existing `registerBackend`, including `deleteStore`.

`RagStoreFactory` and `DestinationSource` are hub-local contracts, because only
the hub uses them. Nothing moves to `@mcp-abap-adt/interfaces`.

### 4.2 Store names

| Store | Name | Lifetime |
|---|---|---|
| Tool corpus, reader | `tools-reader-<fp>` | shared by every destination |
| Tool corpus, writer | `tools-writer-<fp>` | shared by every destination |
| History | `history-<fp>` | one store; turns keyed by owner (unchanged) |
| User collection | `collection-<id>-<nonce>` (existing `storeNameFor`) | deleted with the collection |

- `<fp>` is a short hash of the embedder fingerprint (provider, model, URL).
  Changing the embedder therefore writes to new stores and never mixes vector
  spaces. Stale stores are logged at startup, not deleted.
- Owner isolation is unchanged. It lives in names and keys the hub already
  controls.

### 4.3 Tool corpus on a persistent backend

`ensureSharedToolsVectorized` keeps its current decision, the bundle plan, and
adds one step first:

1. **Persistent backend, stores already hold the corpus:** per tool, compare the
   stored point's text with the current enriched text. The IDs are
   deterministic (`QdrantRag` derives a UUID from the key). Equal texts mean no
   work. Only changed or missing tools are embedded and upserted, and tools no
   longer exported are deleted. **This is the restart path.**
2. **Otherwise:** today's logic. If the bundle's fingerprint matches the
   embedder, it is upserted precomputed (zero embedding calls); else the corpus
   is vectorized at runtime. On `qdrant` this happens once per embedder, not
   once per start.

### 4.4 Destination source

```ts
interface DestinationSource {
  list(): Promise<SapDestination[]>;
}
```

- **`BtpDestinationSource`** is today's `fetchDestinations` plus its filter and
  its `LLM_AGENT_MCP_DESTINATION` fallback, moved without change of behaviour.
- **`EnvDestinationSource`** reads the Cloud SDK's own `destinations` variable,
  a JSON array such as
  `[{"name":"SAP_DEV","url":"https://host:44300","proxyType":"Internet","authentication":"NoAuthentication","sapClient":"100"}]`.
  - It lists those entries.
  - The Cloud SDK's `getDestination` / `executeHttpRequest` already read the
    same variable, so `resolveDestinationSapConfig` and `CloudSdkAbapConnection`
    work unchanged.
  - SAP credentials still come per request from `x-sap-login` / `x-sap-password`,
    through the existing Basic override. No SAP user or password is ever put in
    the environment.
  - `ProxyType: Internet` goes direct, with no connectivity proxy. The connection
    code already covers Internet destinations (`request-connection.ts:10-13`).
  - **To verify in the plan's first task:** SAP issues its own `SAP_SESSIONID`
    on a direct path, and `CloudSdkAbapConnection` must keep it rather than
    generating one. A LOCK → update → UNLOCK chain must run on one session.

### 4.5 Tool-RAG ranking on Qdrant

`QdrantRag` is vector-only. It lacks the keyword component
(`vectorWeight 0.7 / keywordWeight 0.3`) and the `TranslatePreprocessor` that
the tool corpus uses on `vector` today.

- A hub decorator, `PreprocessedQueryRag`, applies the `queryPreprocessors` to
  the query text before delegating. **It is built only if** the first plan task
  confirms that `IQueryEmbedding` exposes the text.
- **Acceptance rule:** before `qdrant` is recommended for the tool corpus
  anywhere, its ranking is measured with the tool-RAG check (the 31-query ×
  2-role set used for the lib 13.1 corpus) against `vector`. A pattern test is
  no substitute for that measurement.
  - Worse ranking stays documented; tools keep `vector` in the recommended
    presets.
  - Such a split then needs a separate `LLM_AGENT_TOOLS_RAG_BACKEND`, added
    only if the measurement demands it.

## 5. Local run kit

- **`.env.local.example`**: `LLM_AGENT_PROVIDER=openai` pointing at Ollama's
  `/v1`, `LLM_AGENT_EMBEDDER=ollama`, `LLM_AGENT_RAG_BACKEND=qdrant` with the
  compose port, `LLM_AGENT_DESTINATION_SOURCE=env` and one sample `destinations`
  entry (placeholder host). No credentials.
- **`docker-compose.local.yml`**: Qdrant only (Ollama runs natively, for the
  GPU).
  - Compose project `cloud-llm-hub-local`, named volume, host port **6433**
    (HTTP) and 6434 (gRPC). The default 6333 is often taken by other projects'
    Qdrant, and sharing it would write the hub's data into theirs.
- **`npm run dev:local`**: checks that no `default-env.json` would silently make
  the run hybrid (it warns and names the file), then runs
  `cds watch --profile development`.
- **`docs/development/LOCAL_RUN.md`**: TL;DR first. Prerequisites (Ollama plus a
  tool-calling model and an embedding model, Docker, a SAP system reachable from
  the machine), five steps, how to call the agent with `x-sap-login` /
  `x-sap-password`, troubleshooting.
- `README.md`, `docs/llm-agent/CONFIG_USAGE.md` and `.env.example` get the new
  variables.

## 6. Testing

- **Unit:**
  - config parsing: defaults equal today, every conflict and missing value
    throws;
  - `providers.ts`: for each configuration, which classes are built. The
    default configuration must yield exactly today's objects;
  - `EnvDestinationSource`;
  - the restart-diff of §4.3, against an in-memory store;
  - `PreprocessedQueryRag`, if it is built.
- **Integration, env-gated** (skipped without `LLM_AGENT_QDRANT_URL`):
  - Qdrant store create, upsert, query, delete;
  - tool-corpus persistence: a second start makes zero embedding calls.
  - Runs against a throwaway Qdrant on an isolated port, never 6333.
- **Live acceptance (local):**
  - with the kit, the agent answers a read request with a real `ReadClass` on a
    SAP system through an env destination;
  - a restart logs no vectorization;
  - a write chain (create + activate of a scratch object in a package we own)
    leaves no lock behind.
- **Regression on BTP:** the fork's staging deploy with unchanged `.mtaext` must
  behave as today (default configuration).

## 7. Risks

- **Ranking regression on Qdrant.** Covered by §4.5's measurement rule.
- **Session affinity on direct destinations.** Covered by the first plan task;
  the rules of `CloudSdkAbapConnection` stay untouched.
- **Local model quality.** Small Ollama models call tools poorly. The document
  names a tested model and says plainly that this is a development setup.
- **Default drift.** Covered by the "default configuration builds today's
  objects" unit test.
