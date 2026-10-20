# Persistent RAG collections on a vector database (Plan B, revised)

Status: design, for review.
Branch `feat/persistent-rag-collections`, tested on a deployment branch against a test subaccount, then sent to cloud-llm-hub as a PR.
Depends on **@mcp-abap-adt/llm-agent 30.3.0**: `IRagScanner`, `IRagFilteredDeleter` and `IRagCatalogUpdater`, plus the `shared` table layout from 30.2.0.

## 1. Intent

The hub's RAG collections and the session history live in process memory and are lost on every restart. The 2026-09-29 spec (§4.3, §4.6, "Plan B") designed their persistence, but it waited for a vector database. A test subaccount now has one: SAP HANA Cloud through an HDI container holding the tables `RAG_DOCUMENTS` and `RAG_COLLECTIONS`, deployed and verified on 2026-10-19.

This project **binds the hub to a vector database and proves that the current RAG functionality works on it**:
- user and session collections;
- documents and their upload;
- the `rag_*` tools;
- search in chat;
- session history.

The backend is chosen by configuration:
- `hana-vector` (HDI, shared layout) is the first target;
- `pg-vector` (shared layout) is for local development and tests;
- `qdrant` stays as it is.

Later projects build on this one, each with its own spec:
- shared collections filled at deploy time (MCP tool descriptions, capability docs, skills);
- role collections and the support role;
- the experience collection (agent summary, human confirmation);
- the tool corpus on HANA, as an experiment.

## 2. Goals

1. **Configuration.**
   - `RagBackendKind` gains `hana-vector` and `pg-vector`.
   - The `persistent` class (user and session collections) and the `session` class (history) accept `hana-vector`, `pg-vector` and `qdrant`. This lifts today's "not yet supported" guards.
   - `tools` accepts what it accepts today. `hana-vector` and `pg-vector` for `tools` are refused, with a message that names the later project.
   - HANA connection: from the CF binding of a `hana` service (VCAP_SERVICES `hana[0]`, the runtime `user`/`password`, `host`, `port`, `schema`). The service is named by `LLM_AGENT_HANA_SERVICE`, defaulting to the first `hana` binding.
   - PG connection: `LLM_AGENT_PG_URL` (address only) plus `LLM_AGENT_PG_USER`/`LLM_AGENT_PG_PASSWORD`, set from `.env`. Secrets are never in `mta.yaml`.
   - New parameters follow the existing plumbing: `mta.yaml` parameters default to `""`, there is a `${NAME}` srv property, they appear in all six `.mtaext` templates, and they are added to `mta-config-params.test.ts`.
2. **Deployment.**
   - `mta.yaml` gains an optional HDI resource (`cloud-llm-hub-hdi`, `active: false` by default), switched on by `.mtaext`. A test `.mtaext` binds an existing HDI service (`org.cloudfoundry.existing-service`). `tools/make-staging-mta.js` keeps renaming it for staging.
   - The tables are deployed by `tools/deploy-hdi-tables.sh` (§6), not by an MTA module.
3. **The collection registry persists through `IRagProvider`:**
   - the backend's provider is `HanaVectorRagProvider` / `PgVectorRagProvider` (`layout: 'shared'`) or `QdrantRagProvider`;
   - the registry stays the hub's own, with its in-memory `documents` mirror;
   - the catalog, the stores and the restore go through the provider.
   - **Deterministic store name:** `c_` + the first 40 hex characters of `sha256(collectionId)`, which is identifier-safe and 42 characters long. `collectionId` is today's `<logical>__u_<hash>` / `<logical>__s_<hash>`. The logical id, description, enabled state, source and the **embedder fingerprint** go in the record `attributes`, and so does `collectionId`.
   - **Catalog owner:** `scope: 'user'` + `userId` for a user collection; `scope: 'session'` + `userId` + `sessionId` for a session collection.
   - **Lifecycle** (all async):
     - create: `provider.createCollection`. `DuplicateCollectionError` and `OrphanStoreError` reach the caller, and nothing is deleted in response;
     - delete: `provider.deleteCollection`;
     - rename, description and enabled: `updateCollection` (`IRagCatalogUpdater`).
   - **Mutations are backend-first.** Add, update, delete, `rag_correct` and `rag_deprecate` write the backend, check the `Result`, and only then change memory. A failure is an explicit error, with memory untouched.
   - **Payload:** the point id stays `doc:<collectionId>:<docId>`. Metadata carries `collectionId`, `docId` and `createdAt` (ISO), plus the existing fields.
   - **Restore at startup**, in the registry's `ready` promise:
     1. `describeCollections`;
     2. `openCollection` for each record;
     3. `scan` all pages to rebuild that collection's `documents` (keyed by the payload's `docId`, with `createdAt` from the payload).

     Every registry method that touches a persistent collection awaits `ready` itself, so its callers cannot forget to.
   - **Embedder change:** a record whose fingerprint differs from the current one is restored as `incompatible`. It can be listed, read and exported; search and writes give an explicit error naming both fingerprints.
   - **Orphans:** rows or stores without a record are logged at startup and never deleted automatically.
   - **Session collections:** the same provider with `scope: 'session'`. The hourly expiry sweep and explicit removal call `deleteCollection`, and session collections are restored like user ones.
4. **Persistent session history.** `SessionHistoryRag` over the `session` class store:
   - forget an owner: `deleteWhere({ userId, sessionId })` (`IRagFilteredDeleter`);
   - cap of 200 turns per owner: `scan({ filter: owner })`, sort by `createdAt`, then `deleteById` the oldest above the cap;
   - the in-process `ids` map stops being the source of truth;
   - recall works across restarts.
