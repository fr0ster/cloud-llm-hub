---
type: support-case
tags: [abap, performance, select, for-all-entries]
system: MOCK-S4H
case_id: MOCK-SC-001
---

# MOCK-SC-001 — Report returns all sales orders instead of subset

**Reporter:** MOCK-user finance-team
**Severity:** High
**Status:** Resolved

## Symptom

Report `Z_MOCK_OPEN_ORDERS` occasionally returns **all** sales orders in the system, ignoring the user's selection-screen filters. Reproducible only when the user selects an empty customer group.

## Diagnosis

The code uses `SELECT ... FOR ALL ENTRIES IN lt_customers` without guarding against an empty driver table:

```abap
SELECT vbeln, posnr, netwr
  FROM vbap
  FOR ALL ENTRIES IN @lt_customers
  WHERE kunnr = @lt_customers-kunnr
  INTO TABLE @DATA(lt_items).
```

When `lt_customers` is empty, ABAP ignores the WHERE clause entirely — returning the full table. This is documented behavior and a frequent source of incidents.

## Resolution

Guard the SELECT:

```abap
IF lt_customers IS NOT INITIAL.
  SELECT vbeln, posnr, netwr
    FROM vbap
    FOR ALL ENTRIES IN @lt_customers
    WHERE kunnr = @lt_customers-kunnr
    INTO TABLE @DATA(lt_items).
ENDIF.
```

Delivered via transport `MOCK-TR-00421`, imported to PRD on MOCK-2026-02-14.

## Root Cause Category

Developer error — missing empty-check before FOR ALL ENTRIES. Covered by code-review checklist but not by ATC by default.

## See Also
- [best-practices/select-for-all-entries.md](../best-practices/select-for-all-entries.md)
- [support-cases/MOCK-SC-003-performance-loop-select.md](MOCK-SC-003-performance-loop-select.md)
