---
name: Creating a Service Definition
description: Rules for the service definition that lists which projection views are exposed in the OData service
tags: [sap, rap, service, odata]
---

# Creating a Service Definition

The service definition is a thin manifest that lists which projection CDS views go into
the OData service and under which entity name.

## Shape

```ddl
@EndUserText.label: '<Service label>'
define service Z##_<SERVICE_NAME>
{
  expose Z##_C_<ROOT>  as <RootAlias>;
  expose Z##_C_<CHILD> as <ChildAlias>;
}
```

## Rules

- One `expose ... as ...` per projection view that should appear in the service.
- The alias is the entity name as it will appear in the OData metadata; pick stable,
  semantic names (`Material`, `Plant`, not `Z##_C_MAT_ROOT`).
- All projection views referenced must be active before the service definition is
  activated.
- Activate the service definition with `ActivateObjects` filtered by the prefix
  (`Z##_*`).

## Common error fix

| Error                                  | Cause                                | Fix                                                          |
|----------------------------------------|--------------------------------------|--------------------------------------------------------------|
| `entity name conflict`                | Two `expose` use the same alias      | Pick distinct aliases.                                       |
| `view not active`                     | Projection layer not activated       | Activate `Z##_C_*` first, retry.                             |
| Service exists but cannot be bound    | Service not activated                | Run activate; verify with read-back.                         |
