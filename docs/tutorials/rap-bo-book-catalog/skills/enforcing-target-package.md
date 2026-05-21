---
name: Enforcing the Target Package
description: Hard rule that every Create call carries the user's package — never silent fallback to $TMP
tags: [sap, package, governance]
---

# Enforcing the Target Package

Every ABAP object created must live in the package the user specified. Silent fallback
to `$TMP` scatters objects across packages and breaks the deployment story.

## Hard rules

- **Never create in `$TMP` unless the user literally said so.** If a `Create…` call
  fails because the target package lacks an open transport or is locked, **report the
  error and stop**. Do not retry in `$TMP`.
- **Every `Create…` call carries the target package parameter.** If the user's prompt
  omits the package, ask before creating.
- **Verify after batch creation.** Run `SearchObject` with `package=<TARGET>` and
  confirm the result matches the just-created list exactly — no stray objects, no
  silently moved ones.

## Local-system packages

On on-premise systems, packages starting with `TEST_` or `$` use the `LOCAL` software
component. Pass `software component LOCAL` explicitly on the create call — the LLM
often omits it and creation silently fails or falls back.

## Common error fix

| Error                                         | Cause                                              | Fix                                                                  |
|-----------------------------------------------|----------------------------------------------------|----------------------------------------------------------------------|
| `request package not in transport list`       | No open transport for target package               | Stop; ask the user to open a transport. Do not retry in `$TMP`.      |
| Objects landed in `$TMP`                      | Transport error + silent retry                     | Move the objects via SE80; remove the `$TMP` copies.                 |
| `Software component invalid`                  | Local package created without `software component LOCAL` | Pass the parameter explicitly.                                  |
