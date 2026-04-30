# abap-dump-monitor — Design

**Status:** draft
**Date:** 2026-04-29
**Location:** `docs/examples/abap-dump-monitor/`

## Purpose

A CAP example service that demonstrates a complete monitoring pipeline:

1. Periodically polls an ABAP system's runtime-error log (FIDS / ST22 dumps) via cloud-llm-hub MCP tooling.
2. Persists newly observed dumps to its own database with enough structured detail to reconstruct the failure context.
3. Asks cloud-llm-hub to analyze each new dump and stores the analysis.
4. For successful analyses with recommendations, files a Jira ticket (or comments on an existing one) via a BTP destination.
5. All operational policy — polling cadence, due-date thresholds, assignee routing, etc. — is **hot-reloadable** via OData without redeploy.

This sits alongside `calm-dump-analyzer` (event-pushed) and `test-management` (interactive) as the **scheduled-pull** example.

## Non-goals

- Replace SAP Cloud ALM. CALM is push-based; this is an example of pull-based polling using existing MCP tooling.
- Local `cds watch` execution. Heavy dependence on BTP destinations + AI Core makes hybrid local-dev unreliable in current CAP. Validation happens via deploy to a dev subaccount.

## High-level flow

```
abap-dump-monitor (CF app, CAP)
   │
   │ tick (POLL_INTERVAL_MS, hot)
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ 1. List dumps           → cloud-llm-hub MCP                      │
│    RuntimeListDumps     ─→ Destination CLOUD_LLM_HUB             │
│                              ─→ ABAP system (S4HANA_DEV)         │
│ 2. Diff vs MonitoredDump table → set of NEW dumpIds              │
│ 3. For each NEW dump:                                            │
│    a. RuntimeGetDumpById (MCP)  → raw payload                    │
│    b. parse → header + callStack[] + referencedObjects[]         │
│       + variables[] + sourceExtract  → INSERT MonitoredDump      │
│    c. POST /v1/chat/completions (cloud-llm-hub) with prompt      │
│       built from raw payload  → analysisResult, recommendations  │
│       → UPDATE MonitoredDump (analysisStatus=done)               │
│    d. Jira step (see "Jira logic" below)                         │
└──────────────────────────────────────────────────────────────────┘
                                     ▲
                       Setting / AssigneeRule (read fresh)
```

## Components

```
docs/examples/abap-dump-monitor/
├── README.md                          — overview + deploy steps
├── package.json
├── mta.yaml
├── .mtaext.example                    — copy → .mtaext, fill destinations + initial settings
├── xs-security.json                   — roles: Admin, Viewer
├── db/
│   └── schema.cds                     — entities (see "Data model")
├── srv/
│   ├── monitor-service.cds            — OData admin service
│   ├── monitor-service.ts             — handlers + manual /poll-now action
│   ├── poller.ts                      — setTimeout-recursive loop
│   ├── dump-source.ts                 — cloud-llm-hub MCP client (list/get)
│   ├── dump-parser.ts                 — raw payload → structured composition
│   ├── analyzer.ts                    — cloud-llm-hub /v1/chat/completions client
│   ├── jira-client.ts                 — BasicAuth REST client (search/create/comment)
│   ├── jira-policy.ts                 — signature, history count, due-date, assignee match
│   ├── settings-service.ts            — cached, hot-reloading config accessor
│   └── bootstrap.ts                   — env → Setting seed on first start
└── docs/
    ├── OVERVIEW.md
    ├── DEPLOYMENT.md
    └── CONSUMER-GUIDE.md
```

Each `srv/*.ts` has a single purpose, one focused interface, and is unit-testable in isolation. The poller depends on injected interfaces (`IDumpSource`, `IAnalyzer`, `IJiraClient`, `ISettings`) so tests can stub them.

## Data model

### `MonitoredDump` (composition root)

Header fields:

