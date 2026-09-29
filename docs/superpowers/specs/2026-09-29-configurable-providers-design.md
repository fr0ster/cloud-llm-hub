# Configurable providers — embedder, RAG backends, destination source

<!-- docs-check:proposed-env — this spec names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

**Status:** draft for review (rev. 14, tool corpus: current state only) · **Date:** 2026-09-29

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
  | persistent collections (scope `user`) | Qdrant when configured |

  Moving tools or sessions to Qdrant is a configuration change, not a code
  change.
- Persistent backends (Qdrant now, HANA Vector later) are vector-only by
  design. A backend failure is an explicit error, never a silent keyword
  fallback.
- **Everything is wired once, at startup, from the deploy's configuration.** A
  change of backend or embedding model is a redeploy. Nothing is switched,
  re-indexed or plugged in at runtime, although the framework could load RAG as
  a plugin.
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

### 4.1 One factory; stores synchronous, startup async

New `srv/lib/providers.ts`. It is the only code that turns config into
instances. It is built once at startup and handed to `agent-manager` through
`initProviders()`.

**Startup is async and light.** Tool vectors are computed at build time (§4.4),
so startup only loads. It is short enough to await:

1. `prefetchEmbedderFactories([embedder kind])`, which `resolveEmbedder`
   requires;
2. `buildProviders(config)`;
3. only then the collection registry, the RAG routes and the agents.

Today the registry is created synchronously inside `cds.on('bootstrap')`
(`server.ts:517`). That moves behind this async step.

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
- `listStores` / `deleteStore` / `countPoints` / `scrollStore` are backend
  operations (Qdrant REST `GET /collections`, `DELETE /collections/{name}`,
  `POST …/points/count`, `POST …/points/scroll`). They are not `IRag` methods.
  The in-memory backends answer from their own map.
- **Sync handle, async lifecycle.** `create` only builds a handle. Everything
  that talks to the backend is async: creating a catalog record, deleting,
  counting, scrolling, restoring. `CollectionRegistry.createCollection` /
  `deleteCollection` become `async`; their callers (the RAG HTTP handlers) are
  async already and are updated.

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

### 4.3 Persistent collections and their catalog (review items 2, 3, 4, 6)

**Scope.** Only `scope: 'user'` collections become persistent, which is the
access model the registry has today (`CollectionMeta.scope` is
`'user' | 'session'`, `listCollections` checks the owner). Role or global
collections would be a new access model and are out of this spec.

**Usage model.** A persistent collection is typically filled once and then
read. This is the intended use, **not an API restriction**: the existing
document operations (`updateDocument`, `deleteDocument`, `rag_correct`,
`rag_deprecate`) keep working as today on persistent collections. What the
service does not do is switch a collection's backend or embedding model while
it runs. The catalog is
read at startup; a collection created on one instance is seen by the others
after their next restart.

**Visibility while filling.** A collection is visible from the moment its
record exists, and every document whose backend write is confirmed is part of
it. There is no "filling" state and no publish step. That is today's
behaviour of in-memory collections, which fill upload by upload.

- A restore on any instance therefore shows exactly the confirmed documents.
  During an upload, or after an upload that was cut off, that is a partial
  collection, and it is expected.
- A caller that needs a complete set checks the document count it expects,
  or re-runs the upload. Uploads are idempotent per document id.

**Catalog.** llm-agent's `QdrantRagProvider` keeps **exactly one record per
collection** in a prefixed `rag_collection_catalog` collection. The provider
keys records by store name, and the store name is **deterministic**:
`<prefix>-<userCollectionId(logicalId, userId)>`, the owner-scoped id the
registry already uses, with no random suffix. Two users' `notes` are therefore
two stores and two records. Each record carries:

- `storeName` and `name`;
- the owner: `scope: 'user'` plus the user id;
- `attributes`, the hub's metadata:
  - the logical id, description, enabled state, source;
  - **`embedder`: the fingerprint of the model its vectors were written with.**

**Concurrency is the backend's.** Qdrant, HANA Vector and Postgres apply the
writes they are sent. The hub never writes a store itself; it asks the server
to, and concurrent requests and instances are coordinated there.

- The hub adds **no** cross-request or cross-instance coordination of its own:
  no writer election, no incarnation checks, no per-collection locks.
- The in-memory stores keep the locking they already have.
- The tool corpus is written once, at initialization, before the service
  accepts requests.
- **Conflicting mutations of one document:** the last write wins, in the
  order the backend applies it. There is no versioning. Concurrent editing of
  one document is not a supported workflow, because collections are filled once
  and then read. The in-memory map may apply two such writes in a different
  order until the next restart, which restores the backend's state.

