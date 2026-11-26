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

1. **Registry collections** recognized by the catalog decoder used for restore
   (`RAG_COLLECTIONS` / Qdrant catalog), including collections without an
   `embedder` attribute. Zero-vector `task-results` collections are skipped.
2. **Cataloged embedded hub stores** include the global `h_history` and
   `h_planner_memory` stores and every catalog entry with
   `source: 'session-history'`, including `h_hist_*` collections. New stores
   carry the current `embedder` catalog attribute. Existing deployments may
   have unstamped stores. The first migration re-embeds their unstamped
   records. Startup requires the current catalog stamp and fails with
   `EMBEDDER_MIGRATION_REQUIRED` naming the store and the
   `npm run migrate:embeddings` command when the stamp is missing or differs.
   History stores use the `toolSearchEmbedder` path used by normal history
   writes. Zero-vector hub stores (`h_sessions`, `h_runs`, `h_trust`,
   `h_dialogue`) are skipped.
3. **Standalone Qdrant planner memory** uses `<prefix>-planner-memory` when
   the session backend is Qdrant. It has no catalog entry. The CLI checks the
   physical vector dimension and re-embeds records with missing or unaccepted
   `metadata.embedder` stamps. Normal writes stamp the records with the current
   hash. Startup checks every page for missing or unaccepted stamps. A missing
   or empty store passes.

For cataloged stores, the migration preserves vectors with compatible hashes
from `LLM_AGENT_EMBEDDING_COMPATIBLE_RESOURCE_GROUPS`. When checking records,
the migration accepts the current hash and the configured compatible hashes.
It also accepts the catalog's `embedderAliases` when the catalog's primary
`embedder` hash matches the current hash. When stamping a new current hash, it
rebuilds the alias list from the previous catalog hash and the record stamps
encountered during the scan, keeping only legacy hashes explicitly configured
as compatible with the new hash. If none qualify, it removes the alias attribute.
When the current hash is unchanged, existing aliases are retained and newly
observed compatible hashes are added. Restore and startup use the catalog's
primary `embedder` attribute.

### How one collection is migrated

1. Read a page with `IRagScanner.scan` (fragment 0: id, full text, metadata).
2. Skip records whose embedder hash is accepted. For a cataloged store, a
   missing record stamp falls back to the catalog's `embedder` attribute. If
   both stamps are missing, the record is re-embedded.
3. Embed the page with the library's `embedDocumentRecords` (splits long text
   into fragments by the embedder input limit, batches by `maxBatchSize`,
   retries 429 as the library does).
4. Write with `upsertManyPrecomputedRaw`, all fragments of a record replaced,
   metadata extended with `embedder = <current>`.
5. After the last page of a cataloged store, update the catalog when its
   fingerprint or aliases change.

Record stamp (decision): the key `embedder` holds `fingerprintHash` (the
12-character hash already used in the catalog). It joins the hub-owned metadata
keys (`collectionId`, `docId`, `createdAt`, owner stamps): every normal write
sets it, client-supplied metadata cannot set it, and `restoredDocument` strips
it from what clients see.

The per-record stamp makes a rerun continue where the crash stopped, and the
catalog stamp is written last, so a collection is never marked migrated while
records still carry old vectors. The pattern follows `hub-store-restamp.ts`.

### Failure policy

An embedding or store error stops the migration with a non-zero exit and a
log line naming the store, the error code, and the record ID when available.
If a page batch fails, migration tries each record individually to identify
the failing record. If every individual attempt succeeds, it reports the
original batch error. The failed page is never written. The CF task execution
time sets the migration's time limit.

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
