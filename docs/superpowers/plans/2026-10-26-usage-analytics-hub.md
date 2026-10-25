# Usage Analytics in the Hub — Implementation Plan

<!-- docs-check:proposed-env: this plan introduces LLM_AGENT_USAGE_* settings, which do not exist yet -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the hub's real per-session resource use, and export it for analysis.
- **Library records:** the llm-agent records for LLM, embedding, MCP and task usage, with the hub's context attached.
- **Hub records:** session, request, storage and process records.
- **Export:** for `MCP_Admin`.

**Architecture.**
- **Runtime.** One process-wide usage runtime (`srv/lib/usage/runtime.ts`) owns the recorder, the sink choice and the fallback, retention, the status and the shutdown.
- **Recorders.** A session-bound recorder lives on each dialogue and long session; request recorders are narrowed from it per request. They reach llm-agent through call options and `DialogueSessionOptions.usage`.
- **Construction-bound recorders.** Hub-built providers get the runtime recorder.
- **Hub measurements.** `x.hub.*` records, emitted by their lifecycle owners.
- **Admin routes.** Export and status are registered before the `/v1` tool-role middleware.

**Tech Stack:** TypeScript (CAP / Express), Jest (`--maxWorkers=1`), Biome, the llm-agent usage packages (`llm-usage`, and the `llm-usage-pg`, `llm-usage-hana` and `llm-usage-sqlite` sinks), 1.0.x, `@mcp-abap-adt/llm-agent(-libs)` 30.11.0.

**Spec:** `docs/superpowers/specs/2026-10-25-usage-analytics-design.md` (hub). Its library counterpart is in llm-agent, `docs/superpowers/specs/2026-10-25-usage-analytics-design.md`. Read both; this plan does not restate their rules.

## Global Constraints

