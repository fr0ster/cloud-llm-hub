# MCP Config Update How-To

This guide explains how to refresh Cline's MCP connection settings using the automation scripts that ship with **cloud-llm-hub**. Two variants are available:

- `scripts/update-cline-connection.js` — intended to be executed inside this repository. It understands the project layout, reuses `.env` defaults, and can trigger the ABAP token helper.
- `scripts/update-cline-connection-standalone.js` — a portable CLI that accepts explicit parameters and can be copied into any workspace together with your `cline_mcp_settings.json` file.

Both CLIs update the JSON document in-place and only touch the headers for the requested MCP connection. Use `--dry-run` to review the resulting payload without saving anything.

## 1. Repository Script (`update-cline-connection.js`)

```bash
# refresh the "sap-dev" connection using repository defaults
node scripts/update-cline-connection.js --connection sap-dev

# same command via npm alias
npm run update:cline -- --connection sap-dev
```

Key capabilities:

- Reads the Cline settings file from the default location (`~/.config/Code/User/.../cline_mcp_settings.json`) unless you override `--settings <path>`.
- Loads SAP credentials from `submodules/mcp-abap-adt/.env` (or `./.env` fallback) and can refresh the JWT using `--service-key <xsuaa-key.json>`.
- Supports MCP-side authentication overrides via `--mcp-*` switches (basic, bearer, or direct header injection).
- Adds destination headers when you call `--destination-name <DEST>` to route traffic through SAP BTP Destination service. Combine with `--connectivity-mode onprem` and `--connectivity-location-id <ID>` if the destination uses Cloud Connector.

### Frequently Used Options

| Option | Purpose |
| --- | --- |
| `--connection <name>` | Connection key in `cline_mcp_settings.json` (required). |
| `--env <path>` | Explicit `.env` file with SAP credentials. |
| `--service-key <path>` | Generates a fresh SAP JWT via `sap-abap-auth-browser`. |
| `--sap-token <token>` | Inline SAP JWT instead of reading `.env`. |
| `--destination-name <name>` | Enables destination routing (removes direct URL headers). |
| `--connectivity-mode onprem` | Instructs the proxy to use the Connectivity service for an on-prem destination. |
| `--mcp-token <jwt>` | Sets MCP-side bearer auth (`Authorization: Bearer ...`). |
| `--dry-run` | Preview changes without saving. |

> **Note:** When `--destination-name` is supplied the script will drop the direct `X-SAP-URL` / `X-SAP-JWT-TOKEN` headers and rely on the Destination service at runtime. This keeps the stored settings free from short-lived tokens.

## 2. Portable Script (`update-cline-connection-standalone.js`)

Use this variant when you need to refresh an MCP profile from outside the repository (for example on a jump host or inside CI).

```bash
# copy the script somewhere convenient
cp scripts/update-cline-connection-standalone.js ~/tmp/mcp-update/

# run it with explicit parameters
node update-cline-connection-standalone.js \
  --settings /path/to/cline_mcp_settings.json \
  --connection sap-dev \
  --sap-url https://my.s4hana.example.com \
  --sap-auth-type jwt \
  --sap-token "<ABAP JWT>"
```

Standalone-only characteristics:

- Requires `--settings` and does **not** assume any project-relative paths.
- Accepts SAP credentials directly by CLI flags. Supply either `--sap-token` (JWT) or `--sap-username/--sap-password` (basic).
- Uses the same MCP authentication switches as the repository script.
- Supports destination headers via `--destination-name`, `--connectivity-mode`, and `--connectivity-location-id`.
- When executed from the repository you can call `npm run update:cline:standalone -- <args>` instead of invoking `node` manually.

When combining the standalone script with destinations you typically obtain the destination name and (optionally) the Cloud Connector location ID from your SAP BTP cockpit. Tokens are resolved later by the CAP service, so no additional credentials are required in the settings file.

## 3. Example Scenarios

### Refresh SAP JWT from Service Key and Update the MCP Token

```bash
node scripts/update-cline-connection.js \
  --connection sap-dev \
  --service-key submodules/mcp-abap-adt/service-key.json \
  --mcp-token "<mcp-proxy-jwt>"
```

1. The script runs `sap-abap-auth-browser.js` to mint a new JWT and stores it in the `.env` file.
2. The refreshed token is injected into the selected Cline connection.
3. The MCP-side JWT header gets overwritten with the provided value.

### Switch to Destination-Based Routing (On-Premise)

```bash
node scripts/update-cline-connection.js \
  --connection sap-qa \
  --destination-name SAP_QA_ONPREM \
  --connectivity-mode onprem \
  --connectivity-location-id CC-PRD
```

- Removes direct SAP URL/JWT headers.
- Adds `X-SAP-Destination`, `X-SAP-Connectivity-Mode: onprem`, and `X-SAP-Connectivity-Location-Id: CC-PRD`.
- Leaves MCP auth untouched.

### Fully Offline Update with the Standalone Script

```bash
node scripts/update-cline-connection-standalone.js \
  --settings ~/.cline/settings/cline_mcp_settings.json \
  --connection sap-dev \
  --sap-url https://my.s4hana.example.com \
  --sap-client 100 \
  --sap-auth-type basic \
  --sap-username ABAP_USER \
  --sap-password "<secret>" \
  --mcp-auth-type basic \
  --mcp-username hub-user \
  --mcp-password "<another-secret>"
```

The script injects the SAP basic credentials and the MCP basic credentials without reading any repository metadata.

## 4. Troubleshooting

- **"Connection not found"** — Verify the key exists under `mcpServers` in `cline_mcp_settings.json`. Use `jq '.mcpServers | keys'` to list them quickly.
- **JWT expired warnings** — When using the repository script, re-run with `--service-key` or pass a fresh token via `--sap-token`.
- **Destination header set but calls still use direct URL** — Ensure the CAP service has an active Destination binding and restart the service (destination cache is in-memory).
- **On-premise destination access fails** — Double-check that `--connectivity-mode onprem` is present and that the Cloud Connector location ID matches the configured destination.

## 5. Related References

- [`docs/MCP_PROXY_USAGE.md`](./MCP_PROXY_USAGE.md) — End-to-end usage guide covering SSE and Stream-HTTP transports.
- [`docs/examples/`](./examples/) — Sample Cline configuration payloads for different connection types.
- [`scripts/update-cline-connection.js`](../scripts/update-cline-connection.js) — Source code for the repository-aware CLI.
- [`scripts/update-cline-connection-standalone.js`](../scripts/update-cline-connection-standalone.js) — Source code for the portable CLI.
