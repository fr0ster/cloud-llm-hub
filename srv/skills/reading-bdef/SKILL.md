---
name: reading-bdef
description: Read / inspect a behavior definition (BDEF) for a RAP business object — implementation type (managed/unmanaged), whether draft is on, the lock model, which operations and actions are exposed, and the authorization model
---

# Reading a behavior definition (BDEF)

A BDEF tells you what a RAP entity can actually do at runtime — read it before assuming an
operation, draft support, or authorization check exists.

## What to look for

- **Implementation type**: `managed implementation in class ...` vs `unmanaged` — this changes
  where the persistence logic lives (framework-generated vs hand-written in the class).
- **Draft on or off**: `with draft;` (interface) / `use draft;` (projection) present or absent.
  No draft clause means the entity is not draft-enabled at all — don't assume every RAP BO has a
  draft table.
- **Lock model**: `lock master` on the composition root, `lock dependent by <_Parent>` on a
  composed child. This tells you which entity actually owns concurrency control for the whole
  object graph.
- **Exposed operations and actions**: `create`/`update`/`delete` and, for a draft root, which of
  the five draft actions (`Edit`, `Activate`, `Discard`, `Resume`, `Prepare`) are present — a
  missing one means that operation genuinely isn't available, not a documentation gap.
- **Authorization model**: `authorization master ( instance )` on the root vs
  `authorization dependent by <_Parent>` on a child — and whether the BIMP's handler class
  actually implements `get_instance_authorizations`, since the clause alone doesn't grant
  anything (see creating-bimp).

## Common mistake

| Symptom | Fix |
|---|---|
| Assuming draft support because the CDS view has a draft table | Draft is declared per BDEF (`with draft;`/`use draft;`), check the BDEF itself |
| Assuming an operation is available because the table/view supports it | Check the BDEF's `create`/`update`/`delete`/action list — the BDEF is what actually exposes it |
