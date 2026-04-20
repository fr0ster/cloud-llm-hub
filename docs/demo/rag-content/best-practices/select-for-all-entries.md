---
type: best-practice
tags: [abap, performance, select, for-all-entries]
system: all
---

# Best Practice: FOR ALL ENTRIES Guard & Usage

## Rule 1 — Always guard against empty driver table

```abap
IF lt_keys IS NOT INITIAL.
  SELECT ... FOR ALL ENTRIES IN @lt_keys ...
ENDIF.
```

**Reason:** if `lt_keys` is empty, ABAP drops the WHERE clause entirely, returning the full table. This regularly produces P1 incidents (see [MOCK-SC-001](../support-cases/MOCK-SC-001-select-for-all-entries-empty.md)).

## Rule 2 — Driver table columns must participate in WHERE

All columns of the driver table used in the WHERE must be addressed with `@lt_keys-column`, never bare values.

## Rule 3 — Avoid duplicates in driver table

FOR ALL ENTRIES removes duplicates from the result set based on ALL selected columns. If the key in `lt_keys` is not unique, deduplicate first:

```abap
SORT lt_keys BY field1 field2.
DELETE ADJACENT DUPLICATES FROM lt_keys COMPARING field1 field2.
```

## Rule 4 — Include full primary key in SELECT list

If the SELECT list omits part of the DB table's primary key, the database returns distinct rows — potentially merging different entities into one. Always include the full PK.

## Rule 5 — Package size

Default package size is driver-table rows. For very large driver tables (> 100,000 rows), split into packages to avoid memory pressure:

```abap
DATA(lo_packager) = NEW cl_mock_far_packager( lt_keys ).
WHILE lo_packager->has_next( ) = abap_true.
  DATA(lt_package) = lo_packager->next( size = 10000 ).
  ...
ENDWHILE.
```

## When to Prefer JOIN Instead

- Stable, compile-time relationship → CDS view with JOIN.
- Driver table built at runtime from business logic → FOR ALL ENTRIES is appropriate.
- More than 2 tables → CDS view almost always wins.

## See Also
- [best-practices/no-select-in-loop.md](no-select-in-loop.md)
- [support-cases/MOCK-SC-001-select-for-all-entries-empty.md](../support-cases/MOCK-SC-001-select-for-all-entries-empty.md)
