---
type: best-practice
tags: [abap, exceptions, error-handling, clean-abap]
system: all
---

# Best Practice: Exception Handling in ABAP

## Use Class-Based Exceptions

New code MUST use class-based exceptions (`CX_*`). Do not declare new `EXCEPTIONS` in function modules or `RAISING` clauses of methods; use `RAISING cx_...` instead.

## Exception Hierarchy

```
CX_ROOT
 └── CX_STATIC_CHECK       — business-expected, caller MUST handle
 └── CX_DYNAMIC_CHECK      — programming error, caller MAY handle
 └── CX_NO_CHECK           — fatal, do not catch
```

Guideline:
- Business-layer exceptions: `CX_STATIC_CHECK` descendants (forces callers to handle).
- Framework / infrastructure: `CX_DYNAMIC_CHECK`.
- Never extend `CX_NO_CHECK` in application code.

## Carry Context

An exception without context is a debugging tax. Always carry:

- Original cause (`previous = lx_previous`).
- Relevant business keys (order number, material, user).
- Human-readable message via `if_t100_message` / `if_t100_dyn_msg`.

```abap
RAISE EXCEPTION TYPE zcx_mock_sales_error
  EXPORTING
    textid   = zcx_mock_sales_error=>order_blocked
    order_id = ls_order-vbeln
    previous = lx_previous.
```

## Do NOT Swallow Exceptions

Anti-pattern:

```abap
TRY.
  lo_service->calculate( ).
CATCH cx_root.
ENDTRY.
```

This hides bugs. Minimum acceptable backstop:

```abap
TRY.
  lo_service->calculate( ).
CATCH cx_root INTO DATA(lx_error).
  " log + re-raise or convert to business exception
  zcl_mock_logger=>error( lx_error ).
  RAISE EXCEPTION TYPE zcx_mock_sales_error
    EXPORTING previous = lx_error textid = zcx_mock_sales_error=>unexpected.
ENDTRY.
```

## Catch at the Right Layer

- In library code: catch only what you can handle, re-raise the rest.
- In facade / controller code: catch everything, log, and return a domain-specific response.
- In RAP BIMP: report via `reported-%fail` / `failed-%key` tables, never crash the BO.

## Messages

Bind message class once via `if_t100_message`. Do not build error text with string templates — `ST22` parsers and translation tools rely on T100 metadata.

## See Also
- [best-practices/no-select-in-loop.md](no-select-in-loop.md)
