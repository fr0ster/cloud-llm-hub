---
name: ABAP Short Dump Analysis
description: Root-cause workflow for ST22 short dumps. Correlates exception, failing statement, source, and recent transports. Applies to on-premise AS ABAP systems accessed via MCP.
version: 1.0.0
tags: [sap, abap, st22, dump, troubleshooting]
---

# Short Dump Analysis — Skill Reference

## Scope

Use when the user provides a dump ID (or pastes dump text) and asks for root cause, impact, or fix.

Applies to classical ABAP AS on-premise. RAP runtime dumps are in scope. SAP-standard dumps (without custom frame) are out of scope beyond symptom classification.

## Hallucination Detection

A plausible-looking dump analysis without real tool calls is a common failure mode.

**Required evidence:**
- `GetDump(id, system)` returned actual payload (exception class + call stack).
- `GetProgram` or `GetClass` returned source covering the failing line.
- Failing line number exists in the source.

If any of the above is missing, the analysis is incomplete — report "unable to verify" rather than invent.

## Analysis Workflow

### Step 1 — Classify the exception

Read the `Category` and `Runtime Error` fields.

| Category | Typical cause |
|----------|---------------|
| `ABAP Programming Error` | Bug: type mismatch, missing value, division by zero |
| `Resource shortage` | Memory / timeout / DB resources |
| `System environment` | DB connection, file system, RFC destination |
| `Installation errors` | Missing object / package inconsistency |
| `Termination message` | Explicit `MESSAGE ... TYPE 'A'` or `'X'` |

Report the category before guessing cause.

### Step 2 — Identify the failing statement

From the dump:
- `Main Program`, `Source Code Component`, `Line`.
- The ABAP statement on that line (dump shows it verbatim).

Fetch the source via `GetProgram` / `GetInclude` / `GetClass` and confirm the line matches.

### Step 3 — Extract runtime state

- `SY-SUBRC` at point of failure.
- Variable values from the dump's "Chosen variables" section.
- Internal table contents (number of rows, key values if shown).

Do NOT invent variable values — only use what the dump actually contains.

### Step 4 — Hypothesize cause

Form 1–2 hypotheses grounded in steps 1-3. Each hypothesis must:
- Reference a specific line of source.
- Cite a variable value from the dump.
- Explain the chain: runtime state → statement → exception.

### Step 5 — Check recent changes

Call `GetTransportOfObject` for the failing object. Report last 3 transports:
- Transport ID, description, author, date.
- Flag any transport imported within 24h of the dump time.

### Step 6 — Propose a fix

Minimal diff only — no refactoring. Formats:
- Missing `ASSIGN` check → add `IF sy-subrc = 0.`.
- Type overflow → widen the type.
- Missing `READ TABLE ... WITH KEY` subrc check → guard with IF.

If the root cause is in SAP-standard code, do NOT propose a fix — recommend raising a SAP incident and document the dump for support.

## Output Format

```markdown
# Dump <ID> on <SYSTEM>/<CLIENT>

## Symptom
- **Exception class:** <CX_...>
- **Runtime error:** <...>
- **Category:** <...>
- **Occurred:** <timestamp>, user <...>

## Failing Statement
- **Program:** <...>, include <...>, line <N>
- **Statement:** `<verbatim ABAP>`

## Runtime State
- SY-SUBRC = <...>
- Variables: <list from dump>

## Hypothesis
<grounded in code + variables>

## Recent Transports
| TR | Description | Author | Date |
|----|-------------|--------|------|

## Suggested Fix
<minimal diff or "escalate to SAP">

## Not Determined
<anything you couldn't verify from tools>
```

## Non-Goals

- Do NOT analyze dumps older than ST22 retention window without warning — IDs may have been reorganized.
- Do NOT suggest changing SAP-standard code.
- Do NOT provide a fix for resource-shortage dumps without performance analysis — escalate instead.

## Common Failures

| Symptom | Remedy |
|---------|--------|
| Agent invents variable values | Reject; re-fetch dump. |
| Fix proposed without reading source | Reject; force `GetProgram` call. |
| "Recent transports: TR1, TR2" with no IDs | Reject; require real IDs from `GetTransportOfObject`. |
| Generic "check data consistency" | Require specific field / table reference. |
