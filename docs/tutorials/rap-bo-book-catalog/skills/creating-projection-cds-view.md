---
name: Creating a Projection CDS View (C-type)
description: Rules for the projection (C-type) CDS view layer that exposes a RAP managed BO over OData
tags: [sap, cds, rap, projection]
---

# Creating a Projection CDS View (C-type)

C-type views project the R-layer for consumption (OData / Fiori). The root carries the
transactional contract; children redirect composition pointers to the matching child
projections.

## Shape

```ddl
@AccessControl.authorizationCheck: #NOT_REQUIRED
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity Z##_C_<ROOT>
  provider contract transactional_query
  as projection on Z##_R_<ROOT>
{
  key Uuid,
  key Matnr,
      ...
      _Plant : redirected to composition child Z##_C_MAT_PLANT,
      _Sales : redirected to composition child Z##_C_MAT_SALES
}

define view entity Z##_C_<CHILD>
  as projection on Z##_R_<CHILD>
{
  ...,
  _Root : redirected to parent Z##_C_<ROOT>
}
```

## Rules

- Root view: `provider contract transactional_query`,
  `@Search.searchable: true`, `@Metadata.allowExtensions: true`.
- Redirect every composition in the root: `_Child : redirected to composition child
  Z##_C_<CHILD>`. Without it, the BDEF cannot project the composition.
- Redirect the back-reference in each child: `_Root : redirected to parent
  Z##_C_<ROOT>`.
- The R-layer must be **active first**.
- Same circular pattern as the R-layer: create all C-views, group-activate together
  (filter `Z##_C_*`).
- `@Metadata.allowExtensions: true` is required if a metadata extension will be
  attached later — adding the annotation after the fact requires reactivation.

## Common error fix

| Error                                  | Cause                                       | Fix                                                            |
|----------------------------------------|---------------------------------------------|----------------------------------------------------------------|
| `redirected target view not found`     | Child projection not yet created            | Create all C-views first, then activate together.              |
| `extension layer not allowed`          | Missing `@Metadata.allowExtensions: true`   | Add annotation, reactivate.                                    |
| Search annotation has no effect        | Annotation on a child or on a wrong field   | Apply `@Search.searchable: true` on the root view only.        |
