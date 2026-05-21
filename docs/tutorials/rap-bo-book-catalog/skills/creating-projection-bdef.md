---
name: Creating a Projection Behavior Definition
description: Rules for the projection BDEF that exposes the interface BDEF over OData with draft support
tags: [sap, rap, bdef, projection]
---

# Creating a Projection Behavior Definition

The projection BDEF is the thin layer on top of the interface BDEF that picks which
operations are exposed in the OData service.

## Shape

```bdef
projection;
strict ( 2 );
use draft;

define behavior for Z##_C_<ROOT> alias <RootAlias>
{
  use create;
  use update;
  use delete;

  use association _Plant { create; with draft; }
  use association _Sales { create; with draft; }
  ...
}

define behavior for Z##_C_<CHILD> alias <ChildAlias>
{
  use update;
  use delete;

  use association _Root { with draft; }
}
```

## Rules

- Header: `projection;` `strict ( 2 );` `use draft;` — required for a strict-mode
  managed BO with draft.
- Root entity: `use create; use update; use delete;` and a `use association` per
  composition (with `create;` if the parent should be allowed to create the child via
  the association, plus `with draft;` for draft-enabled compositions).
- Child entities: usually `use update; use delete;` (no `use create;` — creation goes
  via the parent association). Back-association to root with `with draft;`.
- Activate the projection BDEF after the interface BDEF + BIMP are active.

## Common error fix

| Error                                        | Cause                                            | Fix                                                                  |
|----------------------------------------------|--------------------------------------------------|----------------------------------------------------------------------|
| `behavior is not defined for view`          | Interface BDEF not active                         | Activate interface BDEF + BIMP first.                                |
| `child creation through projection blocked` | Missing `use association … { create; }` on root | Add `create;` inside the `use association _<Child>` block.           |
| Draft not visible in association             | Missing `with draft;`                            | Add `with draft;` on the association.                                |
