---
name: creating-domain
description: Create an ABAP domain for a RAP business object field — pick one concrete built-in type with an explicit length (and fixed values for closed sets), and activate it before any data element references it
---

# Creating a domain

A domain is the base data type for a field: **one** built-in type (`CHAR`, `NUMC`, `INT4`, `DEC`, ...)
plus an explicit length where the type needs one. Nothing else belongs in the domain.

## The rule

- Pick exactly one type. Don't leave the length implicit — state it, even for fixed-width
  types like `NUMC`.
- If the field only ever takes a closed set of values, add fixed values (value list) on the
  domain, not later in the data element or the view.
- A domain must be **active** before any data element can reference it — create and activate it
  first, or as part of the same foundation-layer group.

## Shape

```abap
Domain Name: <ZDOMAIN>
Description: <short text>
Data Type: CHAR | NUMC | INT4 | DEC | ...
Length: <n>              " omit only for types with a fixed technical length, e.g. INT4
Fixed Values:             " optional — only when the field is a closed set
- <VALUE1>: <label>
- <VALUE2>: <label>
```

(`<ZDOMAIN>` and the example type/length/values below are an illustration from one sample
object — apply the rule, not the names. The domain's own name follows the project's naming
policy, not this example.)

```abap
Domain Name: Z##_GENRE
Data Type: CHAR
Length: 30
Fixed Values:
- FICTION: Fiction
- NONFICTION: Non-Fiction
- SCIFI: Science Fiction
```

## Common mistake

| Symptom | Fix |
|---|---|
| Data element creation fails "domain not found/active" | Activate the domain first |
| Value list duplicated across data element/view | Put fixed values on the domain, once |
