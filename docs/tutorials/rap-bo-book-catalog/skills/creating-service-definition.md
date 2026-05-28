---
name: creating-service-definition
description: 'Service definition rules — the manifest listing projection CDS views in the OData service. Shape: `@EndUserText.label: ''<Service label>'' define service Z##_<SERVICE_NAME> { expose Z##_C_<ROOT> as <RootAlias>; expose Z##_C_<CHILD> as <ChildAlias>; }`. One `expose ... as ...` per projection view that should appear in the service. The alias is the entity name in the OData metadata — pick stable semantic names (Material, Plant) not internal technical names (Z##_C_MAT_ROOT). All projection views referenced must be ACTIVE before activating the service definition. Activate with ActivateObjects filtered by the project prefix (Z##_*).'
---
