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

**Tech Stack:** TypeScript (CAP / Express), Jest (`--maxWorkers=1`), Biome, `@mcp-abap-adt/llm-usage` and the `pg`, `hana` and `sqlite` sink packages 1.0.0, `@mcp-abap-adt/llm-agent(-libs)` 30.11.0.

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

### Task 1: Dependencies, usage runtime, sinks and fallback

**Files:**
- Modify: `package.json`. Bump `@mcp-abap-adt/llm-agent` and `-libs` to `^30.11.0`, `-mcp` and providers to `^30.10.0`; add `@mcp-abap-adt/llm-usage`, `-pg`, `-hana` and `-sqlite` at `^1.0.0`. Run `npm install`, which the human does if the sandbox is offline.
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
  - a `memorySink({ limit: LLM_AGENT_USAGE_MEMORY_LIMIT, evict: false })` in fallback;
  - re-check every 5 min;
  - on success, copy the records (idempotent), delete each copied record from memory, and switch. A failed copy keeps the record.
- **Retention:** daily, and at startup.
- **Shutdown:** wired into the existing graceful-shutdown path. Session close records first (Task 3), then `close`.

- [ ] **Step 1: Failing tests:**
  - config defaults and validation;
  - sink choice per session store, and the override;
  - explicit sink without a backend → error;
  - SQLite missing → memory fallback in status;
  - HANA missing: fallback, overflow reported as lost, switch-over copies and empties memory, a failed copy is retried;
  - retention runs;
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
  - `srv/lib/providers.ts`: `SapAiCoreEmbedder` reports each request with `beginEmbeddingRequest`, in `finally`, and `granularity: 'sdk-call'` / `retriesVisible: false` if its SDK retries internally;
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
  - with usage off: no recorder is passed anywhere, and results are unchanged.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): context propagation and hub-owned providers`.

### Task 3: Session and request records

**Files:**
- Modify:
  - `srv/lib/session-lifecycle.ts`: `lifecycleHooks` (long sessions: open, revive, close), `discardSession` (`expired-offline`, `endKnown: false`), and the plain-session eviction and expiry in `srv/lib/gatekeeper.ts` (`SessionRetention`);
  - the request ends in `srv/openai-handler.ts`, `srv/anthropic-handler.ts` and `srv/agent-mcp.ts`.
- Create: `srv/lib/usage/hub-records.ts`, with typed builders `sessionRecord(...)`, `requestRecord(...)` and their `x.hub.*` value shapes, using only numbers, labels and flags.
- **`x.hub.session` and `x.hub.request` fields:** exactly the spec's tables, including:
  - `responseEndAt` versus `operationEndAt` (work after a disconnect);
  - `protocol: 'mcp-agent'` with the tool name;
  - the close reasons `explicit`, `ttl`, `evicted`, `shutdown`, `expired-offline`.
- **Order:** the session close record and the final storage snapshot (Task 4 hook) are taken before cleanup. On shutdown, all sessions are closed (records) before the runtime closes.
- Test: `test/unit/usage-session-request.test.ts`.

- [ ] **Step 1: Failing tests:**
  - open, revive and close for long sessions;
  - evicted and expired plain sessions;
  - `expired-offline`;
  - one request record per request for OpenAI and Anthropic, stream and non-stream, and agent MCP;
  - a disconnect with work continuing: `operationEndAt` > `responseEndAt`, recorded once;
  - shutdown order.
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
  - streams `runtime.reader().read(query)` through `exportRecords`. Loss evidence comes from the reader's selection rule, and CSV gets a `loss_evidence` column;
  - recording off gives 404 with a clear message;
  - logs carry no content.
- Test: `test/unit/usage-handler.test.ts`.

- [ ] **Step 1: Failing tests:**
  - an admin-only user gets records and status, and no tool access elsewhere;
  - Reader or Developer without Admin → 403;
  - Admin plus Developer → both;
  - stale session headers do not matter;
  - the window, `kinds` and `sessionId` filters;
  - the CSV columns;
  - a late loss record across the window boundary and `''` losses are included;
  - recording off → 404.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(usage): admin export and status`.

### Task 7: HANA DDL, documentation, benchmark

**Files:**
- **HANA DDL:** `tools/deploy-hdi-tables.sh` also applies the `llm-usage-hana` DDL (`node_modules/@mcp-abap-adt/llm-usage-hana/ddl/usage.sql`). Keep `--dry-run` working and test it the way the existing test does.
- **Docs:**
  - `docs/llm-agent/CONFIG_USAGE.md`: a "Usage analytics" section with the settings table, the sink choice, the SQLite loss caveat, export and status;
  - `docs/architecture/ARCHITECTURE.md`: a short paragraph;
  - `CHANGELOG.md`.
- **Benchmark:** create `test/bench/usage-overhead.ts`, run by `npm run bench:usage`. It runs the fake-pipeline dialogue scenario with recording on and off and prints latency and heap. It is not part of `npm test`.

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
