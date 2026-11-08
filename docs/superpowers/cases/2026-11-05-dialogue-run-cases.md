# Dialogue run cases — 2026-11-05 (POC, hub 10.5.2–10.5.5)

## Sources

All data comes from POC context capture (`full`) and the WebUI logs. Counts are
tool calls whose result was an error, grouped by component, tool and message.
Normalised cost is not computed here; tokens are given per model.

| Session | Task | Hub | Opus in / out | Sonnet in / out | Outcome |
|---|---|---|---|---|---|
| 935df710 | Doc process Phase 3 (Q1–Q4 evidence) | 10.5.3 | 423k / 9k | 933k / 11k | artifacts persisted only after 16 failed `rag_persist` calls |
| 0f2bf074 | Same Phase 3, rerun | 10.5.4 | 769k / 16k | 1 145k / 16k | reported "saved"; **never persisted** (session copy shadowed the user collection); stuck closing the plan |
| d69658cf | Transport ALV: Phase 1 business requirements, Phase 2 tech spec | 10.5.5 | 1 211k / 31k | 3 786k / 103k | tech spec written (66k chars) and persisted; **could not finish**: the check step lost its kind, delivery was refused, loop |
| 742722781874 (R4) | Parallel security review | 10.5.0 | 442k / 13k | 1 977k / 57k | a real finding was removed after checkers wrongly called it a phantom |

## Case classes

### P1. Coordinator and plan state machine (largest)

The coordinator treats its own actions (persist, deliver, close) as plan
steps. It then edits the plan with `plan_update`, whose `steps` replaces the
whole list. Each attempt hits a different library rule.

| Symptom (library message) | 0f2b | d696 | 935d | Evidence |
|---|---|---|---|---|
| `Done requires a successful current task result` | 8 | 6 (+1 `plan_revise`) | – | the coordinator marks coordinator-only steps `done` |
| `Skipping or narrowing requires user consent…` | 2 | 7 | 2 | skipping its own leftover steps |
| `Changing worker role or dependencies requires reopening the step as pending` | 4 | 1 | – | a resent step without `dependsOn` |
| `invalid dependency` | 3 | 1 | – | `steps` sent as a partial list |
| `plan must be a string` (status-only update) | 3 | 1 | – | **fixed in llm-agent `9ff156cc`** (not released) |
| `Removing plan steps requires user consent…` | 2 | – | – | the legacy `plan` text branch |
| `Cannot reopen or change items … task attempt is running` | – | 1 | 1 | editing a running step |
| zod `invalid_value` for step `state` | 1 | 3 | – | an invalid state value in `plan_update` |
| `Step check-tech-spec requires result kind report; profile checker produces verdict` | – | 1 | – | a step resent **without `result`** loses `verdict` and defaults to `report`; the check can no longer be delegated |

Coordinator-invented non-work steps seen:
- `deliver-result` ("Deliver phase 3 summary to user"), 0f2b;
- `persist-brd` ("Coordinator: persist the business-requirements record…"), d696.

### P2. Delivery gating

| Symptom | 0f2b | d696 | 935d |
|---|---|---|---|
| `deliver`: `step … is not done (check may be pending)` | 7 | 7 | – |
| `deliver` note longer than 1000 characters (zod `too_big`) | 2 | 3 | 1 |
| The same task delivered repeatedly, duplicating output | 3× t10 | – | – |

The duplicate delivery is **fixed in llm-agent `9ff156cc`**, not yet released.

### P3. Storage scope (session vs user)

| Symptom | Evidence |
|---|---|
| A worker tries a user collection first | `collection_create scope:user` ×3 (0f2b); `record_add mte-u4` ×1 (935d), ×1 (d696) |
| A session collection with the user collection's name shadows it | 0f2b: `mte-u4` in both scopes; the coordinator and the checker read the session copy and `rag_persist` was never called |
| `rag_persist` argument confusion | 935d: 15× `COLLECTION_NOT_FOUND`, 2× `Session must match` |
| A result reference read as a collection name | d696: `rag_read {collection:"task-results/t6"}` ×2 → `Collection not found` |
| A source document read by file name instead of chunk id | d696: checker `rag_read mte-transport-alv-1105/development-process` ×2 → `Document not found`; records are `development-process-md-…-chunk-NNN` |

