---
name: Creating a Domain
description: Rules for creating an ABAP domain via MCP — single object, one type+length, activate before any data element references it
tags: [sap, ddic, domain]
---

# Creating a Domain

A domain defines one ABAP type and length. It is the lowest layer in the DDIC stack —
data elements reference it, tables and CDS views reference data elements.

## Rules

- One concrete ABAP type with its size: `CHAR 40`, `NUMC 4`, `DEC 10,2`, `UNIT`, etc.
  Never leave length open (`STRING` with no length, `CHAR` with no length, `DEC` with no
  precision) — the create call must carry an exact size.
- Name follows the project prefix convention, typically `Z##_D_<NAME>`. The pair
  `Z##_D_<NAME>` / `Z##_E_<NAME>` (domain / data element) must not cross — both keep the
  same `<NAME>` suffix.
- After creating a batch, **activate explicitly**. Domains often stay inactive after
  `CreateDomain`. Activation must filter by the project prefix to avoid touching other
  users' work: *"Activate all inactive objects starting with `Z##_D_`"*. Never run a
  bare *"Activate all inactive objects"*.
- Verify by calling `ReadDomain` on each created name and confirming the response
  contains `active: true`. The phrase "all domains active" without that read-back is
  not evidence.

## Common error fix

| Error                               | Cause                          | Fix                                  |
|-------------------------------------|--------------------------------|--------------------------------------|
| `domain not active`                 | A consumer was created first  | Activate the domain, then retry.     |
| Type unset on freshly created domain| Tool called without a type    | Re-create with explicit type+length. |
