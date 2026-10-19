# Persistent RAG Collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User and session collections and session history persist on `hana-vector` (HDI, shared layout), `pg-vector` or `qdrant`, chosen by configuration, through the llm-agent providers. Collections are restored at startup, and the current RAG functionality is verified on HANA in `cloud-llm-hub-dev`.

**Architecture:**
- The hub keeps its own `CollectionRegistry` and its in-memory `documents` mirror.
- A new persistence adapter maps registry operations onto one `IRagProvider` and its catalog: create, open, describe, delete, `updateCollection`. It restores collections with `scan`.
- `SessionHistoryRag` forgets turns with `deleteWhere` and caps them with `scan`.
- Configuration selects the backend. In-memory and `vector` deployments behave exactly as today.

**Tech Stack:**
- SAP CAP (Node 22, TypeScript), jest, biome;
- `@mcp-abap-adt/llm-agent*` **30.3.0** (`IRagScanner`, `IRagFilteredDeleter`, `IRagCatalogUpdater`; `layout: 'shared'` from 30.2.0);
- `@mcp-abap-adt/hana-vector-rag`, `pg-vector-rag`, `qdrant-rag`, `@sap/hana-client`;
- MTA, CF.

**Spec:** `docs/superpowers/specs/2026-10-19-persistent-rag-collections-design.md`. Read §2 and §6 (author's calls).

## Global Constraints

- **No behaviour change unless you opt in.** With `LLM_AGENT_RAG_BACKEND` / `LLM_AGENT_SESSION_RAG_BACKEND` unset, `in-memory` or `vector`, every existing test passes unchanged and every response (including `/rag/backends`) is as today.
- **No silent fallback** from a configured persistent backend to memory. No API response reports a change that a restart would undo.
- **The hub never issues SQL or Qdrant REST for collections or history.** Only the library interfaces. The existing tool-corpus Qdrant code stays as it is.
- **Store name:** `c_` + `sha256(collectionId).hex.slice(0, 40)`.
- **Record `attributes`:** `writtenBy: 'cloud-llm-hub'`, `collectionId`, `logicalId`, `description`, `enabled`, `source`, `embedder` (the fingerprint hash), `hubOwner: { userId, sessionId? }`.
- **Catalog owner:** `user` → `{ scope: 'user', userId }`; `session` → `{ scope: 'session', sessionId }`.
- **History store:** `storeName: 'h_history'`, `scope: 'global'`, `writtenBy` marker.
- **Turn metadata** gains `userId`, `sessionId` and `createdAt` (ISO). `owner` stays.
- **Restore** opens only records whose `writtenBy === 'cloud-llm-hub'` and logs foreign records.
  - A whole-restore failure: `ready` rejects, `/health` returns 503, and a background retry runs every 30 s, doubling up to 5 min.
  - A failure in one collection marks it `unavailable`.
  - A fingerprint mismatch marks it `incompatible`.
- **Persistent kind configured:** the request `backend` must equal it, otherwise 400, and `/rag/backends` lists only it.
- **Presets** (`preset: true`) stay in process memory, and so does their enabled flag.
- **`tools` class:** `hana-vector` / `pg-vector` are refused at config parse with a message naming the later project.
- **New `mta.yaml` parameters** default to `""`. They appear in all six `.mtaext` templates and in both lists of `mta-config-params.test.ts`. Secrets go only in `.env`.
- **HANA is reachable only from CF.** Tests run locally on PGlite, Qdrant and the in-memory fakes. A HANA run means deploying, and it needs the user's go-ahead.
- **Commits** are signed with the YubiKey (never `--no-gpg-sign`). Nothing is pushed from a task. The gate per task: `npm run lint` (check only, no `--write` in CI terms: `npx biome check --config-path . srv tools test`), `npx tsc --noEmit`, and `npm run test:unit`.

## Review Focus

1. **Two users with the same logical collection name.** They get two stores and two records. Neither user sees or deletes the other's, and that still holds after a restore (ownership comes from `hubOwner`). Test: Task 6.
2. **A backend write fails in the middle of a bulk upload.** The documents already written are in memory and in the backend, the failed one is in neither, and the response names it. Test: Task 5.
3. **The app starts while the backend is unreachable, and the backend comes back later.** `/health` is 503 at first. The retry restores everything, after which `/health` is 200 and the collections are listed. Test: Task 7.
4. **A session collection expires while its user is mid-request.** The sweep skips leased sessions (existing rule) and deletes through the provider otherwise. After a restart it is gone. Test: Task 6.
5. **A restore finds a record with another embedder fingerprint, or a record without `writtenBy`.** The first is restored `incompatible`: listed and exportable, but search and add fail explicitly. The second is not opened and is only logged. Test: Task 7.

---

### Task 1: Dependencies and configuration (works on 30.2.0)

**Files:**
- `package.json` (+ lockfile): add `@mcp-abap-adt/hana-vector-rag` and `@mcp-abap-adt/pg-vector-rag` (`^30.2.0` now; Task 4 bumps all `@mcp-abap-adt/*-llm|-rag|llm-agent*` to `^30.3.0`) and `@sap/hana-client` (`^2.30.27`), all as regular dependencies.
- `srv/agent-config.ts`: `RagBackendKind` gains `'hana-vector' | 'pg-vector'`; `BACKENDS` and the per-class rules change; the `session`/`persistent` qdrant guards are lifted; `tools` refuses the new kinds; new config blocks:
  - `HanaRagConfig { serviceName?: string }` from `LLM_AGENT_HANA_SERVICE`;
  - `PgRagConfig { url: string; user?: string; password?: string; schema?: string }` from `LLM_AGENT_PG_URL`, `_USER`, `_PASSWORD`, `_SCHEMA`. The URL is required when a class uses `pg-vector`.
- `mta.yaml`: the parameters `LLM_AGENT_HANA_SERVICE`, `LLM_AGENT_PG_URL` and `LLM_AGENT_PG_SCHEMA` (`""`) with `${NAME}` srv properties. `_USER` and `_PASSWORD` stay in `.env` only.
- The six `docs/deployment/templates/*.mtaext.template`: commented lines for the new parameters.
- Tests: `test/unit/rag-config.test.ts` and `test/unit/mta-config-params.test.ts` (add to `CARRIED`/`NEW`).

- [ ] **Step 1:** Write tests:
  - `persistent=hana-vector` parses;
  - `session=pg-vector` without a URL throws, naming `LLM_AGENT_PG_URL`;
  - `tools=hana-vector` throws `/later project|not supported for tools/`;
  - `session=qdrant` and `persistent=qdrant` now parse (both need the qdrant URL);
  - the obsolete expectations in the existing rejection table are updated: `TOOLS='hana'` still fails as an unknown kind, while `SESSION=qdrant` and `RAG_BACKEND=qdrant` now pass;
  - the mta parameters are present.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement, and run `npm install`.
- [ ] **Step 4:** Run the gate.
- [ ] **Step 5: Commit** `feat(config): hana-vector and pg-vector RAG backends for the persistent and session classes`

### Task 2: Optional HDI resource and table deploy script (works on 30.2.0)

**Files:**
- `mta.yaml`:
  - the resource `cloud-llm-hub-hdi` (`type: com.sap.xs.hdi-container`, `active: false`, `optional: true`, `parameters: { service: hana, service-plan: hdi-shared }`);
  - the srv module `requires: - name: cloud-llm-hub-hdi`, which must not break when the resource is inactive. Check with `mbt build` that an inactive optional resource is dropped from requires. If it is not, use `optional: true` on the requires entry, and say which in the commit.
- `docs/deployment/templates/*.mtaext.template`: a commented example that activates the resource and points it at an existing service:
  ```yaml
  resources:
    - name: cloud-llm-hub-hdi
      active: true
      type: org.cloudfoundry.existing-service
      parameters: { service-name: hdi-llm }
  ```
- `tools/deploy-hdi-tables.sh` with a `tools/hdi-deployer/` template (`package.json` with `@sap/hdi-deploy` and `@sap/hana-client`, and a `manifest.yml` with no route, process health check, `command: npm start; sleep 3600`):
  - copies `node_modules/@mcp-abap-adt/hana-vector-rag/ddl/{RAG_DOCUMENTS,RAG_COLLECTIONS}.hdbtable` and `.hdiconfig` into `src/`;
  - runs `cf push`, bound to `$1` (the service name, default `hdi-llm`);
  - polls `cf logs --recent` for `Deployment to container .* done`, up to 5 min;
  - deletes the app, retrying while an unbind is in progress;
  - exits non-zero on failure.

  Model it on llm-agent's `test/integration/sql-shared-table/hana/deployer`.
- `docs/deployment/DEPLOYMENT.md`: a section "Persistent RAG on HANA" covering service, tables, `.mtaext` and secrets.
- Tests:
  - `test/unit/make-staging-mta.test.ts` checks that the staging generator renames `cloud-llm-hub-hdi`;
  - a unit test parses `mta.yaml` and checks that the resource is inactive by default;
  - shellcheck-clean is not required, but `bash -n tools/deploy-hdi-tables.sh` must pass.
- Commit: `feat(deploy): optional HDI resource and a table deploy script for persistent RAG`

### Task 3: Provider and store factory for the new kinds (works on 30.2.0)

**Files:**
- Create `srv/lib/rag-provider-factory.ts`: `createCollectionProvider(rag: RagConfig, embedding: Embedding, vcap?: unknown): IRagProvider | null`.
  - It returns null when the `persistent` class is not a persistent kind.
  - `hana-vector` → `HanaVectorRagProvider({ name: 'hub-collections', embedder: embedding.retrieval, connection: <from VCAP hana binding: host, port, schema, runtime user/password via staticLogin>, layout: 'shared', autoCreateSchema: unset })`.
  - `pg-vector` → `PgVectorRagProvider` with `layout: 'shared'` and `schema`.
  - `qdrant` → `QdrantRagProvider` with `catalogCollection: '<prefix>-collections-catalog'`.
- Create `srv/lib/hana-binding.ts`: `readHanaBinding(env, serviceName?)`. It parses `VCAP_SERVICES` (`hana[]`, picked by `name`, or the first one), returns `{ host, port, schema, user, password }`, and throws a clear error naming the variable when it is missing.
- Modify `srv/lib/rag-store-factory.ts`: `create()` for `hana-vector` / `pg-vector` returns `HanaVectorRag` / `PgVectorRag` with `layout: 'shared'`, the connection from the same helpers, and `collectionName: name`. This is used by history. The qdrant-only methods keep throwing for other kinds via `needQdrant`.
- Modify `srv/lib/providers.ts`: `startProviders` also builds `collections: IRagProvider | null`.
- Tests:
  - `test/unit/hana-binding.test.ts`: a named binding, the first binding, missing → error;
  - `test/unit/rag-provider-factory.test.ts`: the right class and options for each kind, null for in-memory/vector. Assert the constructor arguments through an injectable constructor map, so no network is touched.
- Commit: `feat(rag): providers and stores for hana-vector and pg-vector`

### Task 4: Bump to llm-agent 30.3.0 (gate: 30.3.0 published)

- Bump every `@mcp-abap-adt/*` package from the llm-agent monorepo to `^30.3.0` and run `npm install`.
- Confirm that `isRagScanner`, `isRagFilteredDeleter` and `isRagCatalogUpdater` resolve, and that the shared-layout providers expose `updateCollection`.
- Run the full gate.
- Commit: `chore(deps): @mcp-abap-adt/llm-agent* 30.3.0`

### Task 5: Persistence adapter and backend-first document mutations

**Files:**
- Create `srv/lib/collection-persistence.ts`. Each function takes the provider and a `StoredCollection` / meta:
  ```ts
  export function storeNameFor(collectionId: string): string; // 'c_' + sha256 hex slice 40
  export function encodeAttributes(meta: CollectionMeta, enabled: boolean, embedderFp: string): Record<string, unknown>;
  export function decodeRecord(rec: RagCollectionRecord): { meta: CollectionMeta; enabled: boolean; embedderFp?: string } | { foreign: true };
  export interface CollectionPersistence {
    create(meta: CollectionMeta, enabled: boolean): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;
    remove(meta: CollectionMeta): Promise<Result<void, RagError>>;
    update(meta: CollectionMeta, enabled: boolean): Promise<Result<void, RagError>>; // updateCollection
    restore(): Promise<Result<RestoredCollection[], RagError>>;                       // Task 7
  }
  export function createCollectionPersistence(provider: IRagProvider & Partial<IRagCatalogUpdater>, embedderFp: string): CollectionPersistence;
  ```
- Modify `srv/rag-collections.ts`:
  - The registry gets an optional `persistence?: CollectionPersistence`.
  - With it, `createCollection` becomes async and goes through `persistence.create`, with the store name from `storeNameFor` (the random `storeNameFor` stays for non-persistent collections). `DuplicateCollectionError` and `OrphanStoreError` reach the caller.
  - `deleteCollection` / `removeCollection` go through `persistence.remove`, and `updateCollection` / `setEnabled` through `persistence.update`.
  - `addDocument`, `addDocumentsBulk`, `updateDocument`, `deleteDocument`, `rag_correct` and `rag_deprecate` are backend-first: the backend `Result` is checked and memory changes only on success. `updateDocument` and `deleteDocument` today ignore the backend result; fix that **only when persistence is on**, so in-memory behaviour and its tests stay identical.
  - Document metadata carries `collectionId`, `docId` and `createdAt` (ISO).
  - Presets (`preset: true`) never go through persistence.
  - The `backend` mismatch check returns 400 (`rag-handler.ts`), and `/rag/backends` lists only the persistent kind when one is set.
  - Keep `rag-collections.ts` from growing: the persistent branches delegate to the adapter.
- Make every registry method that a caller awaits async, and update the callers: `srv/rag-handler.ts`, `srv/rag-tool-dispatcher.ts`, `srv/openai-handler.ts` (resolve and attach), `srv/presets.ts`, `srv/agent-manager.ts`, and the sweep in `srv/server.ts`. Existing tests are updated **only** for the await; their assertions stay.
- Tests: `test/unit/collection-persistence.test.ts` (naming, encode/decode round trip, foreign records) and `test/unit/rag-collections-persistent.test.ts`. The second runs the registry over a real `PgVectorRagProvider` against **PGlite** (`@electric-sql/pglite` + `@electric-sql/pglite-pgvector` + `pglite-socket` as devDependencies, started in-test on a free port, with `sharedLayoutSql` applied). It covers:
  - create, add, query, update, delete, rename, disable;
  - a failing backend write leaves memory untouched (Review Focus 2);
  - two users with the same logical id (Review Focus 1);
  - a request `backend` mismatch returns 400;
  - presets are not persisted.
- Commit: `feat(rag): persistent user and session collections through the provider catalog`

### Task 6: Session collections, sweep and ownership

**Files:** `srv/rag-collections.ts` (session paths through persistence), `srv/lib/session-state.ts`, `srv/server.ts` (sweep). Tests in the same PGlite suite.

- Session collections are created with `scope: 'session'` and `hubOwner`.
- Expiry, `deleteSessionCollections` and the destination-switch removal all go through `persistence.remove`, and `maySweepSession` leasing is unchanged.
- Tests:
  - after a simulated restart (a new registry over the same PGlite), a user's own session collection is restored and another user's is not visible to them;
  - an expired, unleased session collection is deleted in the backend;
  - a leased one is kept (Review Focus 4).
- Commit: `feat(rag): session collections persist and expire through the provider`

### Task 7: Restore at startup, retry, health

**Files:**
- `srv/lib/collection-persistence.ts`: `restore()` runs `describeCollections`, then `openCollection` for each own record, then `scan` all pages to rebuild `documents`. `docId` and `createdAt` come from the payload.
- `srv/rag-collections.ts`: the `ready` promise. Every persistent-touching method awaits it, and `incompatible` and `unavailable` statuses carry an error.
- `srv/agent-manager.ts`: start the restore after `initProviders`, with the retry loop (30 s, doubling to 5 min).
- `srv/server.ts` (`/health`): 503 while the restore has not succeeded. Each attempt is logged.
- `GET /rag/collections` shows the status. Search and add on `incompatible` or `unavailable` collections give an explicit 409/503 naming the cause.
- Tests (PGlite suite):
  - create, then restart, then list, get, export and query all equal;
  - an unreachable backend at boot gives 503, the retry succeeds and the result is 200 (Review Focus 3; stop and restart the PGlite socket);
  - a fingerprint mismatch gives `incompatible`;
  - a foreign record is not opened (Review Focus 5);
  - one collection whose open fails is `unavailable` while the others work.
- Commit: `feat(rag): restore persistent collections at startup, with retry and health`

### Task 8: Persistent session history

**Files:** `srv/lib/session-history-rag.ts`, `srv/agent-manager.ts` (`getSharedHistoryRag`: for a persistent kind, ensure the `h_history` record with `adoptExisting` and open it through the provider), `srv/openai-handler.ts` (turn metadata). Tests: `test/unit/session-history-rag.test.ts` plus the PGlite suite.

- Turn metadata gains `userId`, `sessionId` and `createdAt`.
- `forgetOwner` → `deleteWhere({ userId, sessionId })` when the store `isRagFilteredDeleter`, else today's path.
- The cap: after each add, when the store `isRagScanner`, scan the owner, sort by `createdAt` and `deleteById` above 200.
- With a scanner, the in-process `ids` map is only a cache.
- Tests:
  - recall works across a restart (a new `SessionHistoryRag` over the same PGlite);
  - forget removes only that owner;
  - the cap keeps the newest 200;
  - the in-memory path is unchanged.
- Commit: `feat(history): persistent session history with filtered delete and cap`

### Task 9: Docs and changelog

- `docs/llm-agent/CONFIG_USAGE.md`: the new kinds and variables; the "Plan B / not yet supported" text is removed.
- `docs/deployment/DEPLOYMENT.md`: extend the Task 2 section.
- `docs/architecture/EXTENSION_GUIDE.md`: replace the stale HANA section with a pointer to the real design.
- `docs/rfcs/BACKLOG.md`: remove the done items.
- `CHANGELOG.md`: an Unreleased entry.
- Run `node tools/check-docs.js`.
- Commit: `docs: persistent RAG collections on HANA, Postgres and Qdrant`

### Task 10: Deploy and verify on HANA (controller only, user go-ahead required)

- [ ] **Step 1:** In the fork, merge `feat/persistent-rag-collections` into `deploy/poc-hana-rag`. Its `.mtaext` sets `LLM_AGENT_RAG_BACKEND=hana-vector` and `LLM_AGENT_SESSION_RAG_BACKEND=hana-vector`, keeps the embedder as configured, and activates `cloud-llm-hub-hdi` as the existing service `hdi-llm`.
- [ ] **Step 2:** The tables already exist. Re-run `tools/deploy-hdi-tables.sh hdi-llm` only if the DDL changed.
- [ ] **Step 3:** Run `tools/deploy.sh` (cf deploy) to `cloud-llm-hub-dev`/`llm-agent`.
- [ ] **Step 4:** Work through the spec §2.6 checklist against the deployed app, then `cf restart cloud-llm-hub-srv`, then go through the checklist again. Record every step's result in `docs/superpowers/verification/2026-10-19-persistent-rag-hana.md`.
- [ ] **Step 5:** Report the result. The PR to cloud-llm-hub is a separate step after the user's review.
