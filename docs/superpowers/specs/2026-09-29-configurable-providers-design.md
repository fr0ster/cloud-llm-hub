# Configurable providers — embedder, RAG backends, destination source

<!-- docs-check:proposed-env — this spec names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

**Status:** draft for review (rev. 2, after static review) · **Date:** 2026-09-29

## TL;DR

- The LLM provider is chosen in configuration; the **embedder**, the **RAG
  backends** and the **source of SAP destinations** are not. The code
  hard-wires `VectorRag` / `InMemoryRag` in three places and derives the
  embedder from the LLM provider.
- One mechanism for every store the hub keeps. The backend is chosen **per
  store class** in configuration:

  | Store class | Default |
  |---|---|
  | tool corpus | in-memory, as today |
  | session (session collections + conversation history) | in-memory, as today |
  | persistent collections (user, role, global) | Qdrant when configured |

  Moving tools or sessions to Qdrant is a configuration change, not a code
  change.
- Persistent backends (Qdrant now, HANA Vector later) are vector-only by
  design. A backend failure is an explicit error, never a silent keyword
  fallback.
- A local run is one configuration: Ollama, Qdrant, destinations from the
  environment. It runs the full agent against a real SAP system through the
  production connection class.

## 1. Problem

| What | Today | Where |
|---|---|---|
| LLM | configurable | `agent-config.ts:135`, `lib/llm-factory.ts` |
| Embedder | follows the LLM provider | `agent-manager.ts:995-1036` |
| RAG backend | `LLM_AGENT_RAG_TYPE`: `in-memory`, else in-process `VectorRag` | `agent-manager.ts:1000, 1070-1082, 1100-1111` |
| Collections | `CollectionRegistry`: catalog only in a `Map`, `qdrant` a placeholder | `rag-collections.ts:60-106, 405-406` |
| Destinations | BTP Destination Service only | `lib/btp-destinations.ts:132-160` |

The consequences:

- Nothing survives a restart.
- `qdrant-rag` and `ollama-embedder` are dependencies that nothing uses.
- A local run has no SAP tools without BTP.

## 2. Goals and non-goals

**Goals**

1. Embedder, per-class RAG backend and destination source are chosen in
   configuration, independently.
2. Persistent collections live in Qdrant **with their catalog**, and come back
   after a restart: searchable, exportable, deletable.
3. Tool corpus and session stores can be moved to Qdrant by configuration.
4. The full agent runs locally against a real SAP system without BTP, over
   `CloudSdkAbapConnection`.
5. A local kit: env template, Qdrant compose file, a `dev:local` npm script,
   a document.

**Non-goals**

- The HANA Vector backend. It comes later through the same factory, for the
  `poc-hana-rag` fork.
- A configuration file. Configuration stays in environment variables.
- Changing default behaviour. With no new variable set, the hub builds exactly
  what it builds today. A unit test enforces this.

## 3. Configuration

Everything is parsed in `srv/agent-config.ts` only. No component reads these
variables.

| Variable | Values | Default |
|---|---|---|
| `LLM_AGENT_EMBEDDER` | `sap-ai-core` \| `openai` \| `ollama` | `sap-ai-core` if `LLM_AGENT_PROVIDER=sap-ai-sdk`, else `openai` |
| `LLM_AGENT_EMBEDDING_MODEL` | model | `text-embedding-3-small` (existing) |
| `LLM_AGENT_EMBEDDER_URL` | base URL | `openai`: `LLM_AGENT_BASE_URL`; `ollama`: `http://localhost:11434` |
| `LLM_AGENT_EMBEDDER_API_KEY` | secret | `openai`: `LLM_AGENT_API_KEY` |
| `LLM_AGENT_RAG_BACKEND` | `in-memory` \| `vector` \| `qdrant` | persistent collections. Derived from `LLM_AGENT_RAG_TYPE` as today (`in-memory` → `in-memory`, else `vector`) |
| `LLM_AGENT_TOOLS_RAG_BACKEND` | same | `in-memory` if `LLM_AGENT_RAG_TYPE=in-memory`, else `vector` (today) |
| `LLM_AGENT_SESSION_RAG_BACKEND` | same | same as tools (today) |
| `LLM_AGENT_QDRANT_URL` | URL | required when any class uses `qdrant` |
| `LLM_AGENT_QDRANT_API_KEY` | secret | none |
| `LLM_AGENT_QDRANT_PREFIX` | name prefix | `cloud-llm-hub` |
| `LLM_AGENT_DESTINATION_SOURCE` | `btp` \| `env` | `btp` |

**Rules:**

- **Fail fast on shape.** Startup throws on:
  - an unknown value;
  - `qdrant` without a URL;
  - an explicit embedder when every class is `in-memory`;
  - `LLM_AGENT_RAG_TYPE` and a class variable that contradict each other.
- **No timeouts are introduced.** `QdrantRag` has none by default, and we pass
  none.

## 4. Design