**Mutations are backend-first.** Every document mutation (add, update, delete,
`rag_correct`, `rag_deprecate`) writes to the backend first and checks its
`Result`. Only on success does it update the in-memory `documents` map.

- On failure it returns an explicit error, and memory is untouched.
- The API never reports a change that a restart would undo.
- This extends §4.2's explicit-error contract from queries to writes.
- It applies to every backend; an in-memory backend simply never fails.

**Payload format.** The point id stays `doc:<collectionId>:<docId>`, as the
writer builds it today (`rag-collections.ts:759`). The payload explicitly
carries:

- `collectionId`;
- the short `docId`, which the API exposes;
- `createdAt` (ISO string);
- the existing metadata (`_createdAtMs`, source and chunk fields).

Restore keys the `documents` map by the payload's `docId` and takes `createdAt`
from the payload. It never derives either from the point id.

**Lifecycle.**

- **Create** (async): `provider.createCollection(store, {…, attributes})`. The
  provider serializes creation across instances by itself:
  - the store is created with a request that fails if it exists;
  - the record is written last, create-if-absent.

  A second, concurrent create of the same collection therefore fails
  explicitly, with `DuplicateCollectionError` (record present) or
  `OrphanStoreError` (store present, record not yet). The hub returns that
  error to the caller and never deletes anything in response.
- **Delete** (async): `provider.deleteCollection(store)`. The record goes first,
  then the store. A collection has only one record, so there is nothing a
  later start could restore it from.
  - A store left behind by an interrupted delete is an orphan under the same
    deterministic name.
  - Until it is removed, re-creating that collection fails with
    `OrphanStoreError`. It never starts on top of the old documents, and never
    races the orphan's removal.
- **Update** (async): `updateCollection` (rename, description) and `setEnabled`
  write the record's attributes, then update memory. The installed
  `QdrantRagProvider` has no method for this. **Prerequisite: a llm-agent PR**
  adding `updateCollection(storeName, { collectionName?, attributes })` to
  `IRagProvider` / `QdrantRagProvider`. It is our package, so the change goes
  there rather than into a hub-side workaround that writes catalog points
  directly.
