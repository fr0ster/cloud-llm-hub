# Embedder Re-embed Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deploy that changes the embedder re-embeds every persisted, embedded record before the new application starts; a failed migration fails the deploy.

**Architecture:** A migration module (`srv/lib/embedder-migration.ts`) scans every embedded store, re-embeds stale records page by page with the library's `embedDocumentRecords`, writes them with `upsertManyPrecomputedRaw` and stamps the catalog record last. A CLI entry (`srv/migrate-embeddings.ts`) bootstraps the providers, runs the existing start-time chain `migrateHubRagProviders` and then the migration. `mta.yaml` runs the CLI as a `deploy.application.before-start` task hook. Every normal write stamps the record with the embedder hash, so a rerun skips finished records.

**Tech Stack:** TypeScript (CAP Node.js), `@mcp-abap-adt/llm-agent` RAG interfaces (`IRagScanner`, `IRagBackendWriter`, `IRagCatalogUpdater`, `embedDocumentRecords`), jest, MTA module hooks.

**Spec:** `docs/superpowers/specs/2026-11-26-embedder-reembed-migration-design.md`

## Global Constraints

- No `any`, `unknown`, `as unknown as`, `as never`, `: unknown` in callbacks — in code and tests.
- No timeouts, caps, budgets or truncation in the migration path; only the CF task execution time limits it.
- Any embedding or store error stops the run with a non-zero exit; no record is skipped.
- Record stamp key: `embedder`, value `fingerprintHash(<current fingerprint>)` (12 characters, `srv/lib/tool-corpus.ts:40`).
- Stores with zero vectors (`task-results` collections, `h_sessions`, `h_runs`, `h_trust`, `h_dialogue`) are never re-embedded.
- A stored hash inside `compatibleFingerprintHashes(...)` is re-stamped only, never re-embedded.
- Tokens are reported per model (input separately), never summed across models.
- Committed docs name only the SAP system type.
- Jest one file at a time: `npx jest <file>`.
- Codex implements; Claude runs the tests and commits (signed). After every commit check `git status` (biome hook).

## Review Focus

- A collection whose catalog stamp is already current but whose records are partly stale (crash after a page, before the catalog stamp): the rerun must finish it, so the catalog stamp check alone must not skip it.
- A record whose new split yields fewer fragments than before: surplus old fragments must not survive with old vectors.
- Client-supplied metadata containing `embedder`: it must be stripped on input and never shown back.
- An empty store and an empty catalog: the run succeeds and reports zero.
- A scanner that returns the same cursor twice: the run fails instead of looping (pattern in `hub-store-restamp.ts`).

---

### Task 1: Record stamp on registry documents

**Files:**
- Modify: `srv/lib/collection-persistence.ts` (`PAYLOAD_BOOKKEEPING` ~397, `payload()` ~500, persistence options ~755)
- Test: `test/unit/collection-persistence-embedder-stamp.test.ts`

**Interfaces:**
- Produces: `PAYLOAD_BOOKKEEPING` includes `'embedder'`; every document payload written through `payload()` carries `embedder: <current hash>`; the persistence factory takes the current hash it already has (`embedderFp`).

- [ ] **Step 1: Write the failing tests**
  - `stamps the current embedder hash on every written document`: add a document through the persistent registry with a fake writer → the written metadata has `embedder === fingerprintHash(fp)`.
  - `client metadata cannot set embedder`: add a document with `metadata: { embedder: 'forged', a: 1 }` → written `embedder` is the current hash; `restoredDocument(...)` of the written record returns `metadata` `{ a: 1 }` (no `embedder`).
- [ ] **Step 2: Run** `npx jest test/unit/collection-persistence-embedder-stamp.test.ts` → FAIL.
- [ ] **Step 3: Implement** — add `'embedder'` to `PAYLOAD_BOOKKEEPING`; `payload()` adds `embedder: embedderFp` after `ownMetadata(...)` so a client value is overwritten.
- [ ] **Step 4: Run** the new test and `npx jest test/unit/collection-persistence.test.ts` (and any file grepping `PAYLOAD_BOOKKEEPING`) one by one → PASS.
- [ ] **Step 5: Commit** `feat(rag): stamp documents with the embedder hash`.

### Task 2: Hub store stamp and start check

**Files:**
- Modify: `srv/lib/collection-persistence.ts` (`hubRecordOptions` ~1205, `PersistentHistoryStore` ~1406), `srv/lib/session-history-collection.ts` (writes ~519, ~613, ~1210), `srv/lib/hub-store-restamp.ts` (planner `upsertRaw` ~112), `srv/server.ts` (after `migrateHubRagProviders`, ~1118)
- Create: `srv/lib/hub-store-embedder.ts`
- Test: `test/unit/hub-store-embedder.test.ts`

