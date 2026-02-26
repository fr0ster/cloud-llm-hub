# MCP Header Matrix

This note documents which HTTP headers the Cline MCP settings expect in each supported scenario and where the automation can source their values. It is intended to accompany the YAML playbooks produced by `tools/update-cline-connection.js` (YAML mode).

## Service-Key Aliases in Templates

| Alias            | Purpose                                        | Default Resolver                                 |
| ---------------- | ---------------------------------------------- | ------------------------------------------------ |
| `mcp-xsuaa`      | MCP proxy access token (JWT)                   | `cf service-key cloud-llm-hub-auth mcp`          |
| `mcp-xsuaa-file` | Same as above, but read from a local JSON file | `./keys/mcp-xsuaa.json`                          |
| `sap-abap`       | SAP OAuth client for minting ABAP JWTs         | `cf service-key sap-backend-auth abap`           |
| `sap-abap-file`  | Offline copy of the SAP OAuth client key       | `./keys/sap-abap.json`                           |
| `destination`    | SAP Destination service binding                | `cf service-key cloud-llm-hub-destination cline` |

These aliases can be remapped or removed; keep only those actually referenced by your playbook.

## Core Scenarios (Essentials)

The sections below list the minimum YAML keys and the headers they populate for the four core scenarios. The MCP endpoint always comes from `definition.endpoint` and is **not** mirrored into headers; the ABAP endpoint is persisted via `X-SAP-URL`.

### 1. Direct → ABAP (basic) & MCP (basic)

- `definition.endpoint` → MCP URL stored in `cline_mcp_settings.json`.
- `sap.url` → header `X-SAP-URL`.
- `sap.client` → header `X-SAP-Client`.
- `sap.auth.type: basic` → header `X-SAP-Auth-Type: basic`.
- `sap.auth.username` → header `X-SAP-Username`.
- `sap.auth.password` → header `X-SAP-Password`.
- `mcp.auth.username` + `mcp.auth.password` → `Authorization: Basic <base64>`.

### 2. Direct → ABAP (JWT) & MCP (basic)

- `definition.endpoint` → MCP URL.
- `sap.url` → `X-SAP-URL`.
- `sap.client` → `X-SAP-Client`.
- `sap.auth.type: jwt` → `X-SAP-Auth-Type: jwt`.
- `sap.auth.token` → `X-SAP-JWT-Token` (source: service key, file, or command).
- `mcp.auth.username` + `mcp.auth.password` → `Authorization: Basic <base64>`.

### 3. Cloud Destination (internet or on-prem)

- `definition.endpoint` → MCP URL.
- `sap.destinationName` → `X-SAP-Destination`.
- `sap.connectivity.mode: internet` (optional) → `X-SAP-Connectivity-Mode: internet`.
- `sap.connectivity.mode: onprem` → `X-SAP-Connectivity-Mode: onprem`.
- `sap.connectivity.locationId` (optional) → `X-SAP-Connectivity-Location-Id`.
- `mcp.auth.token` → `Authorization: Bearer <token>`.
- `sap-abap`/`sap-abap-file` service key aliases — include only when the Destination requires ABAP-issued JWTs.
- Direct SAP fields (`sap.url`, `sap.auth.*`) are **not** used in this scenario; the script drops the matching headers automatically.

### 5. Cloud Destination with NoAuthentication + credential override

- `definition.endpoint` → MCP URL.
- `sap.destinationName` → `X-SAP-Destination`.
- `sap.login` → header `X-SAP-Login` (required for NoAuthentication destinations).
- `sap.password` → header `X-SAP-Password` (required for NoAuthentication destinations).
- `mcp.auth.token` → `Authorization: Bearer <token>`.
- The destination itself has no credentials; authentication is provided entirely by the caller via `x-sap-login` / `x-sap-password` headers.
- These headers also work with `BasicAuthentication` destinations to override destination-configured credentials.

### 4. Cloud Direct (internet)

- `definition.endpoint` → MCP URL.
- `sap.url` → `X-SAP-URL`.
- `sap.client` → `X-SAP-Client`.
- `sap.auth.type: jwt` → `X-SAP-Auth-Type: jwt`.
- `sap.auth.token` → `X-SAP-JWT-Token`.
- `mcp.auth.token` → `Authorization: Bearer <token>`.
- `sap-abap-file`/`mcp-xsuaa-file` — use only when local copies of the service keys are needed.

Additional headers (tracing, custom flags, and so on) are injected only via the `headers` block in YAML.

## Direct SAP (JWT)

Applies to `direct-jwt.yaml` and the `cloud-internet` template when `sap.auth.type: jwt`.

