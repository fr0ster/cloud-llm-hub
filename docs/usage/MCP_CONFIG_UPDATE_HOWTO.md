# MCP Config Update How-To

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

This guide explains how to refresh Cline's MCP connection settings using the unified automation script that ships with **cloud-llm-hub**.

**`tools/update-cline-connection.js`** is a unified script that supports two modes:

1. **CLI mode** (default) — works both inside the repository (with automatic defaults) and standalone (with explicit parameters). It understands the project layout, reuses `.env` defaults when available, and can trigger the ABAP token helper.
2. **YAML mode** (with `--config` or `--template`) — a declarative orchestrator that reads a YAML plan, fetches service keys (from files or Cloud Foundry), runs helper commands, and updates multiple connections in one shot.

The script updates the JSON document in-place and only touches the headers for the requested MCP connection. Use `--dry-run` to review the resulting payload without saving anything.

**Standalone usage:** Copy `tools/update-cline-connection.js` to any location (single file contains both CLI and YAML modes).

## 1. CLI Mode (Default)

### Inside Repository (with defaults)

```bash
# refresh the "sap-dev" connection using repository defaults
node tools/update-cline-connection.js --connection sap-dev

# same command via npm alias
npm run update:cline -- --connection sap-dev
```

### Standalone Mode (for consumers without the full project)

The script can work standalone when you provide `--settings` explicitly. You can copy just `tools/update-cline-connection.js` to any location and use it without the full cloud-llm-hub repository:

```bash
# Copy the script to your workspace
cp tools/update-cline-connection.js ~/my-workspace/

# Run it with explicit parameters (no repository needed)
node ~/my-workspace/update-cline-connection.js \
  --settings /path/to/cline_mcp_settings.json \
  --connection sap-dev \
  --sap-url https://my.s4hana.example.com \
  --sap-auth-type jwt \
  --sap-token "<ABAP JWT>"
```

**Note:** In standalone mode (when `--settings` is provided), the script:

- Requires explicit SAP credentials (`--sap-token` or `--sap-username/--sap-password`)
- Does not search for `.env` files
- Does not support `--service-key` (requires repository structure)

Key capabilities:

- **Inside repository**: Reads the Cline settings file from the default location (`~/.config/Code/User/.../cline_mcp_settings.json`) unless you override `--settings <path>`. Loads SAP credentials from `submodules/mcp-abap-adt/.env` (or `./.env` fallback) and can refresh the JWT using `--service-key <xsuaa-key.json>`.
- **Standalone mode**: When `--settings` is provided, requires explicit SAP credentials (`--sap-token` or `--sap-username/--sap-password`). The `--service-key` option is not available in standalone mode.
- Supports MCP-side authentication overrides via `--mcp-*` switches (basic, bearer, or direct header injection).
- Adds destination headers when you call `--destination-name <DEST>` to route traffic through SAP BTP Destination service. Combine with `--connectivity-mode onprem` and `--connectivity-location-id <ID>` if the destination uses Cloud Connector.

### Frequently Used Options

| Option                       | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `--connection <name>`        | Connection key in `cline_mcp_settings.json` (required).                         |
| `--env <path>`               | Explicit `.env` file with SAP credentials.                                      |
| `--service-key <path>`       | Generates a fresh SAP JWT via `sap-abap-auth-browser`.                          |
| `--sap-token <token>`        | Inline SAP JWT instead of reading `.env`.                                       |
| `--destination-name <name>`  | Enables destination routing (removes direct URL headers).                       |
| `--connectivity-mode onprem` | Instructs the proxy to use the Connectivity service for an on-prem destination. |
| `--mcp-token <jwt>`          | Sets MCP-side bearer auth (`Authorization: Bearer ...`).                        |
| `--dry-run`                  | Preview changes without saving.                                                 |

