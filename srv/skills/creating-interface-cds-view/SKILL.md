---
name: creating-interface-cds-view
description: Create the interface (R-type) CDS view for a RAP business object over its persistent table — root vs child view, composition for owned children vs association for referenced BOs, and why linked views must be created and activated together as one group
---

# Creating an interface CDS view

The interface view (`I_` layer) sits directly on the persistent table and defines the
composition/association graph other layers build on.

## The rule

- `define root view entity` for the composition root; a plain `define view entity` with
  `association to parent` for a composed child.
- **Composition** for owned children (`composition [0..*] of <Child> as _Child`), **association**
  for references to an independent BO (`association [0..1] to <Other> as _Other on ...`). See
  composition-vs-association: this choice drives the lock/authorization model built later in the
  BDEF, so get it right here.
- Expose every association/composition the BDEF will need — mark the source field of
  `@Semantics.text: true` where a related object's name should read as this entity's display
  text (e.g. an author's name shown while browsing books).
- **Group creation and activation.** A view that references another (association or
  composition) cannot activate alone if the target doesn't exist yet. Create and activate all
  interface views of one object graph together, not one at a time.

## Shape

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: '<label>'
define root view entity <Z_I_Root>
  as select from <ztable> as Root
  association [0..1] to <Z_I_Other> as _Other
    on $projection.OtherUuid = _Other.OtherUuid
  composition [0..*] of <Z_I_Child> as _Child
{
  key <root>_uuid as RootUuid,
      ...
      _Other,
      _Child
}
```

(Names above are an illustration from one sample object graph — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| Activation fails: unknown entity `_Child`/`_Other` | The referenced view wasn't created/activated yet — group-activate the whole graph |
| Child has its own `lock master` | Composed children are never independent roots — see composition-vs-association |
