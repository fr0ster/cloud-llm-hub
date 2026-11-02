# Timeout audit ? 2026-11-02

Branch: `fix/10.4.1-visibility`. No commit made.

Locations below refer to the pre-change HEAD so removed timers can be found with
`git show HEAD:<file>`. One row represents a logical bound; related option, env,
and consumer references are grouped in that row. Type declarations, clearTimeout,
comments and error classification strings do not create additional timers.

Search: `setTimeout`, `setInterval`, `AbortSignal.timeout`, `timeout`, `deadline`,
`Promise.race`, `maxMs`, `maxDurationMs`, DB connect/statement options, and env configuration.
No `AbortSignal.timeout` occurs in srv. Cancellation-only Promise.race in
collection-persistence is retained: no timer. External provider/driver limits are
not hub deadlines. Session TTL/expiry timestamps govern lifecycle, not elapsed work.

Categories: liveness: 4, periodic: 19, safety net: 4, work-path deadline: 24.

Decisions: keep: 25, raise+log: 6, remove: 13, replace with caller abort: 7. Total: 51 logical entries.

| File:line (baseline) | What it bounds | Category | Decision | Reason |
| --- | --- | --- | --- | --- |
| srv/agent-config.ts:168 | ProfileResolver whole preparation configuration | work-path deadline | raise+log | Positive value required by library: default 600000 ms; explicit env override preserved. Dialogue logger reports preparation/background failures at warn. |
| srv/lib/dialogue-sessions.ts:884 | Library whole planner/worker preparation option | work-path deadline | raise+log | Same required compatibility safety net, not a three-second read budget. |
| srv/agent-manager.ts:3039 | Fallback profile configuration and source wiring | work-path deadline | raise+log | Use the same 600000 ms compatibility default. |
| srv/agent-manager.ts:3085 | Compatibility worker preparation | work-path deadline | replace with caller abort | Remove timer; retain signal forwarding, cancellation race and listener cleanup. |
| srv/lib/agent-profile-source.ts:162 | Profile reads and catalogue preparation | work-path deadline | replace with caller abort | Database load must not look like unavailable configuration; retain caller cancellation race. |
| srv/lib/llm-only-guard.ts:130 | Classifier LLM call | work-path deadline | replace with caller abort | Slow classification is valid work; abort only with caller. |
| srv/lib/tool-query-analyzer.ts:98 | Shared tool classifier/translation factory and chat | work-path deadline | replace with caller abort | Each waiter can cancel; shared controller aborts when last waiter leaves, without a timer. |
| srv/agent-config.ts:732 | Legacy tool gate timeout setting/parser | work-path deadline | remove | No longer arms a timer; retained parser/argument compatibility only. |
| srv/lib/step-reviewer.ts:261 | Honesty reviewer LLM call | work-path deadline | replace with caller abort | Forward caller signals through all four reviewer entry points; no fail-open clock. |
| srv/lib/step-gate.ts:33 | Legacy reviewer timeout parser | work-path deadline | remove | No longer used to bound reviews; exported parser retained for compatibility. |
| srv/lib/planner-memory.ts:246 | Plan-author knowledge and memory retrieval | work-path deadline | replace with caller abort | Remove three-second retrieval deadline, retain request signal and cancellation race. |
| srv/rag-collections.ts:879 | Collection restore readiness wait (readyTimeoutMs / READY_WAIT_MS) | work-path deadline | remove | Await restore itself; do not return a synthetic 503 while the backend is working. Legacy option is ignored. |
| srv/agent-manager.ts:3882 | Destination initialization wait | work-path deadline | remove | Wait for shared initialization rather than returning a deadline-based failure. Legacy env parser remains unused. |
| srv/lib/long-session.ts:138 | Previous session cleanup before admission | work-path deadline | remove | Await cleanup completion; no fifteen-second abandonment. |
| srv/lib/dialogue-follow.ts:46 | Superseded response completion | work-path deadline | remove | Wait for actual response end before next delivery takes ownership. |
| srv/lib/dialogue-follow.ts:46 | Follow response duration (maxMs) | work-path deadline | replace with caller abort | Completion, supersession and disconnect govern follow; maxMs remains a compatibility option only. |
| srv/agent-config.ts:262 | Legacy follow duration option and handler maxMs wiring | work-path deadline | remove | No timer consumes this configuration now; parse compatibility retained. |
| srv/connections/CloudSdkAbapConnection.ts:272 | SAP session establishment HTTP request | work-path deadline | remove | HTTP client timeout set to 0 (disabled); SAP/connection lifecycle owns the work. |
| srv/connections/CloudSdkAbapConnection.ts:330 | SAP session establishment HTTP request | work-path deadline | remove | HTTP client timeout set to 0 (disabled); SAP/connection lifecycle owns the work. |
| srv/connections/CloudSdkAbapConnection.ts:507 | SAP session establishment HTTP request | work-path deadline | remove | HTTP client timeout set to 0 (disabled); SAP/connection lifecycle owns the work. |
| srv/connections/CloudSdkAbapConnection.ts:788 | SAP CSRF preparation HTTP request | work-path deadline | remove | Retire SAP_TIMEOUT_CSRF; timeout 0 disables Axios deadline. |
| srv/mcp-proxy.ts:367 | MCP proxy SAP authentication/probe HTTP request | work-path deadline | remove | Use HTTP timeout 0; no twelve-second probe deadline. |
| srv/lib/external-mcp.ts:65 | MCP client configuration affecting real tool calls | work-path deadline | remove | Remove hub ten-second override. Installed MCP wrapper still has its own required one-hour SDK safety net (dependency limitation). |
| srv/lib/external-mcp.ts:199 | Background external docs discovery refresh | safety net | raise+log | No caller waits on refresh (clients returns cached clients and refresh launches void connection); ten minutes replaces ten seconds. failed() warns; late clients disconnect. |
| srv/agent-manager.ts:2313 | Unreachable destination retry polling | periodic | keep | Destination polling explicitly excluded from changes. |
| srv/lib/destination-watch.ts:13 | Destination watch polling | periodic | keep | Schedules another pass; never cuts an in-flight operation. |
| srv/session-store.ts:65 | Session history expiry sweep | periodic | keep | Schedules another pass; never cuts an in-flight operation. |
| srv/lib/session-lifecycle.ts:476 | Long-session and run expiry sweep | periodic | keep | Schedules another pass; never cuts an in-flight operation. |
| srv/lib/collection-persistence.ts:1023 | Collection restore retry scheduler; maxMs caps backoff interval, not work | periodic | keep | Schedules another pass; never cuts an in-flight operation. |
| srv/anthropic-handler.ts:728 | Streaming SSE keep-alive | liveness | keep | Explicitly excluded; keeps transport alive without bounding work. |
| srv/openai-handler.ts:1161 | Streaming SSE keep-alive | liveness | keep | Explicitly excluded; keeps transport alive without bounding work. |
| srv/lib/chat-stream.ts:74 | SSE heartbeat | liveness | keep | Explicitly excluded; heartbeat only. |
| srv/lib/dialogue-events-handler.ts:111 | Dialogue SSE heartbeat | liveness | keep | Explicitly excluded; heartbeat only. |
| srv/connections/CloudSdkAbapConnection.ts:774 | CSRF retry pacing | periodic | keep | Delay schedules another attempt/item; never rejects or cancels work on elapsed time. |
| srv/rag-collections.ts:337 | Transient write retry backoff | periodic | keep | Delay schedules another attempt/item; never rejects or cancels work on elapsed time. |
| srv/rag-collections.ts:2117 | Bulk ingest load shaping | periodic | keep | Delay schedules another attempt/item; never rejects or cancels work on elapsed time. |
| srv/agent-config.ts:719 | Adaptive plan duration configuration | work-path deadline | keep | Currently parsed only: no production consumer of planBudget/maxDurationMs in srv; does not bound an active run. |
| srv/server.ts:966 | Hourly expired session collection sweep | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/server.ts:976 | Five-minute empty session forget sweep | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/runtime.ts:91 | Usage flush/process/retention and backend recovery intervals | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-scheduler.ts:41 | Measurement lock acquisition budget | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-scheduler.ts:41 | Storage measurement and inventory budgets | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-scheduler.ts:41 | Storage aggregate measurement budget | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-aggregates.ts:112 | Scheduled aggregate query measurement budget | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-aggregates.ts:136 | Scheduled aggregate DB connect limits (HANA/PG) | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-aggregates.ts:192 | Scheduled aggregate database statement limit | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-aggregates.ts:205 | Aggregate cancellation cleanup connection limit | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/storage-aggregates.ts:213 | Aggregate cancellation cleanup budget | periodic | keep | Usage storage scheduler/measurement behavior explicitly excluded from code changes. |
| srv/lib/usage/runtime.ts:137 | Usage PostgreSQL pool connection limit | safety net | keep | Real driver/pool limit allowed by policy. |
| srv/lib/usage/runtime.ts:233 | Usage startup/background HANA health probe | safety net | raise+log | No caller signal; ten-minute default replaces ten seconds and warns when fired. Existing outstanding probe is reused; driver pool limits unchanged. |
| srv/lib/usage/shutdown.ts:13 | Usage shutdown shared budget; server usageDeadline, session-records close and runtime close | safety net | raise+log | No caller abort during process shutdown; generous ten-minute default replaces five seconds, logs on expiry. Explicit externally supplied shutdown budgets remain honored. |

