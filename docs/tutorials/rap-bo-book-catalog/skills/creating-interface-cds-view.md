---
name: Creating an Interface CDS View (R-type)
description: Rules for creating the interface (R-type) CDS view layer for a RAP managed BO — composition graph, aliases, group activation, expected circular check errors
tags: [sap, cds, rap, interface]
---

# Creating an Interface CDS View (R-type)

R-type views are the technical interface above the persistent tables. The root holds
the composition graph; children point back to the root via association on the parent
UUID.

## Shape

```ddl
@AccessControl.authorizationCheck: #NOT_REQUIRED
define root view entity Z##_R_<ROOT>
  as select from z##_<root>
  composition [0..*] of Z##_R_<CHILD>   as _<Child>
  ...
{
  key uuid                       as Uuid,
  key matnr                      as Matnr,
      ...
}

define view entity Z##_R_<CHILD>
  as select from z##_<child>
  association to parent Z##_R_<ROOT> as _Root
    on $projection.RootUuid = _Root.Uuid
{
  key uuid                       as Uuid,
  key root_uuid                  as RootUuid,
      ...
}
```

## Rules

- All fields aliased to PascalCase: `uuid as Uuid`, `matnr as Matnr`,
  `mtart as MaterialType`. The CDS aliases are what BDEF mappings and draft tables
  must match.
- **Always provide complete DDL** in the create call. An empty shell created via
  `CreateCdsView` without the DDL fails activation later with *"DDIC source code does
  not contain a valid definition"*.
- The graph is circular: root references children, children reference root. Syntax
  check **before** activation will report missing data sources. Those errors disappear
  on group activation. Only non-circular errors (wrong field names, missing tables)
  need fixing first.
- Create all R-views in the BO, then **activate them together in one call** — never
  one by one. Activate filter by prefix (`Z##_R_*`).
- After group activation, run a syntax check per view to surface real warnings.

## Common error fix

| Error                                            | Cause                                | Fix                                                              |
|--------------------------------------------------|--------------------------------------|------------------------------------------------------------------|
| `DDIC source code does not contain a valid definition` | View created without DDL       | Update the view with the full DDL, then activate.                |
| `data source X does not exist or is not active` | Circular ref, pre-activation       | Expected — disappears on group activation. Ignore if non-circular checks pass. |
| `association target not found`                  | Views activated one at a time      | Activate the whole R-layer in one call.                          |
