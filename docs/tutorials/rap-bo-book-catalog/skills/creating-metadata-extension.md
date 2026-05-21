---
name: Creating a Metadata Extension
description: Rules for the metadata extension layer that annotates a projection CDS view with UI facets, line items, identification, and filter fields
tags: [sap, cds, metadata-extension, fiori-ui]
---

# Creating a Metadata Extension

A metadata extension carries Fiori UI annotations separately from the CDS view DDL.
One extension per projection view that needs UI.

## Shape

```ddl
@Metadata.layer: #CUSTOMER
annotate view Z##_C_<ROOT> with
{
  @UI.facet: [
    { id: 'Identification', type: #IDENTIFICATION_REFERENCE, position: 10 },
    { id: 'Plants',         type: #LINEITEM_REFERENCE,       targetElement: '_Plant' }
  ]
  @UI.hidden: true
  Uuid;

  @UI.lineItem:       [{ position: 10 }]
  @UI.identification: [{ position: 10 }]
  @UI.selectionField: [{ position: 10 }]
  Matnr;

  @UI.lineItem:       [{ position: 20 }]
  @UI.identification: [{ position: 20 }]
  MaterialType;
}
```

## Rules

- The projection view must have `@Metadata.allowExtensions: true` — otherwise create
  fails with *"extension layer not allowed"*.
- Use `@Metadata.layer: #CUSTOMER` (or `#PARTNER` depending on the tier).
- Hide technical fields: `@UI.hidden: true` on Uuid, RootUuid, audit fields you don't
  want users to see.
- Facet types: `#IDENTIFICATION_REFERENCE` for the general section,
  `#LINEITEM_REFERENCE` (with `targetElement`) for a child table on the object page,
  `#FIELDGROUP_REFERENCE` for grouped fields.
- After creation, `Activate` the extension. Read it back; the projection view itself
  does not need re-activation unless its DDL changed.

## Common error fix

| Error                              | Cause                                         | Fix                                                                    |
|------------------------------------|-----------------------------------------------|------------------------------------------------------------------------|
| `extension layer not allowed`     | Projection lacks `allowExtensions`            | Add the annotation, reactivate the projection, retry the extension.    |
| Field not shown in list           | Missing `@UI.lineItem` position               | Add `@UI.lineItem: [{ position: N }]` on the field.                    |
| Filter bar empty                  | No `@UI.selectionField`                       | Add the annotation on every filterable field.                          |
