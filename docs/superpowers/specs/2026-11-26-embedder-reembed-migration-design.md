# Embedder re-embed migration at deploy

Status: design, 2026-11-26.

## Intent

When a deploy changes the embedder (provider, model, base URL or AI Core resource
group), persisted collections written with the old embedder must keep working.
Today the hub restores them as `incompatible`: listing and reading work, search
and writes are refused (409 `COLLECTION_INCOMPATIBLE`). Before v12.0.1, the
agent collections crashed the start. v12.0.1 added
`LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS` as a stop-gap for an AI Core
resource-group change with the same model. This design is the real fix: the
deploy re-embeds every stored record with the new embedder before the new
application starts.

The owner chose a separate deploy step over a background migration inside the
running application, so that the hub never serves a collection that is half
migrated.

## Goals

- A deploy with a changed embedder ends with every persisted, embedded
  collection stamped with the new embedder fingerprint and re-embedded with it.
- The application starts only after the migration succeeded. A failed migration
  fails the deploy.
- The migration is safe to run again: a rerun after a crash continues and does
  not corrupt data.
- The same migration runs locally (PG/Qdrant) as a command.

## Non-goals

- A change of vector dimension. HANA and PG keep one shared `RAG_DOCUMENTS`
  table with a fixed 1536 column; a different dimension needs a DDL change. The
  migration detects it and fails with a message that names both dimensions.
  Qdrant could re-create collections, but one rule for all backends is kept.
- Blue-green deploys.
- The tool corpus and skills side store. The tool corpus is regenerated at build
  time by `tools/generate-tool-embeddings.ts`; skills are indexed per process.
- In-memory and `vector` backends, which persist nothing.

## Anti-goals

- The hub serving search over a mix of old and new vectors.
- Silent degradation: an embedded store that has no fingerprint and is searched
  with another embedder.
- A migration that "succeeds" while some records were skipped.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| A | Background migration inside the application at start, collection status `migrating` | Hub is up at once; search on that collection is refused or partial until done; every instance may run it |
| B | Shadow collection with catalog swap | Old collection searchable during the copy; double storage; complex catalog swap; dimension change still blocked in HANA/PG |
| **C (chosen)** | **Separate deploy step: an MTA module hook task before the application starts** | No half-migrated state is ever served; a single process, so no lock; deploy takes longer by the re-embed time |

Chosen by the owner: C.

## Design

### Where it runs

- **CF:** `mta.yaml`, module `cloud-llm-hub-srv` gets a hook:

  ```yaml
  hooks:
    - name: migrate-embeddings
      type: task
      phases: [deploy.application.before-start]
      parameters:
        name: migrate-embeddings
        command: npm run migrate:embeddings
        memory: <same as the module>
  ```

  The task runs on the new droplet with the same bindings and environment as the
  application. HANA is reachable from CF only, so this is the only place it can
  run for HANA. A non-zero exit fails `cf deploy`; the new application is not
  started.
- **Local:** `npm run migrate:embeddings` with the local config. The hub start
  does not migrate; if it finds a collection with another fingerprint it keeps
  today's `incompatible` behaviour (safety net, unchanged).

### Order inside the task

The task first runs the existing start-time chain `migrateHubRagProviders`
(`srv/lib/rag-migration.ts`: backend access, Qdrant multivectors, fragment
ordinal, `restampHubStores`, shared history), exactly as the application start
does. Only then does the re-embed run, so it always scans and writes the
current layout. The chain stays idempotent, so the application start running it
again finds nothing to do. Records that `restampHubStores` rewrites with
`upsertRaw` are embedded with the current embedder and get the record stamp, so
the re-embed skips them.

### Old application during the hook

Decision: the hook relies on the standard (non-blue-green) MTA deploy stopping
the running application before the new droplet starts, and on this module being
the only writer of its HDI container or Qdrant prefix (each customer deploy has
its own). The first PoC deploy checks the deploy log for the application stop
before the hook task; if the old instance is still running, the plan adds an
explicit stop of the module before the hook.

### What it migrates