| Field | Type | Notes |
|---|---|---|
| `ID` | UUID | PK |
| `system` | String(20) | e.g. `DEV.100` |
| `client` | String(3) | mandt |
| `dumpId` | String(40) | ABAP dump id (unique with `system`) |
| `runtimeError` | String(60) | `OBJECTS_OBJREF_NOT_ASSIGNED` etc. |
| `exceptionClass` | String(60) | `CX_SY_REF_IS_INITIAL` etc. |
| `category` | String(40) | from listing |
| `host` / `instance` | String(40) | server/instance |
| `program` | String(40) | top program |
| `include` | String(40) | include where it failed |
| `mainProgram` | String(40) | main program (assoc) |
| `sourceLine` | Integer | line number |
| `event` | String(40) | `FORM`/`METHOD`/`MODULE`/`EVENT` |
| `transactionId` | String(40) | TID |
| `abapUser` | String(12) | user from dump |
| `occurredAt` | Timestamp | dump time |
| `firstSeenAt` | Timestamp | when this service first observed it |
| `shortText` | String(1000) | header short text |
| `signature` | String(200) | computed: `<system>|<runtimeError>|<program>|<include>` (configurable via `DUMP_SIGNATURE_FIELDS`) — indexed |
| `rawPayload` | LargeString | full payload from `RuntimeGetDumpById` (source of truth) |
| `analysisStatus` | String(20) | `pending` / `analyzing` / `done` / `failed` |
| `analysisResult` | LargeString | full JSON response from cloud-llm-hub |
| `recommendations` | LargeString | extracted text section used for Jira |
| `analysisError` | String(2000) | last error |
| `analysisAttempts` | Integer | retry counter |
| `jiraStatus` | String(20) | `pending` / `created` / `commented` / `failed` / `skipped` |
| `jiraIssueKey` | String(40) | e.g. `EPMCSAPDDF-1234` |
| `jiraError` | String(2000) | last error |
| `jiraAttempts` | Integer | retry counter |
| `skipJira` | Boolean | manual override (poll loop honors but does not wait for it) |
| `managed` | aspect | `createdAt`/`createdBy`/`modifiedAt`/`modifiedBy` |

Unique constraint: `(system, dumpId)`.
Indexes: `signature`, `analysisStatus`, `jiraStatus`, `firstSeenAt`.

### Compositions

- `callStack: Composition of many CallStackEntry`
  - `position` (Int), `program`, `include`, `line`, `eventType`, `eventName`, `objectClass` (ADT type code)
- `referencedObjects: Composition of many ReferencedObject`
  - `objectName`, `objectType` (ADT type — `CLAS/OC`, `PROG/P`, `FUGR/FF`, `INTF/OI`, `DTEL/DE`…), `subObject`, `package`, `source` (`stack`/`source-extract`/`message`)
  - Deduplicated within a single dump.
- `variables: Composition of many VariableSnapshot`
  - `scope` (`local`/`global`/`sy`), `name`, `type`, `value` (LargeString), `truncated` (Bool)
- `sourceExtract: Composition of one SourceExtract`
  - `program`, `include`, `lineFrom`, `lineTo`, `code` (LargeString)

### `Setting` (hot-reloadable config)

| Field | Type |
|---|---|
| `key` | String(60), PK |
| `value` | String(2000) |
| `dataType` | String(10) — `int` / `string` / `bool` / `csv` |
| `description` | String(500) |
| `updatedAt` | Timestamp (managed) |
| `updatedBy` | String (managed) |

### `AssigneeRule` (Jira routing matrix)

| Field | Type |
|---|---|
| `ID` | UUID |
| `priority` | Integer (lower wins among matches) |
| `system` | String (optional exact match) |
| `runtimeErrorPattern` | String (LIKE-style; `*` wildcard) |
| `programPattern` | String |
| `categoryPattern` | String |
| `assigneeName` | String (Jira `name`); empty = leave unassigned |
| `active` | Boolean |
| `description` | String |

Match algorithm: filter active rules, keep those whose every non-empty pattern matches the dump, return the rule with smallest `priority`. No match → no `assignee` field in the Jira request.

## Configuration

`Setting` keys (seeded from env on first boot, DB wins thereafter):