- **Off by default:** `LLM_AGENT_USAGE=off`. Off means behaviour identical to today, and no recorder anywhere: llm-agent's no-op default applies.
- **No content in any record:** no message, document, SAP data, tool argument or result, credential or token. `userId` is hashed by default.
- **Exactly the spec's settings:** the names and defaults of the `LLM_AGENT_USAGE_*` table. Documented in `docs/llm-agent/CONFIG_USAGE.md`. Not exposed in `mta.yaml` unless the spec says so.
- **Admin routes:** `MCP_Admin` only (`requireAdminRole`, from #82). Registered before `requireMcpRole` and before session resolution.
- **Change records:** a CHANGELOG `## [Unreleased]` entry (LF line endings). Biome style.

## Review Focus

1. **Recording on and context.** With recording on, a dialogue task started by one request keeps its `sessionId` after that request has ended. Owned by Task 2.
2. **Concurrent sessions.** Two concurrent sessions never swap context, because shared providers get context only through call options. Owned by Task 2.
3. **Session close order.** The final storage snapshot is taken before cleanup deletes the state. Owned by Tasks 3 and 4.
4. **Export.** Export includes overlapping `x.usage.lost` records outside the window and despite a `kinds` filter. Owned by Task 6.
5. **Fallback.** A missing HANA table does not lose memory-held records, and the switch-over copies them. Owned by Task 1.

---

### Task 0: `stats().unconfirmed` in `llm-usage` (llm-agent, minor)

The hub's status must report unconfirmed records. The published recorder's `stats()` does not return that count.

- **Change** (llm-agent repo, branch from main): add `unconfirmed: number` to `IUsageControl.stats()` in `@mcp-abap-adt/llm-agent`, as an additive optional field in the contract, and implement it in `@mcp-abap-adt/llm-usage`'s recorder. It counts records whose delivery is currently ambiguous.
- **Test:** an ambiguous send increments it; a later successful resend decrements it.
- **Release:** a changeset (minor for `llm-usage`, minor for `llm-agent`), then the version PR → tags → the user publishes. The hub's Task 1 depends on this release.

### Task 1: Dependencies, usage runtime, sinks and fallback

**Files:**
- Modify: `package.json`. Bump `@mcp-abap-adt/llm-agent` and `-libs` to `^30.11.0`, `-mcp` and providers to `^30.10.0`; add the llm-agent packages `llm-usage` (at the version from Task 0), `llm-usage-pg`, `llm-usage-hana` and `llm-usage-sqlite`. Run `npm install`, which the human does if the sandbox is offline.
- Create: `srv/lib/usage/runtime.ts`, `srv/lib/usage/config.ts`.
- Test: `test/unit/usage-runtime.test.ts`, `test/unit/usage-config.test.ts`.

**Interfaces (Produces):**
- **`readUsageConfig(env): UsageConfig`**, implementing the spec's settings table.
  - It validates with the existing strict readers (`readPositiveIntFrom`).
  - An explicit sink whose backend is not configured throws a configuration error at startup.
- **Lifecycle:** `initUsage(cfg, deps): Promise<UsageRuntime | undefined>`, which returns `undefined` when off; `usageRuntime(): UsageRuntime | undefined`; `setUsageRuntimeForTest(r)`.
- **`UsageRuntime`:**
  - `recorder: IUsageRecorder`, the process-wide recorder;
  - `forSession(s: { sessionId; userId; destination? }): IUsageRecorder`, which does the `userId` hashing;
  - `status(): UsageStatus`;
  - `reader(): IUsageReader`;
  - `close(timeoutMs): Promise<…>`.
- **Sink choice:** follows `LLM_AGENT_SESSION_STORE`: `hana-vector` → hana, `pg-vector` → pg, `sqlite` or `none` → sqlite at `LLM_AGENT_USAGE_SQLITE_PATH`. `LLM_AGENT_USAGE_SINKS` overrides it.
- **SQLite capability failure:** log it, report it in status, fall back to `memory`.
- **HANA table missing** (`autoCreateSchema` off):
  - a hub-owned `MigratableBuffer` (`srv/lib/usage/migratable-buffer.ts`) implementing `IUsageSink` and `IUsageReader`, bounded by `LLM_AGENT_USAGE_MEMORY_LIMIT`. It never evicts: when full, `write` rejects with `UsageDeliveryError(..., false)`;
  - re-check every 5 min;
  - **switch-over**, all under one mutex shared with `write`:
    1. copy the buffered records to the HANA sink, idempotent, in batches;
    2. remove each batch from the buffer only after its copy resolved;
    3. once the buffer is empty, switch the active sink and reader to HANA.
  - Writes that arrive during the copy are queued behind the mutex, then go to whichever sink is active, so no record is stranded. A failed copy keeps the records, and the copy is retried at the next check.
- **Composition:**
  - with several sinks configured, writes go through `combineSinks`;
  - reads and export use the reader of the first configured sink that has one (`hana`, `pg` or `sqlite`; else `memory`; JSONL is write-only for export purposes);
  - status names the reading sink.
- **Retention:** daily, and at startup, on every configured sink that has `deleteOlderThan` (the database sinks). Memory is bounded by its limit, and JSONL by rotation.
- **Startup order:** `server.ts` awaits `initUsage(...)` before `startProviders(...)` (l.915), so construction-bound provider recorders never capture `undefined`.
- **Status:** `stats()` from the recorder, including `unconfirmed` (Task 0), plus the fallback state, the reading sink and the SQLite file size.
- **Shutdown:** wired into the existing graceful-shutdown path. Session close records first (Task 3), then `close`.

- [ ] **Step 1: Failing tests:**
  - config defaults and validation;
  - sink choice per session store, and the override;
  - explicit sink without a backend → error;
  - SQLite missing → memory fallback in status;
  - HANA missing: fallback, overflow reported as lost, switch-over copies and empties memory, a failed copy is retried;
  - retention runs on the database sinks only;
  - two sinks: writes reach both, and reads come from the first one with a reader;
  - status counters, including unconfirmed;
  - `initUsage` runs before `startProviders`;
  - the switch-over with concurrent writes: no record is lost or duplicated;
  - `userId` hashing is stable and on by default;
  - `LLM_AGENT_USAGE_MEASURE` without a kind suppresses its records and its timer;
  - off → `initUsage` returns `undefined`.
- [ ] **Steps 2–5:** fail → implement → pass (`npx jest --maxWorkers=1 test/unit/usage-*.test.ts`) → commit `feat(usage): runtime, sinks and fallback`.

### Task 2: Context propagation and hub-owned providers

**Files:**
- Modify: the dialogue and request paths:
  - `srv/lib/dialogue-sessions.ts`: the session-bound recorder created at open and revive, passed as `DialogueSessionOptions.usage`;
  - `srv/lib/dialogue-chat.ts`: the request recorder `.with({ requestId, traceId })` in `session.send` options;
  - `srv/openai-handler.ts`, `srv/anthropic-handler.ts`, `srv/agent-mcp.ts`: the request recorder in the call options they build;
  - `srv/lib/collection-retrieval.ts`, `srv/lib/llm-only-guard.ts` (classifier) and `srv/lib/step-reviewer.ts` (`evaluateGated`, `reviewStep`): pass `usage` with their role;
  - the query embedder in `srv/agent-manager.ts`.
- Modify: the hub-built providers:
  - `srv/lib/llm-factory.ts` (`makeHubLlm`): pass `usage: runtime.recorder` as the construction-bound recorder;
  - `srv/lib/sap-ai-core-embedder.ts` (`SapAiCoreEmbedder`):
    - its config gains `usage?: IUsageRecorder` (construction-bound), set where `srv/lib/providers.ts` builds it;
    - `embed(text, opts?)` and the batch path accept call options and use `opts.usage` / `opts.usageOp` through `startOperation`;
    - each SDK request is reported with `beginEmbeddingRequest`, in `finally`, with `granularity: 'sdk-call'` / `retriesVisible: false` if the SDK retries internally;
  - every other LLM or embedder the hub constructs. A test lists the constructions.
- Test: `test/unit/usage-propagation.test.ts`.

**Interfaces:** consumes Task 1 and the llm-agent hooks. Produces no new exports beyond test helpers.

- [ ] **Step 1: Failing tests** (fake LLM, MCP and embedder that record `opts.usage`; a memory sink):
  - a dialogue request: planner, task and checker records carry the session, user, turn, task and role;
  - the task finishes after the request ended, and keeps its `sessionId`;
  - two concurrent sessions do not swap context;
  - a plain session request and an agent MCP `execute_step` carry their session;
  - the step reviewer, guard classifier, retrieval embedding and query embedder record with their roles;
  - `SapAiCoreEmbedder` records ok, error and abort;
  - with usage off: no recorder is passed anywhere, and results are unchanged;
  - **real-pipeline scenario**, the design's completeness check: the real hub pipeline with fake LLM and MCP transports.
    - One dialogue session: a planner turn, two tasks, a checker and retrieval; two successive requests; work continuing after a disconnect.
    - Expected: every physical LLM, embedding and tool request appears exactly once, with session, user, role and task.
  - **content exclusion:** distinctive strings in the prompts, tool arguments, results and documents never appear in any serialized record.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): context propagation and hub-owned providers`.

### Task 3: Session and request records

**Files:**
- Modify, at the lifecycle owners:
  - **long sessions:** `srv/lib/session-lifecycle.ts` `lifecycleHooks` (open, revive, close) and `discardSession` (`expired-offline`, `endKnown: false`);
  - **plain sessions:**
    - open: the first request that creates the session's history in `srv/session-store.ts`;
    - close: `SessionRetention` eviction (`srv/lib/session-retention.ts`, synchronous `deleteAll` inside `lease`), history expiry in `srv/session-store.ts`, and `forgetEmptySessions`. Each emits `close` once, with a closed-set guard, so overlapping paths do not double it.
  - Collection sweeps only affect storage measures, not the session lifecycle.
  - the request ends in `srv/openai-handler.ts`, `srv/anthropic-handler.ts` and `srv/agent-mcp.ts`.
- Create: `srv/lib/usage/hub-records.ts`, with typed builders `sessionRecord(...)`, `requestRecord(...)` and their `x.hub.*` value shapes, using only numbers, labels and flags.
- **`x.hub.session` and `x.hub.request` fields:** exactly the spec's tables, including:
  - `responseEndAt` versus `operationEndAt` (work after a disconnect);
  - `protocol: 'mcp-agent'` with the tool name;
  - the close reasons `explicit`, `ttl`, `evicted`, `shutdown`, `expired-offline`.
- **Order.**
  - **Asynchronous closes** (long sessions, shutdown) await a fresh storage snapshot (Task 4) before cleanup.
  - **Synchronous eviction** (`SessionRetention.lease`) must stay synchronous. It emits `close` immediately with the session's **last cached** storage snapshot: the storage meter keeps one cached snapshot per live session, refreshed on its interval and on writes where cheap. The close record carries `storageSnapshotAt`, so its age is visible. Eviction never awaits a measurement.
  - **On shutdown**, every live session, long and plain, gets its close record before the runtime closes.
- Test: `test/unit/usage-session-request.test.ts`.

- [ ] **Step 1: Failing tests:**
  - open, revive and close for long sessions;
  - evicted and expired plain sessions;
  - `expired-offline`;
  - one request record per request for OpenAI and Anthropic, stream and non-stream, and agent MCP;
  - a disconnect with work continuing: `operationEndAt` > `responseEndAt`, recorded once;
  - shutdown order, including a live plain session;
  - **eviction while a measurement is slow:** a delayed storage measurement does not block `lease`; the evicted session's close uses the cached snapshot; another admission reuses the slot at once;
  - each plain-session close path emits exactly one close.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): session and request records`.

