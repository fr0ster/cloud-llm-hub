# Consumer Guide

All Admin endpoints require an XSUAA token from a user holding the `AbapDumpMonitorAdmin` role collection.

## UI

A Fiori Elements V4 List Report is served at `/monitor/webapp/`. It lists `MonitoredDump` rows with filters, a List Report → Object Page navigation, all composition tabs (Call Stack, Source, Variables, References), and two row-level actions: **Analysis** (re-runs LLM analysis synchronously) and **Jira** (pushes the row to Jira).

> **Auth boundary:** the UI **shell** (HTML/JS/manifest) is served as static assets without auth — same pattern cloud-llm-hub itself uses for `/chat/webapp`. The actual data and actions all flow through OData at `/odata/v4/admin/...`, which is auth-gated by the `MonitorService.@requires: 'Viewer'` (read) / `Admin` (actions). An unauthenticated browser sees the empty app shell; the moment it tries to fetch dumps it gets 401 with the standard XSUAA / mocked-auth challenge. For a fully gated experience put an approuter in front (see how `cloud-llm-hub`'s root MTA wires `app/router/`).

## Jira mode

`Setting('JIRA_MODE')` controls whether the JiraWorker auto-creates tickets:

- `manual` (default) — JiraWorker tick is dormant. Operator clicks **Push to Jira** in the UI (or POSTs `pushToJira(ID)`) to send one row to Jira.
- `auto` — JiraWorker processes every `findPendingJira` row each tick (the original example behaviour).

Switch any time:

```bash
curl -X PATCH "https://<app>/odata/v4/admin/Setting('JIRA_MODE')" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"auto"}'
```

## Push one row to Jira manually

```bash
curl -X POST "https://<app>/odata/v4/admin/MonitoredDump(ID=<ID>)/MonitorService.pushToJira" \
  -H "Authorization: Bearer $TOKEN"
```

Returns 400 if the row is not pushable (`analysisStatus != done`, `skipJira = true`, or `jiraStatus NOT IN ('pending','failed')` — the Jira button is gated to those two statuses; see `docs/DEDUPLICATION.md` "Manual control" for why).

## Change polling interval (hot)

```bash
TOKEN=...
curl -X PATCH "https://<app>/odata/v4/admin/Setting('POLL_INTERVAL_MS')" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"60000"}'
```

Within 5 seconds (cache TTL) the next tick uses the new value.

## Trigger a poll on demand

```bash
curl -X POST "https://<app>/odata/v4/admin/pollNow" -H "Authorization: Bearer $TOKEN"
```

## Run analysis or push to Jira

The two bound actions on `MonitoredDump` have **deliberately asymmetric availability**. See `docs/DEDUPLICATION.md` "Manual control" for the full rationale.

### `retryAnalysis` — Analysis button, manual-override on every status

Runs the LLM analysis inline (synchronous, ~15-40 s through the approuter) and returns the refreshed row. **Always available** regardless of current `analysisStatus`:

| Current status | What it does                                                           |
|----------------|------------------------------------------------------------------------|
| `pending`      | Skip the auto-loop queue and analyse this row NOW.                     |
| `analyzing`    | Recovery if a previous worker call died mid-LLM-request.               |
| `failed`       | Retry — counts one more attempt against `ANALYSIS_MAX_ATTEMPTS`.       |
| `done`         | Re-analyse — useful after a prompt or model change.                    |

```bash
curl -X POST "https://<app>/odata/v4/admin/MonitoredDump(ID=<ID>)/MonitorService.retryAnalysis" \
  -H "Authorization: Bearer $TOKEN"
```

### `pushToJira` — Jira button, gated to `pending|failed`

Drives a single row through the dedup pipeline (see `DEDUPLICATION.md`). Returns 400 on terminal-status rows because clicking on `created`/`commented`/`unheard`/`skipped` would either bail or duplicate a Jira write — the action is gated by design (UI annotation + server precondition).

```bash
curl -X POST "https://<app>/odata/v4/admin/MonitoredDump(ID=<ID>)/MonitorService.pushToJira" \
  -H "Authorization: Bearer $TOKEN"
```

## Add a routing rule (assignee matrix)

```bash
curl -X POST "https://<app>/odata/v4/admin/AssigneeRule" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"priority":10,"programPattern":"Z*","assigneeName":"someone@epam.com","active":true}'
```

Lower `priority` wins among matching rules. Empty `assigneeName` leaves the ticket unassigned.

## Recognized Setting keys

### Loop intervals

| Key | Default | Type | Notes |
|---|---|---|---|
| `POLL_INTERVAL_MS` | `300000` | int | Discoverer tick. Min 60_000 enforced. |
| `ANALYSIS_TICK_MS` | `10000` | int | AnalysisWorker tick. Min 1_000 enforced. |
| `JIRA_TICK_MS` | `10000` | int | JiraWorker tick. Min 1_000 enforced. |
| `ANALYSIS_CONCURRENCY` | `5` | int | Max parallel analyses per AnalysisWorker tick. |

If a tick value cannot be parsed as int, the worker logs a warning and falls back to the default for that tick — the loop never dies.

### LLM and analysis

| Key | Default | Type | Notes |
|---|---|---|---|
| `LLM_MODEL` | `anthropic--claude-4.5-sonnet` | string | passed to cloud-llm-hub `/v1/chat/completions` |
| `LLM_TEMPERATURE` | `0.2` | string (parsed float) | |
| `ANALYSIS_MAX_ATTEMPTS` | `3` | int | retry cap for the analysis step |

### Dedup and Jira

| Key | Default | Type | Notes |
|---|---|---|---|
| `DUMP_SIGNATURE_FIELDS` | `system,runtimeError,program,include` | csv | recompute on insert |
| `JIRA_HISTORY_DAYS` | `30` | int | window for recurrence detection |
| `JIRA_PROJECT_KEY` | `EPMCSAPDDF` | string | |
| `JIRA_ISSUE_TYPE` | `Story` | string | |
| `JIRA_DEFAULT_ASSIGNEE` | (empty) | string | used only if no `AssigneeRule` matches |
| `JIRA_LABELS` | `cloud-llm-hub,abap-dump` | csv | the dump-specific label `<system>:<dumpId>` is always appended |
| `JIRA_DUE_DAYS_FIRST` | `14` | int | due offset on first occurrence |
| `JIRA_DUE_DAYS_RECURRING` | `7` | int | due offset for `LOW <= count < HIGH` |
| `JIRA_DUE_DAYS_FREQUENT` | `2` | int | due offset for `count >= HIGH` |
| `JIRA_FREQ_THRESHOLD_LOW` | `2` | int | `count >= LOW && < HIGH` → RECURRING |
| `JIRA_FREQ_THRESHOLD_HIGH` | `5` | int | `count >= HIGH` → FREQUENT |
| `JIRA_MAX_ATTEMPTS` | `3` | int | retry cap for the Jira step |
| `JIRA_MODE` | `manual` | string | `manual` = wait for UI Push to Jira; `auto` = JiraWorker creates tickets automatically. |

## Sensitive-data note

`MonitoredDump.rawPayload`, `variables`, `sourceExtract`, and `analysisResult` may contain business data, user IDs, variable values, stack details, and generated remediation text. The `Viewer` role grants read access to all of these. Decide retention/redaction policy before using this outside a dev subaccount.