| Key | Default (env) | Type | Notes |
|---|---|---|---|
| `POLL_INTERVAL_MS` | `300000` | int | min 60_000 enforced |
| `POLL_CONCURRENCY_MODE` | `skip` | string | `skip` / `parallel` / `queue` |
| `LLM_MODEL` | `anthropic--claude-4.5-sonnet` | string | passed to cloud-llm-hub |
| `LLM_TEMPERATURE` | `0.2` | string (parsed float) | |
| `DUMP_SIGNATURE_FIELDS` | `system,runtimeError,program,include` | csv | recompute on insert; existing rows untouched until next observation |
| `JIRA_HISTORY_DAYS` | `30` | int | window for recurrence count |
| `JIRA_PROJECT_KEY` | `EPMCSAPDDF` | string | |
| `JIRA_ISSUE_TYPE` | `Story` | string | |
| `JIRA_DEFAULT_ASSIGNEE` | (empty) | string | only used if no `AssigneeRule` matches |
| `JIRA_LABELS` | `cloud-llm-hub,abap-dump` | csv | dump-specific label `<system>:<dumpId>` is always appended |
| `JIRA_DUE_DAYS_FIRST` | `14` | int | |
| `JIRA_DUE_DAYS_RECURRING` | `7` | int | |
| `JIRA_DUE_DAYS_FREQUENT` | `2` | int | |
| `JIRA_FREQ_THRESHOLD_LOW` | `2` | int | `count >= LOW && count < HIGH` → RECURRING |
| `JIRA_FREQ_THRESHOLD_HIGH` | `5` | int | `count >= HIGH` → FREQUENT |
| `JIRA_MAX_ATTEMPTS` | `3` | int | |
| `ANALYSIS_MAX_ATTEMPTS` | `3` | int | |

**Deploy-time constants (env only, not in `Setting`):**
- `SAP_DESTINATION` (e.g. `S4HANA_DEV`) — passed to cloud-llm-hub via header.
- `SAP_CLIENT` (e.g. `100`).
- `CLOUD_LLM_HUB_DESTINATION` (e.g. `CLOUD_LLM_HUB`).
- `JIRA_DESTINATION` (e.g. `JIRA`).

**Secrets:** Jira API token lives in the `JIRA` destination credentials (BasicAuthentication: `User=<email>`, `Password=<API token>`). Updated through BTP cockpit, no redeploy. Cloud SDK refreshes on next call.

## SettingsService

- In-memory cache, TTL 5s.
- `get(key)` → string; typed wrappers `getInt`, `getBool`, `getCsv` (parse via `dataType`).
- CAP `AFTER UPDATE on Setting` handler invalidates the cache entry immediately (so admin updates apply within a tick, not waiting for TTL).
- Rejects unknown keys at startup (whitelist of recognized keys to prevent typos in `Setting` table).

## Polling loop

```ts
async function tick() {
  const running = ...;
  const mode = settings.get('POLL_CONCURRENCY_MODE');
  if (running) {
    if (mode === 'skip')   { schedule(); return; }
    if (mode === 'queue')  { await running; }
    // 'parallel' falls through
  }
  try {
    await pollOnce();
  } catch (e) { log.error(e); }
  finally { schedule(); }
}

function schedule() {
  const ms = Math.max(60_000, settings.getInt('POLL_INTERVAL_MS'));
  setTimeout(tick, ms);
}
```

`pollOnce` steps:

1. `RuntimeListDumps` via cloud-llm-hub MCP. Time-window: from `max(MonitoredDump.occurredAt)` per system, with a 24h overlap to recover from clock skew / missed runs; else last 24h.
2. For each entry not present in `MonitoredDump (system, dumpId)`:
   - `RuntimeGetDumpById` → parse → INSERT (with `analysisStatus=pending`, `jiraStatus=pending`).
3. For each `MonitoredDump` where `analysisStatus IN (pending, failed) AND analysisAttempts < ANALYSIS_MAX_ATTEMPTS`:
   - call `analyzer.analyze(dump)` → UPDATE.
4. For each `MonitoredDump` where `analysisStatus=done AND jiraStatus IN (pending, failed) AND !skipJira AND jiraAttempts < JIRA_MAX_ATTEMPTS`:
   - call `jira-policy + jira-client` (see below) → UPDATE.

Each step independently transactional per row — a failure in one row does not block others.

## Analyzer

Builds a prompt with: header summary + short text + top-N callStack frames + sourceExtract + (optionally) RAG instructions. Sends to cloud-llm-hub `POST /v1/chat/completions` (BTP destination `CLOUD_LLM_HUB`) with headers:
- `Authorization` — Bearer token from destination
- `sap-system: <SAP_DESTINATION>` (so cloud-llm-hub MCP knows which ABAP to use for follow-up tool calls inside the SmartAgent pipeline)
- `sap-client: <SAP_CLIENT>`

Response is stored verbatim in `analysisResult`; `recommendations` is extracted (LLM is asked to produce a `## Recommendations` section so we can split deterministically; if missing, take whole content).

## Jira logic