> **Note:** When `--destination-name` is supplied the script will drop the direct `X-SAP-URL` / `X-SAP-JWT-TOKEN` headers and rely on the Destination service at runtime. This keeps the stored settings free from short-lived tokens.

## 2. YAML Mode (with `--config`)

Use YAML mode when you need to codify several MCP connections, including how to resolve service keys and credentials. The same script handles both modes automatically.

**Standalone usage:** Copy `tools/update-cline-connection.js` to use anywhere (single file contains both CLI and YAML modes).

```bash
# Via npm (pass --config as argument)
npm run update:cline:yaml -- --config ./config/mcp-update.yaml
npm run update:cline:yaml -- --config ./config/mcp-update.yaml --connection sap-dev,sap-qa

# Direct usage
node tools/update-cline-connection.js --config ./config/mcp-update.yaml --dry-run

# generate a starter template
node tools/update-cline-connection.js --template direct-jwt > ./config/direct-jwt.yaml
```

Pre-baked templates also live under [`docs/templates/mcp-config/`](./templates/mcp-config/).

### Template overrides

When printing templates you can override the MCP metadata directly from the CLI instead of editing the YAML afterwards:

```bash
node tools/update-cline-connection.js \
  --template direct-jwt \
  --connection direct-jwt-local \
  --service-key-file sapAbap=./keys/sk.json \
  --mcp-endpoint http://localhost:3000/mcp/stream/http \
  --mcp-type streamableHttp \
  --mcp-description "Local MCP proxy with JWT passthrough" \
  --mcp-auth-type basic \
  --mcp-username alice \
  --mcp-password ""
```

Available overrides:

- `--mcp-endpoint <url>` — inject a specific MCP endpoint.
- `--mcp-type <transport>` — set the transport (`streamableHttp`, etc.).
- `--mcp-description <text>` — customise the connection description.
- `--mcp-auth-type <basic|bearer|jwt|header|none>` — choose the MCP auth block.
- `--mcp-auth-header <value>` — supply a raw `Authorization` header value when `header` is selected.
- `--mcp-username` / `--mcp-password` — inline credentials for Basic auth (empty passwords are quoted as `''`).
- `--mcp-token` — provide a static bearer token.

Example blueprint:

```yaml
cloud:
  settingsPath: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
  cf:
    binary: cf
  serviceKeys:
    # Pick the source style that matches your environment (cf lookup or static file)
    mcp-xsuaa:
      type: cf
      instance: cloud-llm-hub-auth
      key: mcp
    mcp-xsuaa-file:
      type: file
      path: ./keys/mcp-xsuaa.json
    sap-abap:
      type: cf
      instance: sap-backend-auth
      key: abap
    sap-abap-file:
      type: file
      path: ./keys/sap-abap.json
    destination:
      type: cf
      instance: cloud-llm-hub-destination
      key: cline
  connections:
    sap-dev:
      definition:
        type: streamableHttp
        endpoint: https://cloud-llm-hub.example.com/mcp/stream/http
        description: Cloud Destination (DEV)
      sap:
        mode: destination
        destinationName: SAP_DEV_HTTP
        # Replace with the constant Destination name from your BTP subaccount
        connectivity:
          mode: onprem
          locationId: CC-PRD
      mcp:
        auth:
          type: bearer
          token:
            source:
              type: serviceKey
              name: mcp-xsuaa
            jsonPath: access_token
      headers:
        x-custom-trace: DEV
    sap-qa:
      updateScope: sap
      patch:
        endpoint: https://cloud-llm-hub.example.com/mcp/stream/http
        type: streamableHttp
      sap:
        mode: direct
        url: https://my-qa.sap.example.com
        client: 210
        auth:
          type: jwt
          token:
            source:
              type: serviceKey
              name: sap-abap
            jsonPath: credentials.jwt
```

Highlights:

