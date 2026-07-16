---
name: creating-projection-cds-view
description: Create the projection (C-type) CDS view for a RAP business object over its interface view — redirect every composition/association to its own projection counterpart, and why linked projection views must be created and activated together as one group
---

# Creating a projection CDS view

The projection view (`C_` layer) is the consumption-side view a service definition exposes.
It sits on the interface view, not on the table.

## The rule

- `provider contract transactional_query`, `as projection on <Z_I_...>`.
- `@AccessControl.authorizationCheck: #NOT_REQUIRED` — the interface view already enforces the
  check; the projection doesn't re-check.
- `@Metadata.allowExtensions: true` so a metadata extension can annotate this view later.
- Every association/composition carried over from the interface view must be **redirected** to
  its own projection counterpart: `_Child : redirected to <Z_C_Child>`. A projection association
  that still points at an interface view breaks the consumption model.
- Same group rule as the interface layer: a projection view referencing another projection view
  can't activate before that target exists — create and activate the whole projection graph
  together.
- Search/filter annotations (`@Search.searchable`, `@Search.defaultSearchElement`) belong on the
  projection, since that's what the UI queries against.

## Shape

```abap
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '<label>'
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity <Z_C_Root>
  provider contract transactional_query
  as projection on <Z_I_Root>
{
  key RootUuid,
      @Search.defaultSearchElement: true
      Title,
      ...
      _Child : redirected to <Z_C_Child>
}
```

(Names above are an illustration from one sample object graph — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| Activation fails: unknown entity `_Child` | The redirected projection target wasn't created/activated yet — group-activate the whole projection graph |
| Metadata extension can't annotate the view | `@Metadata.allowExtensions: true` missing on the projection |
