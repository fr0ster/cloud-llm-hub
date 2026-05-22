# Session log — ZUI_NOTES diagnosis & fix

Date: 2026-05-22
Destination: `S4HANA_E19`
Executor agent: `cloud-llm-hub` (4 invocations)

---

## 1. Initial problem

Reading the OData service exposed by service binding `ZUI_NOTES_Q4` fails at runtime:

- "parameter has wrong value IV_VALUE = 57762.000000"
- "unknown error"

`57762.000000` looked like a packed value where another type was expected — suspected type mismatch in persisted test data.

---

## 2. RAP stack mapping

| Layer | Object | Notes |
|---|---|---|
| Service binding | `ZUI_NOTES_Q4` (SRVB) | OData V4 |
| Service definition | `ZUI_NOTES` (SRVD) | exposes `ZC_Notes` |
| Projection view | `ZC_NOTES` (DDLS) | transactional_query |
| Interface view | `ZI_NOTES` (DDLS) | root entity |
| Behavior definition | `ZI_NOTES` (BDEF) | managed |
| Behavior implementation | `ZBP_I_NOTES` (CLAS) | **empty** |
| Persistence | `ZNOTES` (TABL) | UUID key |

`ZNOTES` fields of interest: `CREATED_AT`, `LAST_CHANGED_AT` — both `TIMESTAMPL` (DEC 21,7), annotated `@Semantics.systemDateTime.createdAt/lastChangedAt: true` in `ZI_NOTES`.

---

## 3. Data inspection

All 8 rows of `ZNOTES` contained:

```
CREATED_AT      = 57762.0000000
LAST_CHANGED_AT = 57762.0000000
```

A valid TIMESTAMPL value uses 14 digits before the decimal (`YYYYMMDDhhmmss.mmmuuun`). `57762` is malformed → OData serialization/conversion fails.

BHDL is empty, so the managed framework would have populated timestamps correctly on RAP create/update. Conclusion: rows were inserted **bypassing RAP** — most likely by a data-filler ABAP class.

---

## 4. Locating the filler class

- `SearchObject` patterns: `Z*FILL*NOTES*`, `Z*NOTES*FILL*`, etc.
- `GetWhereUsed` on `ZNOTES`.

Found: **`ZCL_FILL_NOTES_TEST_DATA`** (CLAS, package `$TMP`).

---

## 5. Root cause in the filler class

Line 21 (original):

```abap
DATA(lv_timestamp) = cl_abap_context_info=>get_system_time( ).
```

`cl_abap_context_info=>get_system_time( )` returns a `TIME`-like value (HHMMSS). When assigned to a `TIMESTAMPL` field, the packed conversion produces the malformed `57762.0000000`.

---

## 6. Fix

Replaced line 21 with:

```abap
GET TIME STAMP FIELD DATA(lv_timestamp).
```

This produces a full TIMESTAMPL (`YYYYMMDDHHMMSS.mmmuuun`).

Then:

- `UpdateClass` → save
- `ActivateClass` → activate
- `RuntimeRunClass` → re-seed data

Console output:

```
Deleted existing notes
Successfully inserted 8 notes
Test data created successfully!
```

---

## 7. Verification

Post-fix `GetTableContents` on `ZNOTES`:

```
CREATED_AT      = 20260522170236.0000000
LAST_CHANGED_AT = 20260522170236.0000000
```

All 8 rows now valid TIMESTAMPL. ✅

---

## 8. Bonus finding — separate authorization dump

`RuntimeListFeeds` returned a recent ST22 dump (2026-05-22 19:03:07):

- Exception: `CX_SADL_DUMP_APPL_MODEL_ERROR`
- Short text: *"Handler not implemented; Method: INSTANCE_AUTHORIZATION, Involved Entities: ZC_NOTES"*

BDEF `ZI_NOTES` declares instance authorization, but `ZBP_I_NOTES` is empty → no `GET_INSTANCE_AUTHORIZATIONS` implementation.

**Open item:** after timestamp fix the next read attempt will likely hit this. Either implement minimal `GET_INSTANCE_AUTHORIZATIONS` (allow all for tests) or remove `authorization` from BDEF.

---

## 9. Process notes (for future analysis)

### Controller (main Claude) vs Executor (`cloud-llm-hub`)

- Main Claude is the **controller**: planning, synthesis, decisions.
- `cloud-llm-hub` is the **executor**: holds the ~200-tool ABAP MCP catalog in its own context, runs MCP calls.
- Default path for any SAP work — direct `mcp__trial__*` only when no suitable agent exists.

### Token usage (4 agent invocations)

| # | Task | tool_uses | tokens |
|---|---|---|---|
| 1 | Read T100 | 1 | 8 677 |
| 2 | Diagnose ZUI_NOTES (stack + data) | 9 | 22 378 |
| 3 | Deep-dive dumps + CDS + PK | 1 | 11 789 |
| 4 | Find + fix + run filler class | 8 | 20 612 |
| **Σ** | | **19** | **63 456** |

For comparison: loading all ~200 ABAP MCP tool schemas into the main controller context would cost ~15–20k tokens per turn — far more expensive over a multi-turn task than 4 isolated agent invocations.

### Prompt lessons learned

- Be explicit: "**read X and print it**" — agent otherwise reports "cannot retrieve" without trying the right tool. Compare 2nd vs 4th invocation: in #4 the prompt forced tool usage and showed actual code/data; in #3 the agent gave up on dumps and rows.
- Provide tool inventory in the brief when the agent has been timid.
- Batch related tasks in one invocation — amortizes the per-call overhead.

### Permissions

Added to `.claude/settings.local.json`:

```json
"Bash(curl *127.0.0.1:3001*)",
"Bash(curl *localhost:3001*)"
```

To pick up new permission rules without restart, open `/permissions` (or restart Claude Code session).