5. **Explicit errors.** A backend that is unreachable, misconfigured or not deployed (`SHARED_LAYOUT_NOT_DEPLOYED`) gives an explicit error, and `/health` reflects it. There is never a silent fallback to memory.
   - `GET /rag/backends` lists only what is configured and registered.
   - A requested `backend` that is not available is refused (400), instead of today's silent in-memory store.
6. **Verification of current functionality on HANA** in a test subaccount, deployed from its deployment branch. A checklist is run against the deployed app and recorded:
   - create a user collection;
   - add, bulk-add and upload documents;
   - list, query and search them in chat;
   - `rag_add`, `rag_correct` and `rag_deprecate`;
   - rename and disable, delete;
   - a session collection with expiry;
   - history recall;
   - **restart the app (`cf restart`): everything listed above is still there and works.**

## 3. Non-goals

- The tool corpus on HANA or PG.
- Shared or global collections, presets as shared collections (presets keep today's per-user behaviour), roles, the experience collection, pipelines.
- Cross-instance freshness: another instance sees a new collection after its next restart, as Plan B already accepted.
- Migrating today's in-memory collections, which do not survive a restart anyway.
- Reindexing after an embedder change.

## 4. Anti-goals

- Any silent fallback from a configured persistent backend to memory.
- The API reporting a change that a restart would undo.
- Hub-side SQL or REST against the vector database, outside the libraries (principle 1). The hub uses the library interfaces only.
- Breaking a deployment that configures nothing new. In-memory and vector deployments behave exactly as today, and all existing tests pass.

## 5. Constraints

- HANA can be reached only from CF. Unit and integration tests run locally on PG (PGlite) and on the existing in-memory fakes. HANA is verified only by deploying.
- The srv build strips dev dependencies, so `@mcp-abap-adt/hana-vector-rag`, `pg-vector-rag` and `@sap/hana-client` are regular dependencies. `pg` is pulled in through `pg-vector-rag`.
- The `persistent`/`session` split stays as it is: session collections use the `persistent` class backend, and history uses the `session` class backend.
- `normalizeLogicalId` and the collection id formats are unchanged.

## 6. Decided after the builder check (author's call)

- **The owner of a session collection.** The library's catalog owner for `scope: 'session'` carries only `sessionId`. The hub stores `userId` in the record `attributes` (`hubOwner: { userId, sessionId }`) and keeps checking ownership itself, as it does today through `meta.owner`. The library is not changed.
- **No mixed persistence.**
  - When `LLM_AGENT_RAG_BACKEND` is a persistent kind, every new user or session collection uses that backend. A request `backend` naming anything else is refused (400), and `/rag/backends` lists only that one backend.
  - When nothing persistent is configured, `/rag/backends` and the per-collection `backend` behave exactly as today.
- **Presets stay in process memory in this project**, and their enabled flag stays in memory as today. They do not go into the vector database: no per-user copies in HANA, and no stale preset text after a release. The registry keeps an in-process path for `preset: true` collections only. Presets become shared collections in the later "shared collections" project.
- **Restore failures.**
  - If the whole restore fails (for example, the backend is unreachable at boot), `ready` rejects, `/health` reports 503, and a background retry runs with backoff (30 s, then up to 5 min). Each attempt is logged. Persistent operations return an explicit "collections unavailable: <cause>" error until a retry succeeds.
  - If one collection fails to open or scan, that collection alone is restored as `unavailable`, with the error, in the same way as `incompatible`, and the others work.
- **Records the hub did not write.** Every record the hub writes carries `attributes.writtenBy = 'cloud-llm-hub'`. Restore opens only those, and logs anything else in the catalog as foreign without touching it. This makes a container shared with other tools, such as llm-agent's live checks, harmless.
- **History in the shared layout.** The history store gets one catalog record of its own, `storeName: 'h_history'`, `scope: 'global'`, `writtenBy` marker, created if absent at startup and adopted if its rows exist. That way it is never an orphan.
  - History turns gain `userId`, `sessionId` and `createdAt` metadata fields, so that `deleteWhere`, `scan` and the cap work. `metadata.owner` stays for compatibility.
  - Turns written before this change carry no `userId`/`sessionId`. They are reached by neither forget nor the cap. With in-memory history there are none, so nothing has to be migrated.
- **No `db` module in this project.** MTA cannot switch off a module from `.mtaext`, and the tables may already exist in the bound container.
  - The project ships `tools/deploy-hdi-tables.sh` instead. It pushes a throwaway HDI deployer app carrying the `.hdbtable` files of `@mcp-abap-adt/hana-vector-rag`, bound to the named service, waits for "Deployment … done", and deletes the app. This is the proven llm-agent pattern.
  - `DEPLOYMENT.md` documents the script.
  - An MTA-native `db` module is a later concern.
  - The optional HDI resource still goes into `mta.yaml` (`active: false`, switched on and pointed at an existing service by `.mtaext`), so the srv module can bind it.
- **Order.** Hub implementation starts once llm-agent 30.3.0 is published. Until then the hub plan is written, and pure hub-side work that does not need the new interfaces (config, mta, history metadata fields) may start against 30.2.0.

## 7. Left to the builder

- Module split: a small backend-adapter module per provider, keeping `rag-collections.ts` from growing.
- How `ready` is surfaced to routes.
- The verification-run tooling (a script or a manual checklist in the docs).
- Docs: `CONFIG_USAGE.md`, `DEPLOYMENT.md`, the `.mtaext` templates, CHANGELOG.