### Task 4: Storage records

**Files:**
- Create: `srv/lib/usage/storage-meter.ts`, with `measureSession(sessionId, userId)` and `measureUser(userId)`, returning the spec's non-overlapping measures. A missing measure is omitted, with its `<measure>Unknown: true` flag.
- Modify: the stores, so they expose cheap counters where they write, or bounded aggregate queries per backend (HANA, PostgreSQL, SQLite, memory). Never load content or vectors.
  - The dialogue store: state bytes excluding the outbox, and outbox bytes.
  - The session history store.
  - The collection registry and RAG stores: document count, text bytes, vector count × dimension × 4.
- **Scheduling:** at session close (the Task 3 hook) and every `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` for live sessions and users. Each tick is bounded, and a measurement still running is skipped, not overlapped.
- Test: `test/unit/usage-storage.test.ts`.

- [ ] **Step 1: Failing tests:**
  - measures for a session with state, outbox, history and a session collection;
  - the outbox is not counted twice;
  - an unsupported measure is flagged unknown;
  - no content is read: a spy on the content-loading methods;
  - the user-scope measures;
  - overlapping ticks are skipped.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): storage records`.

### Task 5: Process records

**Files:**
- Create: `srv/lib/usage/process-meter.ts`. Every `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS` it records `x.hub.process`:
  - `process.memoryUsage()` (RSS, heap used, external);
  - `process.cpuUsage()` deltas;
  - `perf_hooks.monitorEventLoopDelay` p99;
  - active sessions, running tasks, open SAP connections and the admission queue length, from the existing registries.
- Test: `test/unit/usage-process.test.ts`.

- [ ] **Step 1: Failing tests:**
  - the record shape and the deltas over two ticks;
  - the counters come from the registries;
  - the timer is cleared on close.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): process records`.

