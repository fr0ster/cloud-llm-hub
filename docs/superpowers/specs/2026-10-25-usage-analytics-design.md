# Usage analytics in the hub: per-session resource statistics

<!-- docs-check:proposed-env: this design proposes LLM_AGENT_USAGE_* settings, which do not exist yet -->

Date: 2026-10-25. Status: draft for review. Supersedes the token-only usage ledger draft of 2026-10-22, which was never merged.

## Intent

We take the real resource cost of a session on the hub. Later, when a customer says "we expect N users", we can say which subaccount parameters they need.

Now we only collect raw statistics. The analysis (minimum Python, maybe Grafana or other tools later) is decided after the data exists, so the records must be complete and detailed enough for any aggregation.

Code goes to the main repo (`fr0ster/cloud-llm-hub`, a branch from `main`), which already has the dialogue sessions, outbox and persistence it measures.

The contract, the transports and the sinks live in llm-agent: `docs/superpowers/specs/2026-10-25-usage-analytics-design.md` there, the llm-agent packages `llm-usage`, `llm-usage-pg`, `llm-usage-hana` and `llm-usage-sqlite`. The hub configures them and adds its own measurements.

## Goals

- Every resource the hub spends is recorded per session, with user, turn, task, role and destination where known:
  - LLM and embedding calls (through llm-agent);
  - SAP tool calls and tasks (through llm-agent);
  - the hub's own measurements below.
- Records can be exported for analysis.
- The hub is configurable: the transport, the sinks, which measurements, the intervals and the retention.

## Non-goals

- Forecast models, sizing calculators, dashboards.
- Per-customer billing.

## Anti-goals

- **Missing records.** Missing calls or sessions, and so totals that are silently low.
- **Measurable overhead.** Latency or memory cost on chat and agent requests.
- **Sensitive content in records.** Conversation text, collection documents, SAP data, credentials or tokens.

## Hub measurements

All of them are `x.hub.*` records of the llm-agent contract: numbers, labels and flags only.

| Record | When | Values |
|---|---|---|
| `x.hub.session` | open, close, revive | event (`open`/`close`/`revive`), close reason, duration, turns, tasks, messages delivered, protocol mix (openai/anthropic, stream/non-stream counts) |
| `x.hub.request` | end of every chat/agent request | protocol, stream flag, admission wait, turn duration, follow duration, end reason (done/waiting_user/idle/limit/superseded/disconnected/error), messages delivered, bytes written |
| `x.hub.storage` | on session close, and every `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` for live sessions | bytes per store for the session: dialogue state, outbox, history, session collections (documents, vectors) |
| `x.hub.storage.user` | every `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` | per user: user-scope collection documents and vector bytes |
| `x.hub.process` | every `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS` | RSS, heap used, external memory, CPU user/system ms since the last snapshot, event-loop delay p99, active sessions, running tasks, open SAP connections, admission queue length |

`x.hub.process` carries no session id. Attribution to sessions is a later analysis step: the active-session count is in the record, and session records give time windows. *(My call: a per-session memory split inside one Node process cannot be measured honestly.)*

Library usage is recorded by llm-agent's boundary decorators (`UsageLlm`, `UsageEmbedder`, the MCP client, TaskBoard).
- **Decorators.** The hub applies the LLM and embedder decorators directly around every provider it builds (`srv/lib/llm-factory.ts` and the embedder factories), inside retry wrappers.
- **Not sources.** Its existing usage wrappers (`tracked-llm`, review-scope token capture) and `IRequestLogger` stay as they are and are not record sources.
- **Recorder per call.** The hub passes its recorder in `CallOptions.usage` for every request and dialogue session.

The context of library records comes from the hub binding the recorder per request and per dialogue session: `sessionId`, `userId`, `destination`, `traceId`. The library narrows it with `role`, `turnId` and `taskId`.

`userId` is a stable hash of the user id by default (`LLM_AGENT_USAGE_USER_ID=hash|plain`). *(My call: analysis needs a stable key, not the person.)*

## Configuration (`LLM_AGENT_USAGE_*`)

| Setting | Default | Meaning |
|---|---|---|
| `LLM_AGENT_USAGE` | `off` | `on` enables recording |
| `LLM_AGENT_USAGE_SINKS` | `sql` when persistence is configured, otherwise `sqlite` | comma list of `sql`, `sqlite`, `jsonl`, `memory` |
| `LLM_AGENT_USAGE_SQLITE_PATH` | a file in the app's working directory | SQLite file for the `sqlite` sink |
| `LLM_AGENT_USAGE_PROCESS_INTERVAL_MS` | `30000` | process snapshot interval |
| `LLM_AGENT_USAGE_STORAGE_INTERVAL_MS` | `600000` | storage snapshot interval |
| `LLM_AGENT_USAGE_RETENTION_DAYS` | `90` | SQL retention |
| `LLM_AGENT_USAGE_USER_ID` | `hash` | `hash` or `plain` |

