---
type: security-kb
tags: [security, sql-injection, abap, dynamic-sql]
system: all
severity: High
---

# Security KB: SQL Injection via Dynamic WHERE

## Pattern

User input is concatenated into a dynamic WHERE clause without sanitization.

### Vulnerable

```abap
DATA(lv_where) = |{ 'CUSTOMER = ''' }{ iv_customer }{ '''' }|.
SELECT * FROM vbak INTO TABLE @DATA(lt_orders) WHERE (lv_where).
```

An attacker supplying `iv_customer = "X' OR '1'='1"` turns the query into `CUSTOMER = 'X' OR '1'='1'` — dumps the whole table. In higher-privilege flows, this can become `UPDATE` or `DELETE` injection.

### Safe — Parameter Binding

Prefer typed static WHERE:

```abap
SELECT * FROM vbak INTO TABLE @DATA(lt_orders) WHERE kunnr = @iv_customer.
```

### Safe — Dynamic with Quoted Input

When dynamic WHERE is truly required:

```abap
DATA(lv_where) = |CUSTOMER = { cl_abap_dyn_prg=>quote( iv_customer ) }|.
SELECT * FROM vbak INTO TABLE @DATA(lt_orders) WHERE (lv_where).
```

`CL_ABAP_DYN_PRG=>QUOTE` escapes single quotes. For whitelisted column names use `CL_ABAP_DYN_PRG=>CHECK_COLUMN_NAME`.

## Where to Look

Scan for these patterns:

- `WHERE ( lv_` / `WHERE ( ls_` — dynamic WHERE with a variable.
- `CONCATENATE ... INTO lv_where` — string building.
- `EXEC SQL` — always high risk; require security review.
- `CALL FUNCTION 'RFC_READ_TABLE'` with attacker-controlled options.

## Severity Matrix

| Data accessed | Severity |
|---------------|----------|
| Read-only, non-PII | Medium |
| Read-only, PII / financial | High |
| Write capability | Critical |

## Fix Template for Reviewers

1. Identify the untrusted input source (selection screen, RFC, OData parameter).
2. Confirm it reaches a dynamic SQL construct.
3. Apply parameter binding if possible; otherwise `CL_ABAP_DYN_PRG` sanitizers.
4. Add a regression test that injects `' OR '1'='1`.

## See Also
- [security-kb/authorization-bypass.md](authorization-bypass.md)
