---
type: standard
tags: [rap, cds, abap, standard]
system: all
---

# MOCK Corp — RAP Development Standard

Standard for building RAP business objects in MOCK Corp S/4HANA landscape.

## Scope

All new transactional developments SHALL use RAP. New classical transactions (SE93 + SAPGUI dynpro) are prohibited except for technical tools.

## Mandatory Components

Every RAP BO MUST include:

1. Persistent table with UUID primary key (`sysuuid_x16`).
2. Draft table (for editable BOs).
3. Interface view (R-type) with `@ObjectModel.dataCategory`.
4. Projection view (C-type) with `@UI` annotations.
5. Interface BDEF with field validations and determinations.
6. Behavior implementation class (BIMP).
7. Projection BDEF with draft actions (if applicable).
8. Service definition exposing projection.
9. Service binding (OData V4 UI).

## Managed vs Unmanaged

- Managed is the default. Use for net-new entities with no legacy persistence.
- Unmanaged allowed only when wrapping legacy function modules or non-RAP persistence. Requires architecture review.

## Determinations

- Use `determination on save` for derived fields.
- Use `determination on modify` only when the UI must reflect the value before save.
- Expensive determinations must run in background action (`action (features) process`).

## Validations

- One validation per business rule.
- Validation message text MUST come from message class `ZMOCK_RAP_COMMON`.
- Validation MUST NOT perform database updates.

## Authorization

- Declarative authorization via `authorization master (global, instance)`.
- Implementation in BIMP method `get_instance_authorizations` / `get_global_authorizations`.
- Roles in MOCK-Corp XSUAA role collections: `ZMOCK_RAP_USER`, `ZMOCK_RAP_ADMIN`.

## Testing

- Unit tests for every BIMP method using the RAP test double framework.
- Integration test covering the full CRUD cycle through OData.
- Coverage target: 70% on BIMP, 50% overall.

## See Also
- [tutorials/skills/rap-bo-creation.md](../../../tutorials/skills/rap-bo-creation.md)
- [support-cases/MOCK-SC-002-draft-table-missing.md](../support-cases/MOCK-SC-002-draft-table-missing.md)