The role-split tools spec addresses most of P3; implementation is in progress.

### P4. Evidence and verification

R4 (742722781874):
- The analyst read include `_200` live, but that evidence existed only in its context.
- The checkers redid the search, called `_200` a phantom three times, and every verdict was `quote_absent`.
- The coordinator acted on this and removed a real finding.

The sources-and-findings spec is drafted in llm-agent `docs/sources-findings-spec`.

### P5. Worker exploration and budgets

- **Budget exhaustion (d696, Phase 2 tech spec).** The executor made 54 `SearchObject`, 29 `GetTable`, 19 `GetTypeInfo`, 19 `GetFunctionModule` and 13 `GetSqlQuery` calls. The per-request tool-call budget of 30 ran out 5 times, and one exhaustion blocked a `record_add` of the work done.
- **Docs MCP limited to the analyst.** The executor called `search` (docs MCP) and got `External docs tool forbidden`, because docs MCP is enabled only for the analyst.
- **Model alias rejected.** `delegate_task {model:"opus"}` → `MODEL_NOT_ALLOWED` ×2. The alias is not in the allowlist.

### P6. SAP tool errors (mostly guessed objects)

| Tool | Count | Example |
|---|---|---|
| `GetSqlQuery` 400 | 7 (d696) | `SELECT … FROM tactz …`, `USOBHASH` |
| `GetTable` 404 | 6 (d696) | `TSTRFCOFIL` (guessed name) |
| `GetFunctionModule` 500 | 4 (d696) | name `"SCTS\|TR_READ_REQUEST_WITH_TASKS"` (malformed) |
| `GetDomain` 404 | 1 (d696) | `TRSTLEVEL` |
| `GetProgram` 404 | 2 (0f2b), 1 (935d) | |
| `SearchSource` hung for more than 5 minutes | 2 (386f) | the diagnostic run |

### Fixed today (for reference)

- **Parallel batch refused after its first call** (composite discovery race): 10.5.2.
- **Coordinator event turns ran with worker permissions**: stall turns lost `delegate_task` and `stop_task`. Fixed in 10.5.3.
- **Coordinator briefed workers to write user collections**: `rag_persist` descriptions fixed in 10.5.4.
- **Deploy did not update built-in profiles**: 10.5.5.

## Observations for design

1. P1 and P2 share one cause. Coordinator actions (persist, deliver, close)
   have no place in the plan model, and `plan_update` as full replacement is
   error-prone for an LLM.
2. P3 is an addressing problem. Scope lives only in name suffixes, and the
   same tools serve both roles.
3. P4 and P5 are evidence problems. Live tool results are not referenceable,
   and workers explore by guessing object names until the budget runs out.

## P7. Where time and tokens go (d69658cf, 42 min)

Normalised cost (Opus = 1, Sonnet = 0.6, output ×5), worker runs grouped by brief:

| Part | Calls | Time | Input | Normalised | Note |
|---|---|---|---|---|---|
| Coordinator (Opus) | 121 | whole session | 1 171k (avg 9.7k/call) | ≈1 323k | **34 calls (409k input) came straight after a tool error**: plan/deliver friction (P1/P2) |
| Phase 1 `write-brd` (analyst) | 14 | 310 s | 339k | 250k | 12× `rag_read`: chunked source documents read one by one |
| Phase 1 extra tasks `persist-brd`, `readback-brd`, `verify-brd` | 3 tasks | ~2 min | small | small | "save and read back" turned into separate worker tasks instead of the coordinator's `rag_persist` plus one read |
| Phase 2 six parallel `verify-*` executors | 67 | 328 s | 2 608k (max 61k per call) | **1 691k** | 54 `SearchObject`, 29 `GetTable`, 19 `GetFunctionModule`, 13 `GetSqlQuery`; guessed object names (P6); 5 budget exhaustions (P5); about **69% of all Sonnet input** |
| Phase 2 `write-tech-spec` (analyst, model main) | 17 | **915 s** | 839k (max 81k) | 640k | 16 `rag_read` of verification results and sources; three `submit_report` calls for a 66k-char document |
| `check-tech-spec` loop | – | ~4 min | – | – | P1: the step lost its verdict kind; `deliver` refused while the check was pending |

