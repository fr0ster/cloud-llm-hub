---
name: creating-projection-bdef
description: Create the projection behavior definition (BDEF) for a RAP business object root or child entity — strict(2), use draft, and which create/update/delete/draft actions and associations each entity exposes to the service consumer
---

# Creating a projection behavior definition (BDEF)

The projection BDEF (`projection;`) sits on the projection CDS view and exposes a subset of the
interface BDEF's capabilities to the OData service. It doesn't repeat the interface BDEF's
mapping/lock/authorization rules — it only decides what's `use`d.

## The rule

- `strict ( 2 ); use draft;` at the top, same strict level as the interface BDEF.
- On the **root** entity: `use create; use update; use delete;` plus all five draft actions —
  `use action Edit; use action Activate; use action Discard; use action Resume;
  use action Prepare;` — and `use association _Child { create; with draft; }` for each
  composition/association the UI needs to navigate or create through.
- On a **composed child** entity: typically `use update; use delete;` and
  `use association _Root { with draft; }` — no draft actions on a child, they only exist on the
  root.
- Only expose what the consumer actually needs; an operation not `use`d here is unreachable via
  the service even if the interface BDEF allows it.

## Shape

```abap
projection;
strict ( 2 );
use draft;

define behavior for <Z_C_Root> alias Root
{
  use create;
  use update;
  use delete;

  use action Edit;
  use action Activate;
  use action Discard;
  use action Resume;
  use action Prepare;

  use association _Child { create; with draft; }
}

define behavior for <Z_C_Child> alias Child
{
  use update;
  use delete;

  use association _Root { with draft; }
}
```

(Names above are an illustration from one sample object — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| UI can't create a child under the parent | `use association _Child { create; with draft; }` missing on the root |
| Draft edit action not offered in the UI | One of the five `use action` draft actions missing on the root |
