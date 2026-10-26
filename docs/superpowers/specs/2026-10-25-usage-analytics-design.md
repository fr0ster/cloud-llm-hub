# Usage analytics in the hub: per-session resource statistics

<!-- docs-check:proposed-env: this design proposes LLM_AGENT_USAGE_* settings, which do not exist yet -->

Date: 2026-10-25. Status: approved (revision 3: context size per LLM request). Supersedes the token-only usage ledger draft of 2026-10-22, which was never merged.

## Intent

We take the real resource cost of a session on the hub. Later, when a customer says "we expect N users", we can say which subaccount parameters they need.

Now we only collect raw statistics. The analysis (minimum Python, maybe Grafana or other tools later) is decided after the data exists, so the records must be complete and detailed enough for any aggregation.

Code goes to the main repo (`fr0ster/cloud-llm-hub`, a branch from `main`).

The contract, transports and sinks live in llm-agent: `docs/superpowers/specs/2026-10-25-usage-analytics-design.md` there, and the llm-agent packages `llm-usage`, `llm-usage-pg`, `llm-usage-hana` and `llm-usage-sqlite`. The hub configures them, propagates context and adds its own measurements.

## Goals

- **Per-session coverage.** Every resource the hub spends is recorded per session, with user, turn, task, role and destination where known:
  - LLM, embedding and SAP tool calls, and tasks (through llm-agent's instrumentation, plus the hub-owned providers below);
  - the hub's own measurements.
- **Context size per LLM request.** How much context each LLM request sends, for the planner, the executor and every helper LLM: messages per role, characters, tool definitions, and tokens where the provider reports them. This comes from the request shape of `llm.call` (llm-agent spec, revision 5), with the role labels below, plus `x.hub.retrieval` for the retrieved context the hub injects.
- **Export.** Records, including the evidence of losses, can be exported for analysis.
- **Configuration.** The sinks, the measurements, the intervals and the retention are configurable.

## Non-goals

- Forecast models, sizing calculators, dashboards, per-customer billing.

## Anti-goals

- **Missing records.** Missing calls or sessions, so totals are silently low.
- **Overhead.** Measurable latency or memory cost on chat and agent requests.
- **Sensitive content in records.** Conversation text, collection documents, SAP data, credentials or tokens.

## Instrumentation the hub owns

- **Hub-owned providers.** The hub builds some providers itself. They report through the same llm-agent hooks (`reportLlmRequest`, `reportEmbeddingRequest`), with the same rules:
  - one record per physical request, recorded in `finally`;
  - `granularity: 'sdk-call'` and `retriesVisible: false` where the SAP SDK retries internally and cannot be told not to.
  - This covers `SapAiCoreEmbedder` (`srv/lib/providers.ts`) and any LLM or embedder the hub constructs outside llm-agent's provider packages. A test lists the hub's provider constructions and fails when one does not report.
- **Hub-owned LLM calls.** Calls the hub makes itself pass the recorder in their call options, so they are attributed like library calls:
  - the step reviewer (`evaluateGated`, `reviewStep`): `role: 'reviewer'`, `component: 'step-reviewer'`;
  - collection retrieval embeddings: `role: 'embedding'`, `component: 'collection-retrieval'`;
  - the LLM-only guard's classifier: `role: 'classifier'`, `component: 'llm-only-guard'`;
  - the query embedder: `role: 'embedding'`, `component: 'query-embedder'`.
  - `role` uses llm-agent's `LlmComponent` names; `component` is a hub context label that tells helpers apart. Every hub-owned LLM call sets both, so context size can be grouped by role and by helper.

## Context propagation

- **Session recorder.** Each dialogue session holds a session-bound recorder, `recorder.with({ sessionId, userId, destination })`. It is created when the session opens or revives and given to `DialogueSession.open`. The library narrows it with `turnId`, and TaskBoard narrows it with `taskId` and role, so background tasks keep their attribution after the request that started them has ended or disconnected.
- **Request recorder.** Each chat request narrows the session recorder with `requestId` and `traceId`. `dialogue-chat.ts` passes it in the options of `session.send(...)`, next to `signal` and `trace`.
- **Plain chat and agent MCP requests.** These bind a request recorder from the request's session (plain session or long session) and pass it in the call options they build.
- **No mutable bindings.** Shared, per-destination providers receive context only through call options, never through request-scoped mutable state.

## Hub measurements

All of them are `x.hub.*` records of the llm-agent contract: numbers, labels and flags only.

**`x.hub.session`** records the lifecycle of every session kind. The owner is the code that ends the session:

| Event | When |
|---|---|
| `open` | a session is opened or created |
| `revive` | a persisted session is revived |
| `close` | the session ends, with its reason: `explicit`, `ttl`, `evicted`, `shutdown`, `expired-offline` |

- **Long sessions.** `LongSessionRegistry` hooks.
- **Plain sessions.** `SessionRetention` eviction and expiry.
- **Expired while the process was down.** `discardSession` records `close` with reason `expired-offline` and `endKnown: false`.
- **Close values:** duration, turns, tasks, messages delivered, and the protocol mix.
- **Order.** The final storage snapshot of the session is taken before cleanup deletes its state. On shutdown, session close records are produced before the recorder closes.

**`x.hub.request`**, one per request:

| Field | Values |
|---|---|
| `protocol` | `openai`, `anthropic`, `mcp-agent` (with the agent MCP tool name, for example `execute_step`) |
| request shape | stream flag, admission wait |
| durations | turn duration, follow duration |
| `endReason` | `done`, `waiting_user`, `idle`, `limit`, `superseded`, `disconnected`, `error` |
| `responseEndAt` | when the response ended |
| `operationEndAt` | when the request's own work ended; later than `responseEndAt` when work continued after a disconnect |
| delivery | messages delivered, bytes written |

**`x.hub.storage`**, per session, with non-overlapping logical measurements:

| Measure | What is counted |
|---|---|
| `stateBytes` | the persisted dialogue state, excluding the outbox |
| `outboxBytes` | the outbox entries (stored inside the state row, counted only here) |
| `historyBytes` | the session history |
| `sessionCollection` | documents, text bytes, vectors × dimension × 4 bytes, for session-scope collections |

Logical bytes are the UTF-8 length of the persisted payloads, and vector bytes are computed from count and dimension. They are not database allocation.

**`x.hub.storage.user`**, per user: the same collection measures for user-scope collections.

How storage is measured:
- **Counters, not scans.** Values come from counters the stores maintain at write time where cheap. Otherwise they come from bounded asynchronous aggregate queries (`COUNT`, `SUM(LENGTH)`) per backend: HANA, PostgreSQL, SQLite and memory.
- **Never content.** Content and vectors are never loaded to measure them.
- **Unknown values.** A measure the backend cannot provide is omitted, and the record carries `<measure>Unknown: true` (for example `historyBytesUnknown: true`). This fits the contract's value types (number, string, boolean) and keeps partial snapshots unambiguous.
- **When.** At session close, and every `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` for live sessions and users.

**`x.hub.retrieval`**, one per collection-retrieval injection (`srv/lib/collection-retrieval.ts`), in the request's context:
- `collections`: collections searched; `chunks`: chunks injected; `chars`: characters of the injected context; `injected`: whether anything was added.
- With `llm.call`'s `userChars` it shows how much of a request's user content is retrieved context.
- It belongs to the `request` measure of `LLM_AGENT_USAGE_MEASURE`.

**`x.hub.process`**, every `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS`:
- RSS, heap used and external memory;
- CPU user/system ms since the last snapshot;
- event-loop delay p99;
- active sessions, running tasks, open SAP connections, admission queue length.

It carries no session id. Attribution to sessions is a later analysis step, using the active-session counts and the session time windows. *(My call: a per-session memory split inside one Node process cannot be measured honestly.)*

`userId` is a stable hash of the user id by default (`LLM_AGENT_USAGE_USER_ID=hash|plain`).

## Sinks and configuration

**Choosing the sink.** The default sink follows the hub's session store (`LLM_AGENT_SESSION_STORE`):

| Session store | Default usage sink |
|---|---|
| `hana-vector` | `hana` (`llm-usage-hana`) |
| `pg-vector` | `pg` (`llm-usage-pg`) |
| `sqlite` or `none` | `sqlite` (`llm-usage-sqlite`) |

- An explicit `LLM_AGENT_USAGE_SINKS` overrides the default.
- If an explicit sink's backend is not configured, startup fails with a clear configuration error.

**SQLite on the container disk** (no persistence). The user decided the loss is the small price of running without persistence.
- **Loss.** The file is lost on every restart, restage, redeploy or instance move.
- **Bounds.** It is bounded by the disk quota and by the retention.
- **Missing `node:sqlite`.** If the runtime lacks it (Node < 22.13; the mta engine is 22.16), the hub logs it, reports it in status and falls back to the bounded `memory` sink.

**HANA.** The DDL from `llm-usage-hana` is added to `tools/deploy-hdi-tables.sh`, which already applies the vector-store tables to the shared HDI container. The sink runs with `autoCreateSchema` off. If the table is missing:
- the hub uses a bounded, readable `memory` sink in fallback mode and reports it in status. In this mode the sink never evicts: when full, it rejects new batches with `UsageDeliveryError(possiblyDelivered: false)`, so the recorder accounts them as lost through its normal path, with their session, kind and affected time range in `x.usage.lost`;
- it re-checks the table every 5 minutes;
- once the table exists, it copies the memory sink's records to it (idempotent by id) and switches over.
- A record leaves memory only after its copy succeeded. A failed copy keeps it, and the copy is retried at the next check.

**Retention.** Retention runs once a day, and at startup, against the configured sink.

**Settings:**

| Setting | Default | Meaning |
|---|---|---|
| `LLM_AGENT_USAGE` | `off` | `on` enables recording |
| `LLM_AGENT_USAGE_SINKS` | from the session store (above) | comma list of `hana`, `pg`, `sqlite`, `jsonl`, `memory` |
| `LLM_AGENT_USAGE_MEASURE` | `all` | comma list of `llm`, `embedding`, `tool`, `task`, `session`, `request`, `storage`, `process` |
| `LLM_AGENT_USAGE_SQLITE_PATH` | `usage.sqlite` in the app's working directory | SQLite file |
| `LLM_AGENT_USAGE_JSONL_PATH` / `LLM_AGENT_USAGE_JSONL_ROTATE_BYTES` | (unset) / `104857600` | JSONL file and rotation |
| `LLM_AGENT_USAGE_MEMORY_LIMIT` | `100000` | records kept by the `memory` sink |
| `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS` | `30000` | process snapshot interval |
| `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` | `600000` | storage snapshot interval |
| `LLM_AGENT_USAGE_RETENTION_DAYS` | `90` | retention |
| `LLM_AGENT_USAGE_USER_ID` | `hash` | `hash` or `plain` |

The transport is always `direct`. *(My call: one `srv` instance today, so there is no remote collector to feed. `http` and `signals` exist in llm-agent for consumers that need them.)*

## Export and status

Both routes are guarded only by `MCP_Admin`. They are registered before, and independently of, the `/v1` tool-role check (`requireMcpRole`) and session resolution, so an admin with no tool role can use them, and stale session headers do not matter.

**`GET /v1/usage/records?from=&to=&kinds=&sessionId=&format=jsonl|csv`**
- Streams the records whose `at` is in the window and that match the filters. `x.hub.*` values are flattened into CSV columns.
- **Loss evidence, always included.** It also includes every `x.usage.lost` record whose `affectedFrom`/`affectedTo` range overlaps the window, whatever the `kinds` filter and wherever its own `at` lies. That covers records with session `''` and, with a `sessionId` filter, also that session's loss records.
- **Marking.** In CSV these rows are marked `loss_evidence=true`.
- **Logging.** The route logs no contents.

**`GET /v1/usage/status`** reports:
- on/off and the sink;
- the fallback state;
- buffered, delivered, unconfirmed and lost counts;
- the last error code;
- the SQLite file size.

## Roles

The user decided to replace `MCP_Full` with `MCP_Admin` and to remove `MCP_Analyst`.

- **The roles after the change.**
  - **Tool roles:** `MCP_Reader` and `MCP_Developer`, unchanged.
  - **`MCP_Admin`:** grants administrative endpoints only: usage export and status now, later the global planner-skill administration.
- **Not composite.** The user decided: no composite roles, give each role that is needed. The `MCP_Admin` template references only `$XSAPPNAME.MCP_Admin`. Someone who administers and works with SAP tools gets `MCP Admin Access` plus the tool role they need.
- **Separate authorization.**
  - Tool authorization (`MCP_ROLES` in `srv/server.ts`, `resolveExposition` in `srv/lib/exposition.ts`) contains only `MCP_Reader` and `MCP_Developer`; `MCP_Admin` grants no exposition at all.
  - Admin authorization is a separate check on `MCP_Admin`.
  - The access-denied text names only the tool roles.
- **Removal of `MCP_Full`.** It was never assigned to anyone, per the user, so it is removed without migration and listed under Removed in the CHANGELOG. *(My call: a minor release.)*
- **Removal of `MCP_Analyst`.** It already grants exactly Reader level.
  - Its scope, template and role collection are removed, and `MCP_Developer` stops referencing it.
  - People with `MCP Analyst Access` get `MCP Reader Access`. The POC test user already has Reader.
  - In `mta.yaml`, the analyst consumer's `grant-as-authority-to-apps` moves to the Reader scope. The consumer instance keeps its name, so technical bindings keep working. *(My call.)*
- **Tests.**
  - An admin-only user can call export and status, and gets no tools.
  - Reader or Developer without Admin are refused export.
  - Admin plus Developer gets both.
  - Stale session headers do not affect the admin routes.
  - The exposition and role tests are updated, including `test/integration/role-exposition.test.ts`.
- **Separate PR.** This is a security change, reviewed as such, before the export endpoint ships.

## Validation

- **Completeness, scenario-level** (real pipeline, fake LLM and MCP):
  - a dialogue session with a planner turn, two tasks, a checker and retrieval;
  - successive requests in one session, and two concurrent sessions;
  - work continuing after a disconnect;
  - a plain session evicted, and a session expired offline;
  - an agent MCP `execute_step`;
  - expected: every LLM, embedding and tool request appears once with the right session, user, role and task; one `x.hub.request` per request; `x.hub.session` open and close in each case.
- **Context size.** Planner, executor and every hub-owned helper `llm.call` carry the request shape and their `role` (and `component` for helpers); a retrieval injection yields `x.hub.retrieval` with the injected size.
- **Hub-owned providers.** `SapAiCoreEmbedder` and the step reviewer, the guard classifier and the retrieval embeddings produce records.
- **Storage.**
  - Measures do not overlap: the outbox is not counted twice.
  - Unknown measures are omitted, with their `…Unknown` flag set.
  - No content is loaded.
- **Content.** Distinctive strings in the prompts, tool arguments, results and documents never appear in any record.
- **Overhead.** A small benchmark harness, built as part of this work, runs the fake-pipeline dialogue scenario with recording on and off. Latency and memory stay within noise, and recording off is identical to today.
- **Export.**
  - Window, kind and session filters work, with the CSV columns.
  - Loss evidence is included across a window boundary (late loss) and for `''` losses.
  - Requests without `MCP_Admin` are refused.
- **Fallbacks and retention.**
  - The HANA-table-missing fallback and switch-over.
  - Fallback overflow before switch-over: the overflowing batches are reported in `x.usage.lost` with the right sessions and ranges; nothing in memory is lost silently, and a failed copy is retried.
  - The SQLite capability fallback, and retention.
- **Live on the POC.** One session per typical scenario (question, read task, multi-step task). Export it, and check the totals against AI Core and logs where they are visible.