## Dependency limitations

The installed MCP wrapper requires a positive SDK timeout and defaults tool calls
to one hour. Removing the hub override avoids the ten-second limit but does not
remove that dependency-owned ceiling. Library planner retrieval also applies its
own default three-second retrieval budget; this audit removes the hub's author
retrieval timer but does not patch node_modules. Those dependency policies require
an upstream change to support truly unbounded work with caller cancellation.

ProfileResolver likewise requires a positive timeout: the requested ten-minute
compatibility safety net is used, with the explicit env override preserved.
Background docs refresh is fire-and-forget; profiles and workers use only cached
catalogues/clients. It cannot impose a request-waited discovery deadline.

## Changed files

- `docs/architecture/ARCHITECTURE.md`
- `docs/llm-agent/CONFIG_USAGE.md`
- `docs/superpowers/specs/2026-10-30-agent-profiles-design.md`
- `docs/superpowers/verification/2026-11-02-timeout-audit.md`
- `srv/agent-config.ts`
- `srv/agent-manager.ts`
- `srv/connections/CloudSdkAbapConnection.ts`
- `srv/lib/agent-profile-source.ts`
- `srv/lib/dialogue-follow.ts`
- `srv/lib/dialogue-sessions.ts`
- `srv/lib/executor-step.ts`
- `srv/lib/external-mcp.ts`
- `srv/lib/llm-only-guard.ts`
- `srv/lib/long-session.ts`
- `srv/lib/notice-finalizer.ts`
- `srv/lib/planner-memory.ts`
- `srv/lib/reviewer-subagent.ts`
- `srv/lib/step-gate.ts`
- `srv/lib/step-reviewer.ts`
- `srv/lib/tool-query-analyzer.ts`
- `srv/lib/usage/runtime.ts`
- `srv/lib/usage/shutdown.ts`
- `srv/mcp-proxy.ts`
- `srv/rag-collections.ts`
- `test/unit/agent-profile-dialogue.test.ts`
- `test/unit/agent-profile-source.test.ts`
- `test/unit/dialogue-follow.test.ts`
- `test/unit/external-mcp.test.ts`
- `test/unit/llm-only-guard.test.ts`
- `test/unit/rag-collections-persistent.test.ts`
- `test/unit/step-reviewer.test.ts`
- `test/unit/tool-query-analyzer.test.ts`
- `test/unit/usage-session-request.test.ts`

