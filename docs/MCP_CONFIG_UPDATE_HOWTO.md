# MCP Config Update How-To

This guide explains how to refresh Cline's MCP connection settings using the automation scripts that ship with **cloud-llm-hub**. Three variants are available:

- `scripts/update-cline-connection.js` — intended to be executed inside this repository. It understands the project layout, reuses `.env` defaults, and can trigger the ABAP token helper.
- `scripts/update-cline-connection-standalone.js` — a portable CLI that accepts explicit parameters and can be copied into any workspace together with your `cline_mcp_settings.json` file.
- `scripts/update-cline-from-yaml.js` — a declarative orchestrator that reads a YAML plan, fetches service keys (from files or Cloud Foundry), runs helper commands, and updates multiple connections in one shot.

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

## 3. YAML Playbooks (`update-cline-from-yaml.js`)

Use the YAML orchestrator when you need to codify several MCP connections, including how to resolve service keys and credentials.

```bash
npm run update:cline:yaml -- --config ./config/mcp-update.yaml
npm run update:cline:yaml -- --config ./config/mcp-update.yaml --connection sap-dev,sap-qa
node scripts/update-cline-from-yaml.js --config ./config/mcp-update.yaml --dry-run

# generate a starter template
node scripts/update-cline-from-yaml.js --template direct-jwt > ./config/direct-jwt.yaml
```

Pre-baked templates also live under [`docs/templates/mcp-config/`](./templates/mcp-config/).

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
        type: sse
        endpoint: https://cloud-llm-hub.example.com/mcp/stream/sse
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
        type: stream
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

## 5. Troubleshooting

- **"Connection not found"** — Verify the key exists under `mcpServers` in `cline_mcp_settings.json`. Use `jq '.mcpServers | keys'` to list them quickly.
- **JWT expired warnings** — When using the repository script, re-run with `--service-key` or pass a fresh token via `--sap-token`.
- **Destination header set but calls still use direct URL** — Ensure the CAP service has an active Destination binding and restart the service (destination cache is in-memory).
- **On-premise destination access fails** — Double-check that `--connectivity-mode onprem` is present and that the Cloud Connector location ID matches the configured destination.

## 6. Related References

- [`docs/MCP_PROXY_USAGE.md`](./MCP_PROXY_USAGE.md) — End-to-end usage guide covering SSE and Stream-HTTP transports.
- [`docs/examples/`](./examples/) — Sample Cline configuration payloads for different connection types.
- [`docs/templates/mcp-config/`](./templates/mcp-config/) — Ready-to-fill YAML skeletons for common scenarios.
- [`scripts/update-cline-connection.js`](../scripts/update-cline-connection.js) — Source code for the repository-aware CLI.
- [`scripts/update-cline-connection-standalone.js`](../scripts/update-cline-connection-standalone.js) — Source code for the portable CLI.
- [`scripts/update-cline-from-yaml.js`](../scripts/update-cline-from-yaml.js) — Source code for the declarative YAML orchestrator.