- `cloud.settingsPath` sets a global default; individual connections may override it.
- `cloud.cf.binary` lets you pick a non-default CF CLI (e.g. `cf7` or a full path).
- `cloud.serviceKeys` registers aliases backed by files, inline JSON, or Cloud Foundry (`type: cf`) service keys.
- `definition` hydrates a connection when it does not yet exist.
- `patch` applies shallow overrides (e.g. `endpoint`, `type`) on every run.
- `sap.mode` accepts `destination` or `direct`, automatically removing conflicting headers.
- `mcp.auth` supports `bearer`, `jwt`, `basic`, `header`, and `none`.
- Basic-auth passwords may intentionally be empty; declare the value as an empty string (`""`) in the template or leave it to the CLI override above to emit `''`.
- `headers` adds or removes custom headers; use `null` to delete.
- Use `jsonPath` on any value spec when you need a nested field from the resolved service key JSON (omit it to inject the full document).
- The script validates that destination-specific and direct SAP parameters are not mixed. If both are present, it stops with an explicit error so templates stay consistent.

Combine `serviceKey` sources with `source.type: command` when you need to run an external helper (the script pipes the referenced JSON into stdin).

> **Tip:** keep only the aliases you actually use—extra entries are harmless but can be misleading during reviews.

```bash
cf service-key cloud-llm-hub-auth mcp
```

The CLI output (JSON) is what the YAML playbook consumes when you declare a `type: cf` service key.

## 4. Example Scenarios

### Refresh SAP JWT from Service Key and Update the MCP Token

```bash
node tools/update-cline-connection.js \
  --connection sap-dev \
  --service-key path/to/service-key.json \
  --mcp-token "<mcp-proxy-jwt>"
```

1. The script runs `sap-abap-auth-browser.js` to mint a new JWT and stores it in the `.env` file.
2. The refreshed token is injected into the selected Cline connection.
3. The MCP-side JWT header gets overwritten with the provided value.

### Switch to Destination-Based Routing (On-Premise)

```bash
node tools/update-cline-connection.js \
  --connection sap-qa \
  --destination-name SAP_QA_ONPREM \
  --connectivity-mode onprem \
  --connectivity-location-id CC-PRD
```

- Removes direct SAP URL/JWT headers.
- Adds `X-SAP-Destination`, `X-SAP-Connectivity-Mode: onprem`, and `X-SAP-Connectivity-Location-Id: CC-PRD`.
- Leaves MCP auth untouched.

### Fully Offline Update (Standalone Mode)

```bash
# Copy the script first (if not in repository)
cp tools/update-cline-connection.js ~/my-workspace/

# Run in standalone mode with explicit parameters
node ~/my-workspace/update-cline-connection.js \
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

The script injects the SAP basic credentials and the MCP basic credentials without reading any repository metadata. When `--settings` is provided, it runs in standalone mode and requires all credentials to be passed explicitly.

## 5. Troubleshooting

- **"Connection not found"** — Verify the key exists under `mcpServers` in `cline_mcp_settings.json`. Use `jq '.mcpServers | keys'` to list them quickly.
- **JWT expired warnings** — When using the repository script, re-run with `--service-key` or pass a fresh token via `--sap-token`.
- **Destination header set but calls still use direct URL** — Ensure the CAP service has an active Destination binding and restart the service (destination cache is in-memory).
- **On-premise destination access fails** — Double-check that `--connectivity-mode onprem` is present and that the Cloud Connector location ID matches the configured destination.

## 6. Related References

- [`docs/MCP_PROXY_USAGE.md`](./MCP_PROXY_USAGE.md) — End-to-end usage guide covering Stream-HTTP transport.
- [`docs/examples/`](./examples/) — Sample Cline configuration payloads for different connection types.
- [`docs/templates/mcp-config/`](./templates/mcp-config/) — Ready-to-fill YAML skeletons for common scenarios.
- [`tools/update-cline-connection.js`](../tools/update-cline-connection.js) — Source code for the unified CLI (supports both CLI and YAML modes, works standalone).
