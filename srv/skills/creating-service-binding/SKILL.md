---
name: creating-service-binding
description: Create the service binding for a RAP business object's service definition — pick an explicit OData protocol variant (V2/V4, UI/A2X), then publish it so the Fiori app or client can reach the service endpoint
---

# Creating a service binding

The service binding turns a service definition into a runnable OData endpoint. It is a separate
object with its own activation and publish step.

## The rule

- Point it at exactly one service definition.
- Choose the binding type explicitly — protocol (OData V2 vs V4) and usage (UI vs A2X/API). For
  a Fiori Elements app this is normally **OData V4 - UI**; don't leave it at a default without
  confirming that's what the consumer needs.
- Activation alone doesn't expose the endpoint — after activating, **publish** the service from
  the binding. An activated-but-unpublished binding has no reachable OData path yet.

## Shape

```
Service Binding Name: <Z_UI_SERVICE_O4>
Binding Type: OData V4 - UI
Service Definition: <Z_UI_SERVICE>
```

Then: activate the binding, then publish it, then verify the endpoint responds (e.g. preview the
Fiori app or GET the service document).

(Names above are an illustration from one sample object — apply the rule, not the names.)

## Common mistake

| Symptom | Fix |
|---|---|
| Fiori preview shows "service not found" | Binding was activated but never published |
| Entities missing from the service document | The service definition it points at doesn't expose them — fix the service definition, not the binding |