## Verification

- `npx.cmd tsc --noEmit -p tsconfig.json`: passed.
- `npx.cmd tsc --noEmit -p tsconfig.test.json`: passed.
- `npx.cmd biome check <all 29 touched TypeScript files>`: passed, no fixes or warnings.
- All nine touched Jest files plus `usage-runtime.test.ts`, with `--maxWorkers=1 --runTestsByPath`: 10 suites / 293 tests passed.
- Slow planner preparation regression: fake-clock preparation takes four seconds;
  the turn remains pending after 3001 ms and then completes successfully.
- `git diff --check`: passed. No commits created.

Usage storage measurement schedulers, destination polling and SSE keep-alives were
not modified. Usage health-probe and shutdown safety nets were raised and logged;
those are distinct from storage measurement scheduling.


## Follow-up: failing-suite triage

The reported 21 failures were obsolete deadline expectations and their cascading
cleanup failures. No production regression remained after repairing the deadline
tests; production code was not changed in this follow-up. Existing typing was
preserved without adding casts, `any`, or suppressions.

| Failure / cases | Decision and evidence |
| --- | --- |
| Worker, checker, process and stream stalled construction (four cases) | (a) Replace the 25 ms rejection expectation with a pending assertion after 100 ms, then caller abort and rejection. A stalled build must remain cancellable without a work deadline. |
| Probe HTTP options | (a) Assert timeout 0, preserving the single-request, caller authentication and SAP client assertions. The removed 12-second HTTP deadline is forbidden. |
| Open while previous session closes | (a) Assert admission remains pending at the former 15-second cutoff, then succeeds after cleanup completes. This also settles cleanup instead of leaking a permanently closing entry into later tests. |
| Retained worker results with session-events attached (both cases) | (a) Replace follow timeout with explicit disconnect. Assert a follow stays pending beyond maxMs, caller disconnect ends it, a later follower receives the retained result, acknowledgement consumes it once, and replay does not resend it. Disconnect result/replay followers explicitly while work remains active. |
| Legacy running / queued task interruption and persistence | (b) Preserve assertions. Both pass after the hung follow cleanup is removed; no code repair needed. |
| Preserve unfinished current-contract work; pass queued / running current-contract tasks unchanged to library restore | (b) Preserve assertions. All pass after cleanup repair; no code repair needed. |
| Stateless profile author / environment notes; current-request planning knowledge and memory | (b) Preserve assertions. Both pass after cleanup repair. |
| Headless MCP open and interrupted-task restore | (b) Preserve assertions. Passes after cleanup repair. |
| MCP deferred outcomes release inactivity hold | (b) Preserve assertions. Passes after cleanup repair. |
| Synchronous session leases, connection/exposition binding and three-step cap | (b) Preserve assertions. Passes after cleanup repair. |
| Concurrent revival sees restored history; discard during history scan | (b) Preserve assertions. Both pass once the preceding obsolete admission-deadline test completes and leaves cleanup settled. |
| agent-mcp-rag suite | Preserve behavior assertions; the entire requested suite passes without edits. |

Follow-up verification:

- Both `tsconfig.json` and `tsconfig.test.json` no-emit TypeScript checks passed.
- `npx biome check srv test`: exit 0; 433 files, 20 warnings and 26 informational diagnostics. No errors.
- Five requested suites: 265 tests passed with `--maxWorkers=1`.
- All audit-touched suites plus agent-mcp-rag and usage-runtime: 15 suites / 558 tests passed with --maxWorkers=1. No commits made.
