---
name: activating-objects
description: Activate one or more ABAP/RAP objects for a business object step — mutually dependent objects such as linked CDS views or a behavior definition with its implementation class must be activated together as one group, never one at a time
---

# Activating objects

Activation is per-step, but not every object activates alone. Some objects only compile
successfully once everything they reference is already active.

## The rule

- Activate an object as soon as it stands on its own (nothing it references is still inactive).
- **Group-activate mutually dependent objects.** Two common cases:
  - Linked CDS views (an interface or projection view that references another view via
    composition/association) — activate the whole referenced set together, not the referencing
    view alone.
  - A behavior definition and its implementing class (BDEF + BIMP) — the BDEF's
    `managed implementation in class ... unique;` names a class that must exist and be active
    for the BDEF to activate cleanly; treat the pair as one activation unit.
- Never activate a single object in a group and declare the step done while its dependents are
  still inactive — that leaves the object graph in a half-active state that later steps will
  trip over.
- After a group activation, verify: check the objects exist and are active (not just that the
  activate call returned without error).

## Common mistake

| Symptom | Fix |
|---|---|
| CDS view activation fails: unknown entity `_Child` | The referenced view is still inactive — activate the linked set together |
| BDEF activation fails "implementing class not found" | The BIMP wasn't created/active yet — activate BDEF and BIMP as one unit |
| "Looks activated" but next step fails on a missing dependency | Verified only the last object, not the whole group |