The hub uses the `direct` transport only. *(My call: one `srv` instance today, so there is no remote collector to feed. `http` and `signals` exist in llm-agent for consumers that need them, and the hub can add them later without changing its records.)*

Without persistence, the `sqlite` sink (`llm-usage-sqlite`, Node ≥ 22.13) writes to the container disk; if the runtime lacks `node:sqlite`, the hub logs it, reports it in `/v1/usage/status` and falls back to the `memory` sink.
- **Loss on restart.** The CF container disk is ephemeral: the file is lost on every restart, restage, redeploy or instance move. The user decided this is the small price of running without persistence. Statistics that must survive are collected on a deployment with persistence.
- **Disk quota.** The file is bounded by the app's disk quota. Retention by age applies here too, and `/v1/usage/status` reports the file size.

The `sql` sink uses the hub's existing persistence (`llm-usage-pg` or `llm-usage-hana`):
- **PostgreSQL:** the table is created at runtime.
- **HANA:** the DDL from the llm-agent package `llm-usage-hana` is added to `tools/deploy-hdi-tables.sh`, which already applies the vector-store tables to the shared HDI container. The sink runs with `autoCreateSchema` off; if the table is missing, `/v1/usage/status` reports it and records stay in memory.

## Export

`GET /v1/usage/records?from=&to=&kinds=&format=jsonl|csv`:
- streams the records of the window;
- `x.hub.*` values are flattened into columns for CSV;
- refused unless the caller has `MCP_Admin` (see Roles);
- logged without contents.

`GET /v1/usage/status` reports:
- whether recording is on, and the transport and sinks;
- the buffered count;
- dropped counts since start;
- the last write error code.

## Validation

- **Completeness (scenario-level, against the real pipeline with fake LLM and MCP):**
  - a dialogue session with a planner turn, two tasks, a checker and retrieval;
  - every LLM, embedding and tool call appears exactly once, with session, user, role and task;
  - one `x.hub.request` per request, and `x.hub.session` open and close.
- **Content:** distinctive strings in the prompts, tool arguments, results and collection documents never appear in any record.
- **Overhead:** a small benchmark harness, built as part of this work since none exists, runs the fake-pipeline dialogue scenario with recording on and off. Latency and memory stay within noise. Recording off is identical to today.
- **Export:**
  - the window and kind filters;
  - the CSV columns;
  - refusal without the role.
- **Retention:** records older than the retention are removed.
- **Live on the POC:** one session per typical scenario (question, read task, multi-step task). Export it, and check the totals against AI Core and logs where they are visible.

## Roles

The user decided to replace `MCP_Full` with `MCP_Admin` and to remove `MCP_Analyst`.

- **What it grants.** Administrative endpoints only: usage export and status now, and later the global planner-skill administration of the planner prompt design.
- **The tool roles left:** `MCP_Reader` and `MCP_Developer`, unchanged.
- **Removal of `MCP_Analyst`.** It already grants exactly the Reader level (`srv/lib/exposition.ts` maps it to Reader), so nobody loses access by holding `MCP_Reader` instead.
  - **Scope and role collection.** The scope, role template and role collection `MCP Analyst Access` are removed. The `MCP_Developer` template stops referencing the Analyst scope.
  - **People.** People who hold `MCP Analyst Access` get `MCP Reader Access`. On the POC the test user already holds Reader.
  - **Technical clients.** The analyst consumer XSUAA instance (`xs-security-analyst-consumer.json`, granted through `grant-as-authority-to-apps` in `mta.yaml`) is retargeted to `MCP_Reader`, keeping its instance name so existing bindings keep working. *(My call: renaming the instance would force every technical client to rebind.)*
- **Not a composite role.** The user decided: no composite roles, give each role that is needed. The `MCP_Admin` role template references only `$XSAPPNAME.MCP_Admin` and grants no tool exposition. A person who administers and also works with SAP tools gets `MCP Admin Access` together with the tool role they need, for example `MCP Developer Access`.
- **What changes:**
  - **XSUAA and deployment:** the scope `$XSAPPNAME.MCP_Admin`, the role template `MCP_Admin` and the role collection `MCP Admin Access` are added. `MCP_Full` and `MCP_Analyst` are removed from `xs-security.json`, `mta.yaml` and the analyst consumer file.
  - **Code:** the role lists and exposition mapping in `srv/lib/exposition.ts` and `srv/server.ts`, including the access-denied text.
  - **Documentation:** every mention of `MCP_Full` and `MCP_Analyst`.
  - **Tests:** `test/unit/exposition*.test.ts`, `test/integration/role-exposition.test.ts` and `tools/measure-tool-rag.ts`.
- **Removal of `MCP_Full`.** The user confirmed that `MCP_Full` was never assigned to anyone, so it is removed without migration. The CHANGELOG lists it under Removed. *(My call: a minor release, since no assignment breaks.)*
- **Separate item.** This is a security change: its own PR, reviewed as such, before the export endpoint ships.
