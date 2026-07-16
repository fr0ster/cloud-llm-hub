---
name: creating-data-element
description: Create an ABAP data element for a RAP business object field — reference an active domain or a predefined type, and fill in all four field-label lengths that drive the Fiori column headers and field labels
---

# Creating a data element

A data element wraps a domain (or a predefined ABAP type) and adds the field labels that later
show up as column headers and field labels in the generated Fiori UI.

## The rule

- Reference exactly one source of the type: an **active domain**, or — for simple technical
  fields that don't need a domain — a predefined type directly.
- Provide all four label lengths: short, medium, long, heading. Fiori picks whichever fits the
  available UI space; a missing one falls back to a truncated/blank label.
- The data element's own semantics (e.g. as a currency/quantity unit reference) belong here, not
  on the table field.

## Shape

```abap
Data Element: <ZDE>
Domain: <ZDOMAIN>              " the domain created earlier — must be active
Field Label:
  - Short:   <≤10 chars>
  - Medium:  <≤20 chars>
  - Long:    <≤40 chars>
  - Heading: <free>
```

(`<ZDE>`/`<ZDOMAIN>` and the example below are an illustration from one sample object — apply
the rule, not the names.)

```abap
Data Element: Z##_BOOK_TITLE
Domain: Z##_BOOK_TITLE
Field Label:
  - Short: Title
  - Medium: Book Title
  - Long: Book Title
  - Heading: Book Title
```

## Common mistake

| Symptom | Fix |
|---|---|
| Column header shows the technical field name | A label length was left empty |
| Data element creation fails "domain not found/active" | Activate the domain before the data element |
