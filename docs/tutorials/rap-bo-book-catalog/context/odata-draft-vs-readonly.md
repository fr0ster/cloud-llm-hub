---
name: OData V4 — Draft vs Read-Only
description: When a RAP/OData V4 app is read-only vs when draft handling is required for CRUD, decided at the description/spec stage
tags: [sap, rap, odata, draft]
---

# OData V4 — Draft vs Read-Only

The transactional capability of a Fiori Elements / OData V4 app is decided by the BO
design, not by the UI. Settle it during Phase 1-2, because it drives the whole object set.

## Rule of thumb

- **Read-only app** — no draft handling. The projection exposes data for display,
  search, and filter, but no create/update/delete. Fewer objects: no draft tables, no
  draft actions, no draft-enabled projection BDEF.
- **Editable app (CRUD)** — requires **draft handling** in RAP managed BOs targeting
  Fiori Elements. That pulls in: draft tables per persistent table, all draft actions
  (Edit, Activate, Discard, Resume, Prepare), and `use draft` in the projection BDEF.

## Decide early

If the user wants users to *only browse / search / report*, design read-only — do not
add draft machinery (YAGNI, and it complicates the spec). If the user wants to *create
or change* records through the app, the spec must include the full draft layer from the
start.

## Common mistakes

| Symptom | Means | Fix |
|---------|-------|-----|
| CRUD "does nothing" in a no-draft app | Editable behavior expected from a read-only design | Re-decide: add draft layer if CRUD is required |
| Draft tables added to a pure reporting app | Over-engineering | Drop draft layer; expose read-only projection |
