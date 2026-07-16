---
name: creating-service-definition
description: Create the service definition that exposes a RAP business object's projection CDS views under stable OData entity aliases, ready for a service binding to publish
---

# Creating a service definition

The service definition is the OData contract: it names, under a stable entity alias, every
projection view the consuming app is allowed to reach.

## The rule

- `expose <Z_C_Entity> as <Alias>;` — one line per projection view, root and children alike. The
  alias is the OData entity set name the UI/consumer sees; keep it stable once published, since
  renaming it is a breaking change for consumers.
- Expose every projection view the object graph needs, including composed children — a child
  left out of the service definition is unreachable from the service even if its projection BDEF
  allows the operation.
- The service definition references **projection** views (`C_` layer), never interface views
  directly.

## Shape

```abap
@EndUserText.label: '<service label>'
define service <Z_UI_SERVICE> {
  expose <Z_C_Root> as <RootAlias>;
  expose <Z_C_Child> as <ChildAlias>;
}
```

(Names above are an illustration from one sample object — apply the rule, not the names. The
service/alias names themselves follow the project's naming policy.)

## Common mistake

| Symptom | Fix |
|---|---|
| Child entity set missing from the OData metadata | Add its `expose <Z_C_Child> as <Alias>;` line |
| Service binding shows no entities | The service definition wasn't activated, or exposes zero projection views |