1. **Registry collections** in the catalog (`RAG_COLLECTIONS` / Qdrant catalog)
   whose `embedder` attribute differs from the current fingerprint. Collections
   that are exempt from the fingerprint check today (`task-results`, zero
   vectors) are skipped.
2. **Embedded hub stores** `h_history` and `h_planner_memory`. They have no
   fingerprint today. This change adds an `embedder` attribute to their global
   record, written on create. Hub stores with zero vectors (`h_sessions`,
   `h_runs`, `h_trust`, `h_dialogue`) are not touched.
   - Existing deployments have unstamped stores. The embedder that wrote them
     is unknown, so the first migration treats them as old and re-embeds them
     fully.
   - Start check (decision): these stores serve every session, so a mismatched
     or missing stamp does not make them `incompatible`. The start fails with an
     error that names the store and the `npm run migrate:embeddings` command,
     following the one failure policy (error, not silent degradation). On CF
     this cannot happen after a successful deploy; locally it tells the
     operator to run the command.
   - Each store is re-embedded through the same embedder path as its own writer
     (`h_history` through `sessionHistoryWrite`/`toolSearchEmbedder` in
     `srv/lib/providers.ts`), so breaker and retry behaviour match normal
     writes.

A stored fingerprint that is in the compatible set
(`LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS`) is only re-stamped, not
re-embedded: the vectors came from the same model. After this migration the
setting is no longer needed; it stays supported for one release and is then
removed.

### How one collection is migrated

1. Read a page with `IRagScanner.scan` (fragment 0: id, full text, metadata).
2. Skip records whose metadata already carries `embedder = <current>`.
3. Embed the page with the library's `embedDocumentRecords` (splits long text
   into fragments by the embedder input limit, batches by `maxBatchSize`,
   retries 429 as the library does).
4. Write with `upsertManyPrecomputedRaw`, all fragments of a record replaced,
   metadata extended with `embedder = <current>`.
5. After the last page, re-stamp the catalog record with
   `IRagCatalogUpdater.updateCollection` (`embedder = <current>`).

Record stamp (decision): the key `embedder` holds `fingerprintHash` (the
12-character hash already used in the catalog). It joins the hub-owned metadata
keys (`collectionId`, `docId`, `createdAt`, owner stamps): every normal write
sets it, client-supplied metadata cannot set it, and `restoredDocument` strips
it from what clients see.

The per-record stamp makes a rerun continue where the crash stopped, and the
catalog stamp is written last, so a collection is never marked migrated while
records still carry old vectors. The pattern follows `hub-store-restamp.ts`.

### Failure policy

One system-wide rule: any component failure is an error. Any embedding or store
error stops the migration with a non-zero exit and a log line that names the
collection, the record id and the error code (for example
`EMBEDDING_CONTEXT_EXCEEDED`). No record is skipped. No timeouts or caps are
added; the only limit is the CF task execution time set for the module.

Before touching any record, the task embeds one probe text and compares the
dimension with the store's. A mismatch fails at once (non-goal above).

### Output

- One log line per collection: id, records, fragments, time.
- A summary with tokens per model (input and output separately, never summed
  across models), collected in the task process from the embed results'
  usage. An embedder that reports no usage is shown as "not reported". The task
  writes no rows to the usage ledger (it has no session or user).

### Concurrency

The hook runs one CF task before the application starts, so there are no
concurrent writers and no lock is needed. Locally the operator runs the command
with the hub stopped; the command refuses to run when the hub health endpoint
of the same config answers.

## Left to the builder

- Module layout of the migration code (shared with the restore code where the
  fingerprint is computed: `srv/lib/tool-corpus.ts`, `srv/lib/providers.ts`).
- Page size (the scanner default of 500 is fine).
- How `upsertManyPrecomputedRaw` removes surplus fragments when the new split
  yields fewer fragments; if the library does not, a library change goes to
  llm-agent first.
- Tests: unit tests per backend with fake stores, a rerun-after-crash test, a
  dimension-mismatch test, a compatible-set re-stamp test; a local run on
  PG/Qdrant; the CF run on the PoC subaccount.