**Interfaces:**
- Produces:
  - `EMBEDDED_HUB_STORES = ['h_history', 'h_planner_memory'] as const` (exported from `hub-store-embedder.ts`).
  - `assertHubStoresEmbedder(provider: IRagProvider, current: string): Promise<Result<void, RagError>>` — reads the catalog; for each embedded hub store record, `attributes.embedder !== current` (missing included) → `RagError` with code `EMBEDDER_MIGRATION_REQUIRED` and message `hub store "<storeName>" was embedded with "<stored|none>", the current embedder is "<current>"; run npm run migrate:embeddings`.
  - Hub store records of the embedded stores get `attributes.embedder = current` on create; their record writes carry metadata `embedder = current`.

- [ ] **Step 1: Write the failing tests**
  - `passes when both embedded hub stores carry the current hash`.
  - `fails with EMBEDDER_MIGRATION_REQUIRED when the stamp is missing` (message contains the store name, `none` and `npm run migrate:embeddings`).
  - `fails when the stamp differs`.
  - `ignores zero-vector hub stores` (`h_sessions` without stamp → ok).
  - `history writes stamp embedder on record metadata` (fake writer, one history append).
- [ ] **Step 2: Run** `npx jest test/unit/hub-store-embedder.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module and stamps. `server.ts`: after `migration.ok`, call `assertHubStoresEmbedder` for `p.collections` and for `historyProvider(sessionKind)` when persistent; `throw` its error (the existing catch exits 1).
- [ ] **Step 4: Run** the new test, then `test/unit/session-history-collection*.test.ts`, `test/unit/hub-store-restamp*.test.ts`, `test/unit/planner-memory*.test.ts` one by one → PASS.
- [ ] **Step 5: Commit** `feat(rag): stamp embedded hub stores and refuse a stale embedder at start`.

### Task 3: Migration module

**Files:**
- Create: `srv/lib/embedder-migration.ts`
- Test: `test/unit/embedder-migration.test.ts`

**Interfaces:**
- Consumes: Task 1 stamp key, Task 2 `EMBEDDED_HUB_STORES`, `fingerprintHash`, `compatibleFingerprintHashes`, `embedDocumentRecords`, `isRagScanner`, `isRagCatalogUpdater`.
- Produces:
  ```ts
  export interface EmbedderMigrationOptions {
    current: string;                       // fingerprintHash of the configured embedder
    compatible: ReadonlySet<string>;       // compatibleFingerprintHashes(...)
    embedder: IDocumentEmbedder;           // per store: see storeEmbedder
    storeEmbedder?: (storeName: string) => IDocumentEmbedder; // h_history → toolSearch path
    dimension: number;                     // the store column / collection size
    log: (line: string) => void;
  }
  export interface StoreMigration { storeName: string; action: 'reembedded' | 'restamped' | 'current'; records: number; fragments: number; ms: number; }
  export interface EmbedderMigrationReport { stores: StoreMigration[]; promptTokens: number; tokensReported: boolean; }
  export function migrateEmbeddings(provider: IRagProvider, opts: EmbedderMigrationOptions): Promise<Result<EmbedderMigrationReport, RagError>>;
  ```
- Algorithm per catalog record (registry collections: `attributes.embedder` present; hub stores: name in `EMBEDDED_HUB_STORES`; skip `task-results` and zero-vector hub stores). `S` = the catalog's stored hash (`'none'` when missing); `ok = {current} ∪ compatible`.
  1. A record's embedder is `metadata.embedder ?? S` (a record without a stamp was written by the catalog's embedder, since the catalog is stamped only after its last record). The record is stale when that hash is not in `ok`.
  2. Scan all pages; embed only stale records with `embedDocumentRecords(embedder, texts)`; write `upsertManyPrecomputedRaw` with `vector: <fragments>` and metadata `{ ...row.metadata, embedder: current }`. Records that are not stale are left untouched (no rewrite, no tokens).
  3. After the last page, `updateCollection` with `embedder = current` when `S !== current`. Action: `reembedded` when any record was embedded, `restamped` when only the catalog changed, `current` otherwise.
  4. The catalog stamp is never a reason to skip scanning (Review Focus 1).
- Before the first store: `embedder.embed('dimension probe')` length `!== opts.dimension` → `RagError('embedder dimension <n> does not match the store dimension <m>', 'EMBEDDER_DIMENSION_MISMATCH')`.

- [ ] **Step 1: Write the failing tests** (fake provider with catalog, scanner pages, writer, updater; fake embedder returning fixed-length vectors with `usage`)
  - `re-embeds stale records and stamps the catalog last` (writer call order: all records, then `updateCollection` with `embedder: current`).
  - `skips records that already carry the current stamp` (rerun after a crash: catalog old, page 1 stamped current, page 2 unstamped → only page 2 embedded, then the catalog is stamped).
  - `a compatible collection is only re-stamped` (catalog hash in `compatible`, records unstamped → no embed call, `updateCollection` once, action `restamped`).
  - `an explicit stale record stamp is re-embedded even when the catalog is current`.
  - `skips task-results and zero-vector hub stores`.
  - `migrates h_history through storeEmbedder`.
  - `fails on dimension mismatch before any write`.
  - `stops on the first embedding error with the store and record id in the message` and no catalog stamp.
  - `fails when the scanner repeats a cursor`.
  - `empty catalog reports zero stores`.
  - `sums promptTokens of the embed results; tokensReported false when no result has usage`.
  - `surplus fragments do not survive`: a record with 3 old fragments re-embedded into 1 → the fake store holds 1 fragment (if `upsertManyPrecomputedRaw` does not replace all fragments in the real backends, stop and raise a library change in llm-agent first).
- [ ] **Step 2: Run** `npx jest test/unit/embedder-migration.test.ts` → FAIL.
- [ ] **Step 3: Implement** `migrateEmbeddings`.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(rag): re-embed migration for stale embedder stamps`.

