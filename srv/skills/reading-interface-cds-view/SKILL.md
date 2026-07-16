---
name: reading-interface-cds-view
description: Read / inspect an interface CDS view for a RAP business object — trace its composition/association graph to understand the object model, and note that the underlying SQL/DDL view name differs from the CDS entity name
---

# Reading an interface CDS view

An interface view is where the object model actually lives — read it to answer "what is
composed vs associated here", not just "what columns does it have".

## What matters when inspecting

- **Read the composition/association graph, not just the field list.** `composition [0..*] of
  <X> as _X` means `_X` is an owned child (deleted with the parent, locked/authorized through
  it — see composition-vs-association); `association [...] to <X> as _X` means `_X` is an
  independent BO reached by reference. Getting this backwards mis-describes the whole object
  model.
- **The SQL/DDL view name differs from the CDS entity name.** The CDS entity you navigate to in
  ADT (e.g. `Z##_I_Book`) compiles to a separate underlying SQL view name — when tracing at the
  database/runtime level (e.g. via `SE16N` or a SQL trace), look up the SQL view name, don't
  assume it matches the entity name.
- Check `@AccessControl.authorizationCheck` — interface views are normally `#CHECK`; that
  authorization check is enforced here, not repeated in the projection view.

## Common mistake

| Symptom | Fix |
|---|---|
| Describing a composed child as an independent object (or vice versa) | Re-check `composition` vs `association` in the view's FROM clause, don't infer from naming |
| Can't find the view in a DB-level trace by its CDS name | Look up the generated SQL view name instead |