### Task 6: Export and status routes

**Files:**
- Create: `srv/usage-handler.ts`, with `GET /v1/usage/records` and `GET /v1/usage/status` as in the spec.
- Modify: `srv/server.ts`. Register them with `requireAdminRole` before the `/v1` `requireMcpRole` (l.730) and before session resolution.
- **Behaviour:**
  - streams `runtime.reader().read(query)`. Loss evidence comes from the reader's selection rule.
  - **JSONL** uses `exportRecords`.
  - **CSV** uses a hub exporter (`srv/lib/usage/csv.ts`):
    - the common columns;
    - one column per known `x.hub.*` value: session, request, storage, storage.user and process, from the typed builders of Task 3, with the Task 4 and 5 shapes;
    - the library kinds' fields;
    - a `loss_evidence` column.
    - Unknown extension values go to a trailing `extra_json` column.
  - recording off gives 404 with a clear message;
  - logs carry no content.
- Test: `test/unit/usage-handler.test.ts`.

- [ ] **Step 1: Failing tests:**
  - an admin-only user gets records and status, and no tool access elsewhere;
  - Reader or Developer without Admin → 403;
  - Admin plus Developer → both;
  - stale session headers do not matter;
  - the window, `kinds` and `sessionId` filters;
  - the CSV has real columns for session, request, storage and process values, not JSON;
  - a late loss record across the window boundary and `''` losses are included;
  - recording off → 404.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): admin export and status`.

### Task 7: HANA DDL, documentation, benchmark

**Files:**
- **HANA DDL:** the existing script deploys HDI artifacts (`.hdiconfig` + `.hdbtable`), not plain SQL. Add `USAGE_RECORDS.hdbtable` and its indexes as `.hdbindex` artifacts to the files the script deploys. Register the index plugin in `.hdiconfig`. The artifact content follows the table and indexes of `llm-usage-hana` DDL (the `ddl/usage.sql` of the llm-agent package `llm-usage-hana`). A test asserts that the artifacts match the package DDL: the same columns, primary key and indexes. Keep `--dry-run` working and test it the way the existing test does. Task 8 deploys it for real.
- **Docs:**
  - `docs/llm-agent/CONFIG_USAGE.md`: a "Usage analytics" section with the settings table, the sink choice, the SQLite loss caveat, export and status;
  - `docs/architecture/ARCHITECTURE.md`: a short paragraph;
  - `CHANGELOG.md`.
- **Benchmark:** create `test/bench/usage-overhead.ts`, with an npm script `bench:usage` added in this task. It runs the fake-pipeline dialogue scenario with recording on and off and prints latency and heap. It is not part of `npm test`.

- [ ] **Step 1:** Implement.
  - Run `node tools/check-docs.js`: only the known environmental errors may remain.
  - Run the benchmark once and put its numbers in the PR description.
  - Commit `docs(usage): configuration, HANA DDL and benchmark`.

### Task 8: Live verification on the POC

No code. After release and deploy, with the user's go-ahead:
- turn recording on with `cf set-env` (deploy-like, so it needs the user's "так") or the `.mtaext`;
- apply the HANA DDL;
- run one session per typical scenario: question, read task, multi-step task;
- export as CSV;
- check the totals against AI Core and logs where they are visible.

Record the run in `docs/superpowers/verification/`, without engagement details.
