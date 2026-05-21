---
name: Creating a Behavior Implementation Class (BIMP)
description: Rules for the BIMP global class plus its local-types (CCIMP) handler for a managed RAP BO with instance authorization
tags: [sap, rap, bimp, abap]
---

# Creating a Behavior Implementation Class (BIMP)

The BIMP is the ABAP class referenced by the BDEF. Its **global class body** is the
standard generated skeleton — empty. The real handler logic lives in the **local
types** (CCIMP include).

## Global class skeleton

```abap
CLASS z##_bp_r_<root_alias> DEFINITION
    PUBLIC ABSTRACT FINAL
    FOR BEHAVIOR OF z##_r_<root_alias>.
ENDCLASS.

CLASS z##_bp_r_<root_alias> IMPLEMENTATION.
ENDCLASS.
```

No handler methods on the global class. Only the abstract declaration.

## Local types (CCIMP) — required for `authorization master ( instance )`

For managed scenarios with instance authorization on the root entity, the local types
must contain at least an empty `get_instance_authorizations` handler:

```abap
CLASS lhc_<RootAlias> DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR <RootAlias>
      RESULT result.
ENDCLASS.

CLASS lhc_<RootAlias> IMPLEMENTATION.
  METHOD get_instance_authorizations.
    " framework handles CRUD; this method can stay empty for initial setup
  ENDMETHOD.
ENDCLASS.
```

- `<RootAlias>` is the BDEF root alias (e.g. `MaterialRoot`), not the technical entity
  name.
- The body can be empty — the framework handles standard CRUD.
- Child entities (with `lock dependent` / `authorization dependent`) **do not need**
  their own handler classes — they inherit from the master.

## Activation

BDEF and BIMP have a circular dependency. Create both, then activate them together via
`ActivateBehaviorDefinition` — see `activating-objects` skill.

## Common error fix

| Error                                          | Cause                                         | Fix                                                                |
|------------------------------------------------|-----------------------------------------------|--------------------------------------------------------------------|
| Missing handler for instance authorization     | Local types empty                             | Add `lhc_<RootAlias>` with `get_instance_authorizations` method.   |
| Activation fails with cross-reference error    | BDEF and BIMP activated one-by-one            | Activate both via a single `ActivateBehaviorDefinition` call.      |
| Child entity rejected by activation            | Handler class created for a child             | Remove child handler — children inherit from the master.           |
