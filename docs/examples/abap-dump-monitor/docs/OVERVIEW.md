# Architecture

## High-level flow

The service runs three independent loops that use `MonitoredDump` itself as the queue at three checkpoints. Each loop has its own tick interval and skips the next firing if the previous tick is still running.

```
                                     ┌────────────────────────────┐
                                     │ Setting / AssigneeRule     │
                                     │ (hot, read fresh per tick) │
                                     └────────────┬───────────────┘
                                                  │
       Discoverer (single)                        ▼                          AnalysisWorker (parallel)
       tick = POLL_INTERVAL_MS (5m)        ┌────────────┐               tick = ANALYSIS_TICK_MS (10s)
   ┌──────────────────────────────┐        │            │     ┌────────────────────────────────────────────┐
   │ RuntimeListFeeds(dumps)       │       │            │     │ findPendingAnalysis (analysisStatus IN     │
   │   via cloud-llm-hub MCP       │       │            │     │   pending|failed AND attempts < cap)       │
   │ diff vs MonitoredDump          │ ───►  │ Monitored- │ ──► │ Promise.all(slice up to                    │
   │ for each NEW:                  │       │   Dump     │     │   ANALYSIS_CONCURRENCY (5)) of:            │
   │   RuntimeGetDumpById           │       │  (HANA)    │     │   POST /v1/chat/completions                │
   │   parse → header + comp tree   │       │            │     │   UPDATE analysisStatus = done|failed      │
   │   INSERT (status=pending)      │       │            │     └────────────────────────────────────────────┘
   └──────────────────────────────┘        │            │
                                            │            │     JiraWorker (single, sequential per tick)
                                            │            │     tick = JIRA_TICK_MS (10s)
                                            │            │     mode = JIRA_MODE (manual default | auto)
                                            │            │     ┌────────────────────────────────────────────┐
                                            │            │     │ if JIRA_MODE = auto:                       │
                                            │            │     │   findPendingJira (analysisStatus = done   │
                                            │            │ ──► │     AND jiraStatus IN pending|failed AND   │
                                            │            │     │     skipJira = false AND attempts < cap)   │
                                            │            │     │   for each row, sequentially:              │
                                            └────────────┘     │     search → create | comment | skip       │
                                                               │ if JIRA_MODE = manual (default):           │
                                                               │   tick is dormant — operator clicks        │
                                                               │   Push to Jira in UI → pushToJira(ID)      │
                                                               └────────────────────────────────────────────┘
```

The Discoverer is the only writer of new rows. The AnalysisWorker may run several rows in parallel. The JiraWorker is intentionally single-threaded so two ticks never race the same `searchByLabel → create` window — an unintended duplicate ticket would slip through otherwise. This single-thread guarantee holds in-process; running >1 CF instance would break it (then a DB-level claim or leader election is needed).

## Modules

| File | Role |
|---|---|
| `srv/discoverer.ts` | discovery loop — pulls FIDS, inserts new MonitoredDump rows |
| `srv/analysis-worker.ts` | analysis loop — Promise.all of up to ANALYSIS_CONCURRENCY rows |
| `srv/jira-worker.ts` | Jira loop — sequential, single-threaded create/comment/skip |
| `srv/dump-source.ts` | cloud-llm-hub MCP client (list/get) with init handshake |
| `srv/dump-parser.ts` | raw payload → structured tree |
| `srv/analyzer.ts` | cloud-llm-hub /v1/chat/completions |
| `srv/jira-client.ts` | Jira REST (BasicAuth) |
| `srv/jira-policy.ts` | signature, due-date, assignee match |
| `srv/settings-service.ts` | hot-reloadable config (cached, 5s TTL) |
| `srv/bootstrap.ts` | env → Setting seed on first boot |
| `srv/monitor-service.ts` | OData admin + repository + 3-loop startup |

Each worker has one focused responsibility, takes injected interfaces (`ISettings`, `IDumpSource`/`IAnalyzer`/`IJiraClient`, `DumpRepository`), and is unit-tested in isolation against an in-memory repo and stubbed clients. CAP/HANA is not touched in tests.

## State machine

```
analysisStatus:  pending ─► analyzing ─► done    ─┐
                                      ─► failed  ─┤  (failed/analyzing rows
                                                  │   are not sticky — see
                                                  │   recovery rules below)
                                                  │
jiraStatus:      pending ─► created   ─┐
                 pending ─► commented  ─┤  (failed rows likewise auto-retry
                 pending ─► skipped    ─┤   until jiraAttempts >= cap)
                 pending ─► failed     ─┘
```

`analyzing` is an intermediate state written by the AnalysisWorker before
calling the LLM. It exists so the UI can show the row "in flight". Recovery
rules:

- `findPendingAnalysis` includes both `pending` and `failed`. `analyzing`
  rows older than `ANALYSIS_STUCK_MS` (default 10 min) are also re-picked,
  so a process crash mid-call cannot strand a row.
- The bound action `retryAnalysis` accepts `failed` and `analyzing` and
  drives the row through `AnalysisWorker.processOne` synchronously. The
  worker writes `analyzing` first, then `done` or `failed` (incrementing
  `analysisAttempts` only on failure). `retryAnalysis` returns 400 on
  `pending` or `done` (nothing to retry).

After the per-row attempt cap is reached, the auto-loop stops re-picking
the row, but `retryAnalysis` still works — each call is one more attempt.

When `JIRA_MODE = manual` (the default), `jiraStatus = pending` rows do **not** auto-progress — the JiraWorker tick is a no-op. The operator must invoke the `pushToJira(ID)` bound action (button in the Fiori Elements UI) to drive a single row through the same `searchByLabel → create | comment | skipped` pipeline. Switch `JIRA_MODE` to `auto` to restore the original behaviour.

## Recurrence / due-date logic

For each new dump where analysis succeeded:

1. Compute `signature` from `DUMP_SIGNATURE_FIELDS` (default: `system|runtimeError|program|include`).
2. Search Jira by label `<system>:<dumpId>` — if match found, mark `jiraStatus=skipped`.
3. Look up the most recent `MonitoredDump` with the same signature in the last `JIRA_HISTORY_DAYS`. If its issue is still open (`statusCategory != done`), comment on it instead of creating a new ticket.
4. Otherwise, count occurrences of this signature in the same window:
   - count `<` `JIRA_FREQ_THRESHOLD_LOW` → due `+JIRA_DUE_DAYS_FIRST`
   - `LOW <= count < HIGH` → due `+JIRA_DUE_DAYS_RECURRING`
   - `count >= HIGH` → due `+JIRA_DUE_DAYS_FREQUENT`
5. Match `AssigneeRule` rows; lowest priority wins. Empty assignee = leave unassigned.
