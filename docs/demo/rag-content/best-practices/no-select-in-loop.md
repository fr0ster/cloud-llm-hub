---
type: best-practice
tags: [abap, performance, select, loop]
system: all
---

# Best Practice: No SELECT Inside LOOP

## Rule

Do NOT place any DB access (SELECT, UPDATE, DELETE, MODIFY, CALL FUNCTION with DB access) inside a LOOP that iterates over ≥ 2 rows of an internal table.

## Why

DB round-trips dominate runtime. A SELECT inside a 10,000-row loop is 10,000 round-trips; the same logic with `FOR ALL ENTRIES` is 1 batched call. Performance scales with data volume — code that is fast in DEV becomes a P1 incident in PRD.

## Allowed Alternatives

### 1. Bulk SELECT before loop + BINARY SEARCH in loop

```abap
IF lt_documents IS NOT INITIAL.
  SELECT awkey, bukrs, belnr
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

### 2. CDS view with JOIN

When the relationship is stable, encode the JOIN in a CDS interface view. The runtime decides join order and indexes.

### 3. Hashed table for lookup

For one-shot lookups in long-running code, use a hashed internal table keyed on the lookup column:

```abap
DATA lt_headers_hashed TYPE HASHED TABLE OF ty_header WITH UNIQUE KEY awkey.
```

## Detection

- ATC rule `PERFORMANCE_DB_STATEMENTS_IN_LOOP`.
- SAT trace — look at caller aggregation for `SELECT` entries.
- Code review: any `SELECT SINGLE` inside an obvious loop is a red flag.

## Exceptions

Acceptable only when:
- The loop body iterates ≤ 1 row in practice (guarded by IF).
- The SELECT hits a table with ≤ 100 rows total (config tables like T001, T000).

Exceptions must be documented in the method comment.

## See Also
- [support-cases/MOCK-SC-003-performance-loop-select.md](../support-cases/MOCK-SC-003-performance-loop-select.md)
- [best-practices/select-for-all-entries.md](select-for-all-entries.md)
