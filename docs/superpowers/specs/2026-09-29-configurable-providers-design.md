# Configurable providers — embedder, RAG backends, destination source

<!-- docs-check:proposed-env — this spec names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

**Status:** draft for review (rev. 8, after seven static reviews) · **Date:** 2026-09-29

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
  - **`incarnation`: a UUID generated on every create.** A delete and re-create
    under the same deterministic name therefore yields a different record.
  - **`embedder`: the fingerprint of the model its vectors were written with.**

**One writing instance.** Only one instance mutates persistent collections:
the instance with `CF_INSTANCE_INDEX=0`, or the only process in a local run.
Mutations cover create and delete of a collection, document add, update and
delete, `rag_correct`, `rag_deprecate`, collection update and `setEnabled`.

- Every other instance using the same prefix serves persistent collections
  read-only. A mutation there fails with an explicit `COLLECTION_READ_ONLY`
  error that names the writing instance.
- With a single writer there is no race between two writers: no instance can
  delete or re-create a collection between another writer's check and write.
- The writer is decided by the builder at startup (config reads
  `CF_INSTANCE_INDEX`), not by the registry.
- **Residual risk: a rolling deploy.** For a short window an old and a new
  instance may both have index 0. The incarnation check below narrows that
  window without closing it. Delete and re-create of a persistent collection
  should not be done during a deploy; `LOCAL_RUN.md` and the deployment
  README say so.

**Stale handles.** A handle remembers the `incarnation` it was opened with.

- **Every mutation** of a persistent collection, including its own delete,
  re-reads its record first. If the record is absent or its `incarnation`
  differs, the mutation fails with an explicit `COLLECTION_STALE` error, which
  tells the caller to restart the instance, and nothing is written.
- This check is a cheap guard for the rolling-deploy window, **not a
  concurrency guarantee**. Check-then-write is not atomic, and Qdrant offers no
  compare-and-set. The guarantee is the single writer above.
- **Reads** skip the check. As stated above, changes made on another instance
  become visible after a restart.

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
  and writing the record. Orphans are removed only by the operator-run
  `tools/rag-gc.ts`, which lists them with their age and deletes only the ones
  named or older than a given age, when no writer is active.

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

### 4.4 Tool corpus (review items 5, 1, 2)

- **In memory (default):** unchanged. It is loaded at startup from the bundle,
  or vectorized at runtime.
- **On `qdrant`: content-addressed generations with a completion record.**
  - Each role's store is `tools-<role>-<fp>-<corpus>`. `<fp>` hashes the embedder
    fingerprint; `<corpus>` hashes that role's sorted `(tool id, enriched text)`
    pairs.
  - **A generation is complete only when its catalog record exists.** The record
    is written after all points are upserted AND `countPoints` equals the
    expected count.
  - **Startup, per role:**
    1. Record present: use the store, with no writes and no embedding.
    2. Record absent: upsert every point (from the bundle when its fingerprint
       matches, else by runtime vectorization), verify the count, then write
       the record.

       This covers a crash mid-write: the next start finds no record and
       writes again. Point IDs are deterministic, so re-writing is idempotent.
  - **Parallel instances (rolling deploy, several instances):**
    - Instances with the same corpus and embedder resolve to the same name and
      write identical points. The record's create-if-absent makes the second
      write a no-op.
    - Nothing deletes another generation at startup, so an old instance keeps
      its store while it runs.
  - **Cleanup** is a separate, operator-run tool (`tools/rag-gc.ts`). It lists
    generations per role together with their records, and deletes only the
    generations the operator names, or those older than a given age. It never
    deletes the generation the running configuration resolves to.

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
  - re-creating that name fails with `OrphanStoreError` until `rag-gc`
    removes the orphan; afterwards it starts empty;
  - two concurrent creates of the same collection: exactly one succeeds, the
    other gets an explicit duplicate/orphan error, nothing is deleted;
  - on a persistent collection, `updateDocument`, `deleteDocument`,
    `rag_correct` and `rag_deprecate` behave as on an in-memory one;
  - update and delete with Qdrant failing: an explicit error, the map is
    unchanged, and after a restart the document is exactly as before;
  - single writer:
    - an instance with `CF_INSTANCE_INDEX=1` serves reads, and every mutation,
      delete of the collection included, fails with `COLLECTION_READ_ONLY`
      and writes nothing;
  - stale guard, with two writers simulated as in the deploy window:
    - B deletes and re-creates a collection that A has open;
    - A's next mutation fails with `COLLECTION_STALE`;
    - after A's restart, A sees B's collection;
    - the check-then-write race is explicitly out of scope, per the
      single-writer rule;
  - a chat request that names a collection while restore is slow waits and
    finds it, and no duplicate is auto-created;
  - a record with a different embedder fingerprint restores as `incompatible`:
    export works, search refuses, and delete plus re-create plus reload makes it
    searchable again.
- **Tools on Qdrant:**
  - a second start makes zero embedding calls;
  - a partial write (crash simulated before the record) is completed on the
    next start;
  - two registries starting concurrently on the same corpus both end with one
    complete generation;
  - a corpus change writes a new generation and leaves the old one;
    `rag-gc` removes it on request.
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
- **Two writers during a rolling deploy.** The single-writer rule holds outside
  that window; inside it, the incarnation check narrows the window and the
  documentation forbids collection delete/re-create during a deploy.
- **Catalog and store drift after a crash.** The record is written last and
  deleted first; orphans are reported at startup.
- **Startup time with many persistent documents.** Restore scrolls every
  payload. It is measured in the local acceptance; collection endpoints wait
  for it, tool selection does not.
- **Local model quality.** The document names a tested tool-calling model and
  calls this a development setup.