For a `MonitoredDump` with `analysisStatus=done`:

1. **Compute signature** using configured `DUMP_SIGNATURE_FIELDS`.
2. **Recurrence check:** find the most recent `MonitoredDump` with the same signature, within `JIRA_HISTORY_DAYS`, whose `jiraIssueKey` is set.
   - If found → `GET /rest/api/2/issue/{key}`:
     - `statusCategory.key != "done"` → `POST /rest/api/2/issue/{key}/comment` with new occurrence info; this row gets `jiraStatus=commented`, `jiraIssueKey=<same>`. **Stop.**
     - `statusCategory.key == "done"` → fall through to creation.
3. **Frequency:** count `MonitoredDump` rows with same signature in last `JIRA_HISTORY_DAYS` (including current).
   - `1` → due `+JIRA_DUE_DAYS_FIRST`
   - `LOW..(HIGH-1)` → `+JIRA_DUE_DAYS_RECURRING`
   - `>=HIGH` → `+JIRA_DUE_DAYS_FREQUENT`
4. **Assignee:** `AssigneeRule` match → its `assigneeName`; else `JIRA_DEFAULT_ASSIGNEE` (may be empty).
5. **POST `/rest/api/2/issue`** with body:
   ```json
   {
     "fields": {
       "project": {"key": "<JIRA_PROJECT_KEY>"},
       "summary": "[<system>] <runtimeError> in <program>@<include>:<line>",
       "description": "<rendered template: short text, our row ID, time, user, top-5 stack, recommendations>",
       "issuetype": {"name": "<JIRA_ISSUE_TYPE>"},
       "duedate": "<YYYY-MM-DD>",
       "labels": [...JIRA_LABELS, "<system>:<dumpId>"],
       "assignee": {"name": "<resolved>"}   // omitted entirely if empty
     }
   }
   ```
6. On success → `jiraStatus=created`, `jiraIssueKey=<returned key>`.
7. On failure → `jiraStatus=failed`, `jiraError=<msg>`, `jiraAttempts++`. Retried on next tick until cap.

## OData service

Exposed under `/odata/v4/admin/` (role `Admin` for write, `Viewer` for read):

- `MonitoredDump` — read-only listing with all compositions navigable; expand support for inspecting parsed structures.
- `Setting` — full CRUD (Admin).
- `AssigneeRule` — full CRUD (Admin).
- Unbound action `pollNow()` — manual trigger; runs one `pollOnce()` regardless of schedule (still respects `POLL_CONCURRENCY_MODE` against the scheduled loop).

## Error handling and retries

- Each row's `analysisAttempts` / `jiraAttempts` cap retries. After cap → operator must reset by clearing the counter via `Setting`-style admin action (not in scope of v1 — v1 just stops trying and `failed` stays sticky).
- Network/destination failures logged; no crash propagation to the loop.
- Idempotency:
  - `MonitoredDump` insert protected by unique `(system, dumpId)`.
  - Jira create protected by `labels` lookup `<system>:<dumpId>`: before POSTing, search `GET /rest/api/2/search?jql=labels="<system>:<dumpId>"`. If found — record key, mark `skipped`.
- Concurrency: `parallel` mode is permitted but unique constraints + Jira label lookup prevent dupes; `skip` is the recommended default.

## Testing

- **Unit (Jest):** `dump-parser` (golden payload fixtures), `jira-policy` (signature, due-date math, rule match), `settings-service` (cache TTL + invalidation).
- **Integration:** deploy to dev subaccount, trigger `pollNow()` against a system known to have dumps, verify Jira issue created in a sandbox project.
- Local `cds watch` not pursued.

## Security

- Roles: `Admin` (Setting/Rule write, `pollNow`), `Viewer` (read MonitoredDump).
- Destinations carry credentials; app does not see Jira API token directly.
- All outbound calls via Cloud SDK destination resolution (no hard-coded URLs except the documented Jira REST path suffix).

## Open items (resolved during brainstorming, captured for traceability)

- Polling source: cloud-llm-hub MCP `RuntimeListDumps` / `RuntimeGetDumpById` (not direct ADT).
- Period change is hot via `Setting`, not env / restart.
- Local dev is not a goal; deploy to dev subaccount.
- Default assignee empty; routing via `AssigneeRule`.
- Recurring dump → comment on existing open issue, do not create dupes.
- `skipJira` flag exists but loop doesn't pause for human input.
