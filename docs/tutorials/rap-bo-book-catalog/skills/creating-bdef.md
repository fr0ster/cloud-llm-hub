---
name: Creating a Behavior Definition (BDEF)
description: Rules for creating the interface BDEF for a RAP managed BO with draft, strict (2), and explicit mapping per entity
tags: [sap, rap, bdef]
---

# Creating a Behavior Definition (BDEF)

The BDEF declares the transactional behaviour for the BO: locks, authorization, draft
persistence, draft actions, and the explicit mapping from CDS aliases to persistent
columns.

## Strict (2) + draft contract

For every entity in the BO (root and children) you must declare:

| Concern        | Root entity                                       | Child entity                       |
|----------------|---------------------------------------------------|------------------------------------|
| Authorization  | `authorization master ( instance )`               | `authorization dependent by _Root` |
| Lock           | `lock master total etag LocalLastChangedAt`       | `lock dependent by _Root`          |
| Draft table    | `draft table z##_<root>_d`                        | `draft table z##_<child>_d`        |
| Mapping        | explicit per field (see below)                    | explicit per field                 |
| ETag           | `etag master LocalLastChangedAt`                  | inherited                          |
| UUID numbering | `field ( numbering : managed, readonly ) <Key>;`  | `field ( numbering : managed, readonly ) <Key>;` |

## Draft actions (root only)

All five required. Missing `Discard` fails activation: *"there must be an explicit
definition of the draft action Discard"*.

```bdef
draft action Edit;
draft action Resume;
draft action Activate optimized;
draft action Discard;
draft determine action Prepare;
```

## Mapping — explicit, never `corresponding`

CDS aliases (PascalCase) do not match persistent column names (lowercase). Use
`corresponding` and you get 40+ mapping warnings plus broken field persistence.

```bdef
mapping for z##_<root>
{
  Uuid          = uuid;
  Matnr         = matnr;
  MaterialType  = mtart;
  ...
}
```

- **No mapping for draft tables.** Draft is declared via the entity header only.
- For BOs referencing other BOs (e.g. Book → Author), add `with cross associations;` to
  the BDEF header — without it: *"uses an obsolete implementation"*.

## Activation

BDEF and BIMP have a circular dependency. Create both, then activate them together via
`ActivateBehaviorDefinition` (not the generic `ActivateObjects` — see
`activating-objects` skill).

## Common error fix

| Error                                                             | Cause                                              | Fix                                                                      |
|-------------------------------------------------------------------|----------------------------------------------------|--------------------------------------------------------------------------|
| `every entity must be flagged as authorization master or dependent`| Missing `authorization` line                       | Add the master/dependent line per entity.                                |
| `every entity must be flagged either as lock master or lock dependent`| Missing `lock` on a child                       | Add `lock dependent by _Root` on each child.                             |
| `There is no draft persistency specified`                         | Missing `draft table` on a child                   | Add `draft table z##_<child>_d` to the child entity header.              |
| `there must be an explicit definition of the draft action Discard`| Missing draft action                               | Add `draft action Discard;` on the root.                                 |
| 40+ mapping warnings                                              | `mapping for … corresponding`                      | Replace with explicit `{ Alias = column; … }` mapping.                   |
| `should be flagged as numbering:managed`                          | UUID key missing managed numbering                 | `field ( numbering : managed, readonly ) <Key>;`                         |
| `uses an obsolete implementation`                                 | Cross-BO assoc without `with cross associations`   | Add `with cross associations;` to the BDEF header.                       |
