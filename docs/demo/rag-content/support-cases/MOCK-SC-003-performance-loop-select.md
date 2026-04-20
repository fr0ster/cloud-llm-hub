---
type: support-case
tags: [abap, performance, loop, select]
system: MOCK-S4H
case_id: MOCK-SC-003
---

# MOCK-SC-003 — Nightly batch job runtime degraded from 4 min to 2 h

**Reporter:** MOCK-user ops-team
**Severity:** High
**Status:** Resolved

## Symptom

Batch job `Z_MOCK_SETTLEMENT_RUN` historically finished in ~4 minutes. Over the last 3 months runtime grew linearly to 2 hours. No functional change reported.

## Diagnosis

SAT trace shows 87% of runtime in a single `SELECT SINGLE` inside a `LOOP AT lt_documents`:

```abap
LOOP AT lt_documents ASSIGNING FIELD-SYMBOL(<doc>).
  SELECT SINGLE bukrs, belnr, gjahr
    FROM bkpf
    INTO @DATA(ls_header)
    WHERE awkey = @<doc>-awkey.
  ...
ENDLOOP.
```

The business has grown: `lt_documents` started at ~10,000 rows and now has ~250,000. Linear-in-N SELECTs dominate runtime. No index on `BKPF~AWKEY` for the custom access pattern.

## Resolution

Replace per-row SELECT with bulk fetch before the loop:

```abap
IF lt_documents IS NOT INITIAL.
  SELECT bukrs, belnr, gjahr, awkey
    FROM bkpf
    FOR ALL ENTRIES IN @lt_documents
    WHERE awkey = @lt_documents-awkey
    INTO TABLE @DATA(lt_headers).
  SORT lt_headers BY awkey.
ENDIF.

LOOP AT lt_documents ASSIGNING FIELD-SYMBOL(<doc>).
  READ TABLE lt_headers INTO DATA(ls_header)
    WITH KEY awkey = <doc>-awkey BINARY SEARCH.
  ...
ENDLOOP.
```

Runtime back to ~6 minutes at current volume.

Transport `MOCK-TR-00612` imported to PRD on MOCK-2026-03-02.

## Root Cause Category

Anti-pattern: SELECT inside LOOP. Detectable by ATC rule `PERFORMANCE_DB_STATEMENTS_IN_LOOP`.

## See Also
- [best-practices/no-select-in-loop.md](../best-practices/no-select-in-loop.md)