- **Restore at startup** (async, the registry's `ready` promise):
  1. `describeCollections()` lists the records.
  2. For each record, `openCollection(record)` gives the handles.
  3. `scrollStore` reads every point's payload and rebuilds the collection's
     `documents` map. `listDocuments`, `getDocument`, the counters and export
     therefore work exactly as today.
  4. **Every registry method that touches a persistent collection awaits
     `ready` itself** and is therefore async. Callers cannot forget the wait:
     the RAG endpoints, the chat path (`openai-handler` resolves and attaches
     collections itself), the RAG tool dispatcher (which can auto-create
     collections) and presets all go through those methods. Session
     collections and SAP tool selection never wait.
- **Orphans:** a prefixed store without a record is logged at startup and
  **never deleted automatically**. Its absent record does not prove the delete
  was interrupted, because another instance may be between creating the store
  and writing the record. Orphans are removed only by an operator, directly in
  Qdrant.

**Embedder change.** Changing the model is a redeploy. On restore, the record's
embedder fingerprint is compared with the current one.

- **Equal:** the collection opens normally.
- **Different:** the collection is restored with status `incompatible`.
  - It is listed, and its documents can be read and exported, because they come
    from payload text.
  - Search and writes return an explicit error naming both fingerprints.
- **Recovery** is to fill the collection again, the way it was first filled:
  delete and re-create it, then load the documents. The export makes that
  possible without the original sources. There is no in-place reindex.

Session collections stay in memory unless `LLM_AGENT_SESSION_RAG_BACKEND=qdrant`
(§4.6).

### 4.4 Tool corpus: vectors are built, not computed at startup

The tool corpus is fully determined by code: the embedded MCP server's tool
sets (ABAP read-only, ABAP read-write, the RAG tools), taken from
`HandlerExporter`, plus the committed intents (`srv/tool-intents.json`).
Nothing about it changes after the build. Its vectors are therefore produced
at build/deploy time, and startup only loads them.

**Build step** (`tools/generate-tool-embeddings.ts`, extended):

- It builds the corpus from code, exactly as runtime does today.
- It embeds it with the embedder in the target configuration.
- It writes the result to the configured tools backend:
  - **in-memory:** nothing to build (keyword search, no vectors).
  - **vector:** a bundle file for that embedder's fingerprint. The committed AI
    Core bundle `srv/tool-embeddings.json` stays the default one.
  - **qdrant:** ONE store per role with a fixed name (`tools-reader`,
    `tools-writer`, under the prefix), holding the **current** corpus only.
    There are no generations and no history.
    - The role's catalog record carries the embedder fingerprint hash and the
      corpus hash (a hash of that role's sorted `(tool id, enriched text)`
      pairs).
    - When both hashes already match, the step skips the role.
    - Otherwise it replaces it: delete the old store and its record, write
      the current corpus, verify `countPoints` equals the expected count,
      then write the record.
- Locally, the `dev:local` script runs this step before starting. On BTP,
  `tools/deploy.sh` runs it before `cf deploy`, using the fork's target
  configuration.

**Startup** loads and never embeds the corpus:

- **in-memory / vector:** loads the bundle whose fingerprint and corpus match.
- **qdrant:** opens the fixed-name role stores when their records exist and
  both hashes equal the current fingerprint and corpus.
- **Nothing matching** means the build step did not run for this
  configuration. It is a deployment defect, reported as an explicit error
  naming the build step. The agents start without tool retrieval, and SAP tool
  requests fail with that error. There is no runtime vectorization of the tool
  corpus any more (`vectorizeToolDocs` at startup, the background build and the
  supplement path go).
- **Migration note:** a deployment whose embedder is not covered by the
  committed bundle (an `openai` embedder today) must run the build step from
  now on.

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
- **A `dev:local` npm script:**
  - warns when a `default-env.json` would make the run hybrid;
  - runs the tool-vector build step for the local configuration (§4.4). It
    exits early when the matching bundle or the up-to-date Qdrant role stores
    already exist;
  - then runs `cds watch --profile development`.
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
- Registry lifecycle: `createCollection` / `deleteCollection` are async;
  collection endpoints wait for `ready`.

**Integration, env-gated** (skipped without `LLM_AGENT_QDRANT_URL`; a throwaway
Qdrant on an isolated port, never 6333)

- **Collections:**
  - create → restart (new registry over the same Qdrant) → list, get, export,
    search and delete work; document counts equal those before the restart;
  - an orphan store is reported;
  - after a restart, document ids, `createdAt`, update and delete behave
    exactly as before it;
  - create → update (rename, description, enabled) → restart keeps the
    update;
  - two owners with the same logical id stay independent across delete and
    restart;
  - delete interrupted between record and store, then restarted: the collection
    stays gone, and the store is reported as an orphan;
  - re-creating that name fails with `OrphanStoreError` until an operator
    removes the orphan; afterwards it starts empty;
  - two concurrent creates of the same collection: exactly one succeeds, the
    other gets an explicit duplicate/orphan error, nothing is deleted;
  - on a persistent collection, `updateDocument`, `deleteDocument`,
    `rag_correct` and `rag_deprecate` behave as on an in-memory one;
  - update and delete with Qdrant failing: an explicit error, the map is
    unchanged, and after a restart the document is exactly as before;
  - visibility while filling: create a collection and pause a bulk upload
    after some documents; a second registry restoring from the same Qdrant
    lists the collection with exactly the documents confirmed so far. After
    the upload resumes and completes, the next restore shows all of them;
  - a chat request that names a collection while restore is slow waits and
    finds it, and no duplicate is auto-created;
  - a record with a different embedder fingerprint restores as `incompatible`:
    export works, search refuses, and delete plus re-create plus reload makes it
    searchable again.
- **Tool vectors (build step and startup):**
  - startup with a matching bundle, or with Qdrant role stores whose records
    match, makes zero embedding calls;
  - startup without one reports the explicit build-step error and embeds
    nothing;
  - a build run interrupted before the record is completed by the next build
    run;
  - a corpus or embedder change makes the build replace the role store in
    place; there is exactly one store per role afterwards.
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
   - Depends on the llm-agent `updateCollection` release (§4.3).
2. **Session stores on Qdrant (§4.6).**
3. **HANA Vector backend.** A separate spec, in the `poc-hana-rag` context.

## 8. Risks

- **Session affinity on direct destinations.** The first task of phase 1 checks
  it; `CloudSdkAbapConnection` rules stay untouched.
- **Qdrant latency for tool selection.** Measured; tools stay in memory unless
  the numbers say otherwise.
- **Catalog and store drift after a crash.** The record is written last and
  deleted first; orphans are reported at startup.
- **Startup time with many persistent documents.** Restore scrolls every
  payload. It is measured in the local acceptance; collection endpoints wait
  for it, tool selection does not.
- **Local model quality.** The document names a tested tool-calling model and
  calls this a development setup.