| Header              | Required    | Populated With       | Source                                                                           |
| ------------------- | ----------- | -------------------- | -------------------------------------------------------------------------------- |
| `x-sap-url`         | Yes         | SAP endpoint         | Literal `sap.url` value in YAML                                                  |
| `x-sap-client`      | Yes         | SAP client number    | Literal `sap.client`                                                             |
| `x-sap-auth-type`   | Yes         | `jwt`                | Derived from `sap.auth.type`                                                     |
| `x-sap-jwt-token`   | Yes         | Bearer token for SAP | `sap.auth.token` (e.g. `serviceKey` → `sap-abap.credentials.jwt`, file, command) |
| `authorization`     | Yes (proxy) | `Bearer <token>`     | `mcp.auth` (typically `serviceKey` → `mcp-xsuaa.access_token`)                   |
| `x-sap-username`    | No          | _Removed_            | Script clears to avoid mixing auth modes                                         |
| `x-sap-password`    | No          | _Removed_            | Script clears to avoid mixing auth modes                                         |
| Destination headers | No          | _Removed_            | `x-sap-destination`, `x-sap-connectivity-*` cleared automatically                |

## Direct SAP (Basic)

Applies to `direct-basic.yaml` (or any `sap.auth.type: basic`).

| Header              | Required    | Populated With          | Source                                 |
| ------------------- | ----------- | ----------------------- | -------------------------------------- |
| `x-sap-url`         | Yes         | SAP endpoint            | Literal `sap.url`                      |
| `x-sap-client`      | Yes         | SAP client number       | Literal `sap.client`                   |
| `x-sap-auth-type`   | Yes         | `basic`                 | Derived from `sap.auth.type`           |
| `x-sap-username`    | Yes         | Technical user name     | `sap.auth.username` (env, const, etc.) |
| `x-sap-password`    | Yes         | Technical user password | `sap.auth.password`                    |
| `authorization`     | Yes (proxy) | `Basic <base64>`        | `mcp.auth` with username/password      |
| `x-sap-jwt-token`   | No          | _Removed_               | Script clears JWT header               |
| Destination headers | No          | _Removed_               | Script clears all destination headers  |

## Destination (Internet)

Applies to the cloud destination template when no Connectivity location ID is provided.

| Header                           | Required    | Populated With             | Source                                                              |
| -------------------------------- | ----------- | -------------------------- | ------------------------------------------------------------------- |
| `x-sap-destination`              | Yes         | Destination name           | `sap.destinationName`                                               |
| `x-sap-connectivity-mode`        | Optional    | `internet`                 | Only set when `sap.connectivity.mode` is declared                   |
| `x-sap-connectivity-location-id` | No          | _Removed_                  | Not needed for pure internet destinations                           |
| `x-sap-login`                    | Conditional | SAP username               | Required when destination uses `NoAuthentication`; optional override for `BasicAuthentication` |
| `x-sap-password`                 | Conditional | SAP password               | Required when destination uses `NoAuthentication`; optional override for `BasicAuthentication` |
| `authorization`                  | Yes (proxy) | Typically `Bearer <token>` | `mcp.auth` (e.g. `serviceKey` → `mcp-xsuaa.access_token`)           |
| Direct SAP headers               | No          | _Removed_                  | `x-sap-url`, `x-sap-client`, `x-sap-auth-type`, credentials cleared |
| Custom headers                   | Optional    | e.g. tracing flags         | `headers` block (const/env/serviceKey)                              |

## Destination (On-Premise / Connectivity)

Applies when `sap.connectivity.mode: onprem` or a Connectivity location ID is supplied (cloud destination template default).

| Header                           | Required    | Populated With              | Source                                                                      |
| -------------------------------- | ----------- | --------------------------- | --------------------------------------------------------------------------- |
| `x-sap-destination`              | Yes         | Destination name            | `sap.destinationName`                                                       |
| `x-sap-connectivity-mode`        | Yes         | `onprem`                    | Derived from `sap.connectivity.mode` or inferred when `locationId` provided |
| `x-sap-connectivity-location-id` | Optional    | Cloud Connector location ID | `sap.connectivity.locationId`                                               |
| `authorization`                  | Yes (proxy) | Typically `Bearer <token>`  | `mcp.auth` definition                                                       |
| Direct SAP headers               | No          | _Removed_                   | Script clears direct URL/auth headers                                       |
| Custom headers                   | Optional    | e.g. `x-scenario`           | `headers` block (const/env/serviceKey)                                      |

## MCP Authentication Header Options

Regardless of SAP mode, `mcp.auth` controls the `Authorization` header:

| `mcp.auth.type`  | Resulting Header                | Value Source                                         |
| ---------------- | ------------------------------- | ---------------------------------------------------- |
| `bearer` / `jwt` | `Authorization: Bearer <token>` | `mcp.auth.token` (service key, file, command, const) |
| `basic`          | `Authorization: Basic <base64>` | `mcp.auth.username` and `mcp.auth.password`          |
| `header`         | Custom header value             | `mcp.auth.header` (exact string injected)            |
| `none`           | Removes header                  | Useful for anonymous endpoints                       |

The script never auto-generates refresh tokens; supply them via the configured source each time.

## Custom Header Notes

- Any entry under `headers:` in the YAML playbook maps to an HTTP header of the same name. Values can come from the same source types (`serviceKey`, `file`, `env`, `command`, `const`).
- Use `null` to delete an existing header.
- Direct and destination header groups are mutually exclusive; the orchestrator will throw if both sets are configured.
