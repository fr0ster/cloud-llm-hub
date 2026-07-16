---
name: creating-bdef
description: Create the interface behavior definition (BDEF) for a RAP business object root or child entity — strict(2), draft, lock master/dependent and authorization, all five draft actions on the root, and explicit per-field mapping instead of corresponding
---

# Creating an interface behavior definition (BDEF)

The interface BDEF (`managed implementation in class <BIMP> unique;`) declares the runtime
behavior over the interface CDS view: draft handling, locking, authorization, and how CDS
elements map onto table fields. `strict ( 2 )` is the current strict level and fails activation
if any of the following is missing.

## What strict(2) requires

- **Explicit field mapping**: `mapping for <ztable> { CdsAlias = table_field; ... }`, one line
  per field. The `corresponding` shortcut produces mapping warnings/errors under strict — always
  write it out.
- **All five draft actions**, but only on the composition **root**: `draft action Edit;
  draft action Activate optimized; draft action Discard; draft action Resume;
  draft determine action Prepare;`. A missing one (often `Discard` or `Prepare`) fails
  activation.
- **Lock and authorization, root vs child**: the root gets
  `lock master total etag LastChangedAt` and, if instance authorization is needed,
  `authorization master ( instance )`. A composed child gets `lock dependent by <_Parent>` and
  `authorization dependent by <_Parent>` — never its own `lock master` (see
  composition-vs-association).
- **Draft table key parity**: the draft table's keys must match the persistent table's keys, not
  just `mandt + uuid`.

## Shape (root)

```abap
managed implementation in class <zbp_i_root> unique;
strict ( 2 );
with draft;

define behavior for <Z_I_Root> alias Root
persistent table <ztable>
draft table <ztable_d>
etag master LocalLastChangedAt
lock master total etag LastChangedAt
authorization master ( instance )
{
  field ( readonly ) RootUuid, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt;
  field ( mandatory ) <required business field>;

  create; update; delete;

  draft action Edit;
  draft action Activate optimized;
  draft action Discard;
  draft action Resume;
  draft determine action Prepare;

  association _Child { create; with draft; }

  mapping for <ztable>
  {
    RootUuid = <obj>_uuid;
    <CdsAlias> = <table_field>;
  }
}
```

## Shape (composed child)

```abap
define behavior for <Z_I_Child> alias Child
persistent table <ztable_child>
draft table <ztable_child_d>
etag master LocalLastChangedAt
lock dependent by _Root
authorization dependent by _Root
{
  field ( readonly ) ChildUuid, RootUuid, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt;

  update; delete;

  association _Root { with draft; }

  mapping for <ztable_child>
  {
    ChildUuid = <obj>_uuid;
    RootUuid = <parent>_uuid;
    <CdsAlias> = <table_field>;
  }
}
```

(Names above are an illustration from one sample object — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| 40+ "mapping for ... corresponding" warnings | Switch from `corresponding` to explicit `{ CdsAlias = table_field; }` |
| Activation fails: missing draft action | Add the missing one of the five (often `Discard`) |
| Child has its own `lock master` | Composed children take `lock dependent by <_Parent>`, never `lock master` |