### 4.1 One factory, synchronous

New `srv/lib/providers.ts`. It is the only code that turns config into
instances. It is built once at bootstrap and handed to `agent-manager` through
`initProviders()`.

**Embedder** (`IEmbedder | null`):

- `ollama` / `openai`: `resolveEmbedder` (`@mcp-abap-adt/llm-agent-rag`);
- `sap-ai-core`: the hub's `SapAiCoreEmbedder` via `composeEmbedder`;
- every embedder is wrapped in `CircuitBreakerEmbedder`.

**Store factory** (`RagStoreFactory`). Construction is synchronous, so the
existing sync contracts (`RagBackendFactory`, `createRagStore`,
`getSharedHistoryRag`) stay as they are:

```ts
interface RagStoreFactory {
  create(storeClass: 'tools' | 'session' | 'persistent', name: string,
         opts?: VectorStoreOptions): IRag;          // sync
  deleteStore(storeClass, name): Promise<Result<void, RagError>>;
  listStores(storeClass, prefix: string): Promise<Result<string[], RagError>>;
}
```

- `in-memory`: `new InMemoryRag()`.
- `vector`: today's `FallbackRag(VectorRag, InMemoryRag, breaker)`, unchanged.
- `qdrant`: `new QdrantRag({ url, collectionName, embedder, credential })`.
  Its constructor is synchronous, and the collection is created on the first
  write. It is **not** wrapped in `FallbackRag`.
- `listStores` / `deleteStore` are backend operations (Qdrant REST
  `GET /collections`, `DELETE /collections/{name}`). They are not `IRag`
  methods. The in-memory backends answer from their own map.

**Destination source** (`DestinationSource`), §4.5.

`RagStoreFactory` and `DestinationSource` are hub-local contracts: only the hub
uses them.

### 4.2 Failure handling (review item 1)

- **`vector` (today):** `FallbackRag` falls back to keyword search only while the
  embedder breaker is open. This stays as it is.
- **`qdrant`:** a Qdrant or embedder failure returns a `RagError`, and the
  caller surfaces it:
  - tool selection fails the request with an explicit message naming the
    backend;
  - a collection query returns the error to its caller.
- There is no keyword copy in memory. Keyword matching was a crutch
  (§4.7), and a copy that is populated only by writes would be
  empty after a restart anyway.
- **Tests:**
  - Qdrant down gives an explicit error on each path;
  - embedder down gives an explicit error, and the breaker's open state is
    reported.

### 4.3 Persistent collections and their catalog (review item 2)

Persistent collections use llm-agent's `QdrantRagProvider`. It keeps a catalog,
one record per collection, in a Qdrant collection (`rag_collection_catalog`,
prefixed). Each record carries:

- `storeName` and `name`;
- the owner: `scope` = `user` | `global`, plus the owner id;
- opaque `attributes`, where the hub keeps its own metadata: role, description,
  enabled state, source.

`CollectionRegistry` changes as follows:

- **Create:** `provider.createCollection(store, { scope, owner, collectionName,
  attributes })`. The record is written last, so a crash leaves no half
  collection.
- **Startup:** `provider.describeCollections()` → `openCollection(record)` for
  each record. This rebuilds the registry's `Map`, so collections come back
  searchable, exportable and deletable.
- **Delete:** `provider.deleteCollection(store)` deletes the record first, then
  the store.
- **Orphans:** a store with the prefix but without a record (from a crash
  between the two writes) is listed and logged at startup, never auto-deleted.
- **Owner isolation** is unchanged. Role collections are `global` with
  `attributes.role`; the hub's existing checks read that.

Session collections stay in the registry's in-memory path unless
`LLM_AGENT_SESSION_RAG_BACKEND=qdrant` (§4.6).

### 4.4 Tool corpus (review item 5)

- **In memory (default):** unchanged. It is loaded at startup from the bundle,
  or vectorized at runtime.
- **On `qdrant`: the stores are immutable and content-addressed.**
  - Each role's store is named `tools-<role>-<fp>-<corpus>`, where `<fp>` is the
    embedder fingerprint hash and `<corpus>` is a hash of that role's sorted
    `(tool id, enriched text)` pairs.
  - **Startup:**
    1. Compute both names. A store that exists is used as it is, with zero
       embedding and zero diff.
    2. A store that is missing is written in full: from the bundle when its
       fingerprint matches (zero embedding calls), else by runtime
       vectorization.
    3. Afterwards, `listStores('tools', 'tools-<role>-')` finds and deletes
       every other generation of that role.
  - This needs no enumeration of points and no per-record diff. A tool that
    moves between roles changes both hashes and is handled by the same path.

### 4.5 Destination source

```ts
interface DestinationSource { list(): Promise<SapDestination[]> }
```

- **`BtpDestinationSource`:** today's `fetchDestinations` together with its
  filter and fallback, moved as it is.
