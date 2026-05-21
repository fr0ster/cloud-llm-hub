---
name: Creating a Service Binding
description: Rules for creating and publishing the OData service binding that exposes a service definition to consumers (Fiori Elements UI or Web API)
tags: [sap, rap, service-binding, odata]
---

# Creating a Service Binding

The service binding is what makes the OData endpoint reachable. It wraps a service
definition with a binding variant (UI vs Web API, V4 vs V2) and a publication flag.

## Binding variants

Pass `binding_variant` explicitly:

| Variant              | When                                                |
|----------------------|-----------------------------------------------------|
| `ODATA_V4_UI`        | Fiori Elements consumer (default)                   |
| `ODATA_V4_WEB_API`   | Programmatic V4 client                              |
| `ODATA_V2_UI`        | Legacy Fiori (V2)                                   |
| `ODATA_V2_WEB_API`   | Legacy V2 programmatic                              |

If the parameter is omitted the binding is created as `ODATA_V4_UI` (since
`core@5.2.0` + `adt-clients@5.0.0`). Older client versions silently created a Web API
binding — explicit is safer.

## Rules

- Activate the binding after creation.
- **Publish separately.** Activation does not auto-publish. Run
  `PublishServiceBinding` once activation succeeds.
- The underlying service definition must be active first.

## Common error fix

| Error                              | Cause                                          | Fix                                                                  |
|------------------------------------|------------------------------------------------|----------------------------------------------------------------------|
| Created as Web API by mistake      | `binding_variant` omitted on old client        | Re-create with explicit `ODATA_V4_UI`.                               |
| `service definition not active`    | Definition skipped                             | Activate the service definition first.                               |
| Binding active but unreachable     | Not published                                  | Run `PublishServiceBinding`.                                         |
| `Service plan extended not found`  | Wrong subaccount / wrong AI Core binding (deploy concern, not RAP) | Out of scope — handled by the deploy team. |
