---
name: creating-metadata-extension
description: Create the metadata extension that annotates a projection CDS view with Fiori Elements UI — header info and object title, page facets, list-column (lineItem), object-page (identification), and filter-bar (selectionField) annotations per field, hiding technical/audit fields
---

# Creating a metadata extension

A metadata extension carries the Fiori Elements annotations for a projection view — it lives
outside the CDS DDL so the UI layer can change independently of the data model.

## What it must cover

- `annotate view <Z_C_Entity> with { ... }` targeting the projection view (the projection needed
  `@Metadata.allowExtensions: true` for this to attach).
- `headerInfo` — `typeName`/`typeNamePlural` and the field used as the object title (`title.value`).
  For a child object of a text-associated parent, `description.value` can reference the parent's
  text field (e.g. `'_Author.Name'`).
- `@UI.facet` — at least one facet for the object page; a `#LINEITEM_REFERENCE` facet with
  `targetElement` to show a child composition/association as a table.
- Per business field: `lineItem` (list column, with `importance` for responsive collapsing),
  `identification` (object-page field), `selectionField` (filter bar) — each with a `position`.
- Technical/audit fields (`*Uuid`, `CreatedBy`, `CreatedAt`, `LastChangedBy`, `LastChangedAt`,
  `LocalLastChangedAt`) get `@UI.hidden: true`, not UI annotations.

## Shape

```abap
@Metadata.layer: #CORE
@UI: {
  headerInfo: {
    typeName: '<Entity>',
    typeNamePlural: '<Entities>',
    title: { type: #STANDARD, value: '<TitleField>' }
  }
}
annotate view <Z_C_Entity> with
{
  @UI.facet: [
    { id: 'Details', purpose: #STANDARD, type: #IDENTIFICATION_REFERENCE, label: '<label>', position: 10 }
  ]

  @UI.hidden: true
  <Entity>Uuid;

  @UI: {
    lineItem: [{ position: 10, importance: #HIGH }],
    identification: [{ position: 10 }],
    selectionField: [{ position: 10 }]
  }
  <business field>;
}
```

(Names above are an illustration from one sample object — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| Metadata extension activation fails "not extensible" | Projection view is missing `@Metadata.allowExtensions: true` |
| Field shows in the list but not the filter bar | `selectionField` annotation missing on that field |