- **`EnvDestinationSource`:** lists the Cloud SDK's own `destinations` JSON.
  - Example entry:
    `[{"name":"SAP_DEV","url":"https://host:44300","proxyType":"Internet","authentication":"NoAuthentication","sapClient":"100"}]`.
  - `getDestination` / `executeHttpRequest` already read that variable, so
    `resolveDestinationSapConfig` and `CloudSdkAbapConnection` stay unchanged.
  - SAP credentials still come per request from `x-sap-login` /
    `x-sap-password`, never from the environment.
- **First plan task:** verify session affinity on a direct (`Internet`) path.
  SAP issues its own `SAP_SESSIONID` there. A LOCK → update → UNLOCK chain must
  stay on one session, and no lock may be left behind.

### 4.6 Session stores on Qdrant — phase 2 (review item 3)

`LLM_AGENT_SESSION_RAG_BACKEND=qdrant` is accepted by configuration only after
phase 2 ships; until then it fails fast with "not yet supported". Phase 2 adds:

- **Conversation history.** `SessionHistoryRag` keeps its in-memory `ids` map
  for the in-memory backend. On Qdrant it uses backend operations keyed by
  `owner`:
  - delete by filter (`forgetOwner`);
  - count and trim oldest by filter (the 200-turn limit).

  These are Qdrant point operations with a payload filter, exposed on
  `RagStoreFactory` as `deleteWhere` / `trimOldest`. They are not `IRag`
  methods.
- **Session collections.** They use the same catalog as §4.3 with
  `scope: 'session'`.
- **Tests:** every operation is checked **after a restart**. `forgetOwner`
  removes turns written by the previous process, and the limit counts them too.

### 4.7 Retrieval model

- Persistent backends are vector-only; that is intended.
- Query language is the embedding model's job, so the local preset uses a
  multilingual model.
- Any corpus change still gets the tool-RAG check (31 queries × 2 roles). It is
  a measurement, not a gate.

## 5. Local run kit

- **`.env.local.example`:**
  - Ollama for the LLM (`/v1`) and the embedder;
  - `LLM_AGENT_RAG_BACKEND=qdrant`; tools and session in-memory;
  - `LLM_AGENT_DESTINATION_SOURCE=env` with one placeholder destination;
  - no credentials.
- **`docker-compose.local.yml`:** Qdrant only (Ollama runs natively).
  - Project `cloud-llm-hub-local`, named volume.
  - Host ports **6433 / 6434**. 6333 is commonly taken by other projects' Qdrant.
- **A `dev:local` npm script:** warns when a `default-env.json` would make the
  run hybrid, then runs `cds watch --profile development`.
- **`docs/development/LOCAL_RUN.md`:** TL;DR, prerequisites, five steps, calling
  the agent with `x-sap-login` / `x-sap-password`, troubleshooting.
- `README.md`, `docs/llm-agent/CONFIG_USAGE.md` and `.env.example` get the new
  variables.

## 6. Testing

**Unit**

- Config parsing: defaults equal today; every conflict throws.
- `providers.ts`:
  - which classes are built per configuration;
  - the default configuration builds today's objects.
- Failure paths of §4.2.
- `EnvDestinationSource`.
- Tool-store naming: a role move changes both hashes; an unchanged corpus gives
  the same name.

**Integration, env-gated** (skipped without `LLM_AGENT_QDRANT_URL`; a throwaway
Qdrant on an isolated port, never 6333)

- **Collections:** create → restart (new registry over the same Qdrant) →
  search, export and delete work. An orphan store is reported.
- **Tools on Qdrant:**
  - a second start makes zero embedding calls;
  - a corpus change writes a new generation and deletes the old one.
- **Qdrant down:** explicit errors.

**Speed**

- Tool-selection latency, in-memory vs Qdrant, measured locally on the full
  corpus (p50/p95 over the 31-query set).
- The result is recorded in the spec's follow-up, and decides whether the local
  preset moves tools to Qdrant.

**Live acceptance (local)**

- A read request runs a real `ReadClass` through an env destination.
- A persistent collection survives a restart.
- A write chain on a scratch object in a package we own leaves no lock.

**Regression**

- The fork's staging deploy with unchanged `.mtaext` behaves as today.

## 7. Phases

1. **Configuration and factory.**
   - Embedder and destination source; persistent collections on Qdrant with the
     catalog; tools on Qdrant (content-addressed).
   - The local kit; the speed measurement.
2. **Session stores on Qdrant (§4.6).**
3. **HANA Vector backend.** A separate spec, in the `poc-hana-rag` context.

## 8. Risks

- **Session affinity on direct destinations.** The first task of phase 1 checks
  it; `CloudSdkAbapConnection` rules stay untouched.
- **Qdrant latency for tool selection.** Measured; tools stay in memory unless
  the numbers say otherwise.
- **Catalog and store drift after a crash.** The record is written last and
  deleted first; orphans are reported at startup.
- **Local model quality.** The document names a tested tool-calling model and
  calls this a development setup.