### Task 4: CLI, deploy hook, docs

**Files:**
- Create: `srv/migrate-embeddings.ts`
- Modify: `package.json` (script `"migrate:embeddings": "tsx srv/migrate-embeddings.ts"`), `mta.yaml` (hook on `cloud-llm-hub-srv`), `docs/` deploy/operations page that describes `LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS`, `CHANGELOG.md` (Unreleased: Added)
- Test: `test/unit/migrate-embeddings-cli.test.ts`, `test/unit/mta-hooks.test.ts`

**Interfaces:**
- Consumes: `startProviders(getAgentConfig())` (`srv/lib/providers.ts:303`), `initProviders`, `historyProvider` (`srv/agent-manager.ts`), `migrateHubRagProviders` (built exactly as in `srv/server.ts:1099-1121` — extract that block into `export async function runStartMigrations(p: Providers, log: Log): Promise<Result<void, RagError>>` in `srv/lib/rag-migration.ts` and call it from both), Task 3 `migrateEmbeddings`.
- Produces: `export async function main(env: NodeJS.ProcessEnv): Promise<number>` (exit code); the file runs `main(process.env).then(process.exit)` when executed directly.
- Behaviour: when not on CF (`VCAP_APPLICATION` unset), GET the local hub health URL of the same config; an answer → print `stop the hub before migrating` and return 1. Summary line per store and `tokens <embeddingModel>: input <n>` (or `not reported`).
- `mta.yaml`:
  ```yaml
  hooks:
    - name: migrate-embeddings
      type: task
      phases: [deploy.application.before-start]
      parameters:
        name: migrate-embeddings
        command: node srv/migrate-embeddings.js
        memory: 2048M
  ```
  The command path is relative to `gen/srv`; verify with `npx cds b` that `gen/srv/srv/migrate-embeddings.js` exists, adjust the path if the build lays it out differently.

- [ ] **Step 1: Write the failing tests**
  - `returns 0 and logs a summary when migrations succeed` (mock providers + `migrateEmbeddings`).
  - `returns 1 when a start migration fails` / `when migrateEmbeddings fails`.
  - `refuses locally when the hub answers health`.
  - `mta.yaml has the before-start migrate-embeddings hook on cloud-llm-hub-srv` (parse YAML, assert phase, type and command).
- [ ] **Step 2: Run** each file → FAIL.
- [ ] **Step 3: Implement** CLI, `runStartMigrations` extraction, script, hook, docs, CHANGELOG.
- [ ] **Step 4: Run** the new tests and `test/unit/rag-migration*.test.ts`, `test/unit/server*.test.ts` one by one; `npm run test:check`; `npm run lint:check`; `npx cds b` and check the built file → PASS.
- [ ] **Step 5: Commit** `feat(deploy): run the re-embed migration as a before-start task`.

### Task 5: Verification (owner approvals required)

- [ ] Local start check only: `npm run migrate:embeddings` against the local PG/Qdrant config with the hub stopped → exit 0; hub then starts.
- [ ] Push and PR (needs "так, пуш і PR …"), Codex review, CI, merge (needs "так, мерж #N").
- [ ] PoC deploy (needs "так, деплой на PoC"): in the deploy log, the application stop precedes the `migrate-embeddings` task; the task summary lists every embedded store; the start log shows all collections accepted without the compatibility path. If the old instance still runs during the task, add an explicit stop step (spec: Old application during the hook).
- [ ] Remove `LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS` from the PoC `.mtaext` in the release after next (spec: one release of support).