Planner author: 6 calls, 39k input. That is small.

## P8. Full ALV run on 10.6.1 (30d966cc, 2026-11-07, 2 h 28 min)

The same four-phase transport ALV process as d69658cf, driven by a script
through the session API (`/v1/session`, `/v1/chat/completions`) on E19,
collection `mte-transport-alv-1108`, prefix `ZMTH27_`.

| Phase | Time | Outcome |
|---|---|---|
| 1 business requirements | 706 s | done, 4 tasks |
| 2 tech spec | 2 372 s | `waiting_user` with an empty question; `verify-tech-spec` stayed pending |
| 3 design | 885 s | done |
| 4 code | – | `ZMTH27_MY_TRANSPORTS` (619 lines, `$TMP`) active, checks 19/19; plan stayed `active` |

Tokens per model:

| Model | Calls | Input | Output | d69658cf input / output |
|---|---|---|---|---|
| Opus 4.6 | 326 | 5 260k | 133k | 1 211k / 31k |
| Sonnet 4.5 | 331 | 15 770k | 485k | 3 786k / 103k |
| gpt-4.1-mini | – | 66k | 16k | 13k / 5k |

The coordinator made 270 Opus calls (average input 15.8k); 53 of them
(1.14M input) came straight after a tool error. The planner author made 51
Opus calls (1.0M input).

Confirmed fixed live: phase 1 no longer fails 26 tasks; no include created
as PROG/P; no `plan must be a string`; built-in profiles synced on deploy.
Not exercised: `CreateInclude` (the planner made one 619-line program).

### Defects

1. **Collection labels used as names (regression from 10.6.0 role split).**
   Read tools print collections as `scope/name`; agents passed the label back
   as `collection` and got `Collection not found` more than 60 times
   (executor `rag_read` ×20, `collection_records` ×13, checker ×11, planner
   author ×10, worker `record_add` ×8). Forms seen: `user/x`, `user:x`,
   `session/x`, `session:x`, `session/task-results`.
2. **`system_type_required` on batch-envelope reads (lib 23.1.0).**
   `ListTransports` (×2). The lib's batch item view carries no system kind;
   the same path serves `GetWhereUsed`, `GetIncludesList`, `DescribeByList`,
   `GetEnhancements`, `GetStructuresList`, `GetAbapSystemSymbols` and
   `RuntimeListFeeds`.
3. **Gate without a question.** The plan stopped in `waiting_user` with
   "Waiting for user approval to proceed with the plan revision" and no
   question to the user.
4. **A replaced failed step blocks the plan.** `s4` stayed `failed` after
   `s4b`–`s4d` replaced it; the plan never reached `done`, and task t28 stayed
   `running`.
5. **Plan churn, as before.** 30 "Skipping or narrowing requires user
   consent" refusals, 7 dependency-change and 5 invalid-dependency errors,
   one `MODEL_NOT_ALLOWED` (`opus`), one `deliver` note over 1000 characters.
6. **Oversized code steps.** "Create the complete program with all
   functionality", then three rewrite cycles of 500+ lines each.
7. **Missing SAP credentials look like an outage.** In the first attempt the
   script sent no `x-sap-*` headers; all 27 tasks failed with "SAP connection
   failed" and the coordinator retried instead of asking for credentials.

Defects 1 and 2 are fixed in the hub (10.6.2). Defects 3, 4 and 6 belong to
the process-phases spec (`superseded`, gates with an exact question, content
units). Defect 5 is P1 again.
