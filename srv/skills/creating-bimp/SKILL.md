---
name: creating-bimp
description: Create the behavior implementation class (BIMP) for a RAP interface BDEF — an empty global ABSTRACT FINAL class plus a local-types handler class that implements instance authorization on the composition root
---

# Creating a behavior implementation class (BIMP)

The BIMP is the ABAP class the interface BDEF's `managed implementation in class ... unique;`
points at. It is deliberately thin: the global class stays empty, and the actual logic lives in
a local handler class inside it.

## The rule

- **Global class**: `PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF <Z_I_Root>`, empty implementation.
  Don't put logic here — it exists only as the anchor the BDEF references.
- **Local handler class**: `INHERITING FROM cl_abap_behavior_handler`, declared in the class's
  local types (not a separate global class). This is where instance authorization and any
  determinations/validations for the object go.
- **Instance authorization** (`FOR INSTANCE AUTHORIZATION ... FOR <alias> RESULT result`) is
  implemented on the **root** entity, using `READ ENTITIES ... IN LOCAL MODE` to fetch the keys
  and `APPEND VALUE #( %tky = ... %update = if_abap_behv=>auth-allowed ... ) TO result` per
  instance. This only applies if the BDEF declared `authorization master ( instance )` — see
  creating-bdef.
- One BIMP per interface BDEF; a composed child's checks are typically reached through the root's
  handler, not a separate BIMP.

## Shape

```abap
CLASS <zbp_i_root> DEFINITION
  PUBLIC
  ABSTRACT
  FINAL FOR BEHAVIOR OF <z_i_root>.
ENDCLASS.

CLASS <zbp_i_root> IMPLEMENTATION.
ENDCLASS.
```

```abap
CLASS lhc_root DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR root RESULT result.
ENDCLASS.

CLASS lhc_root IMPLEMENTATION.
  METHOD get_instance_authorizations.
    READ ENTITIES OF <z_i_root> IN LOCAL MODE
      ENTITY root
      FIELDS ( RootUuid )
      WITH CORRESPONDING #( keys )
      RESULT DATA(roots)
      FAILED failed.

    LOOP AT roots INTO DATA(root).
      APPEND VALUE #(
        %tky = root-%tky
        %update = if_abap_behv=>auth-allowed
        %delete = if_abap_behv=>auth-allowed
      ) TO result.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
```

(Names above are an illustration from one sample object — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| BDEF activation fails "implementing class not found" | Create and activate the BIMP class after the interface BDEF |
| All instances read-only despite `authorization master ( instance )` | Handler class never grants `%update`/`%delete` — implement `get_instance_authorizations` instead of leaving it a stub |
