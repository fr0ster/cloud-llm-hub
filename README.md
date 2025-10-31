# Cloud LLM Hub

CAP-based proxy and tooling to bridge SAP ABAP backends with Model Context Protocol (MCP) clients such as Cline and Claude Desktop.

File or Folder | Purpose
---------|----------
`app/` | SAP BTP approuter scaffolding and local default-env configuration
`db/` | CAP data models (currently unused, reserved for future persistence)
`srv/` | MCP proxy implementation (`mcp-proxy.ts`, `mcp-manager.ts`, connectivity helpers)
`docs/` | End-user and operator documentation (usage guides, ADRs, testing cheatsheets)
`scripts/` | Utility scripts (e.g., `update-cline-connection.js` for Cline header sync)
`submodules/` | External MCP providers (notably `mcp-abap-adt`)

## Quick Start

```bash
npm install
cds watch --profile development
```

The proxy listens on `http://localhost:4004`. Development mode enables Basic authentication with mock users (`alice`, `bob`).

## Streamable HTTP & Session Handling

- The proxy exposes streaming endpoints (`GET /mcp/stream/sse`, `POST /mcp/stream/http`) implemented in `srv/mcp-proxy.ts`.
- Embedded MCP servers are created on demand in `srv/mcp-manager.ts` and cached per SAP system URL for 30 minutes.
- The first Streamable HTTP request **must** omit the `Mcp-Session-Id` header. The proxy returns a generated session ID which clients must echo in subsequent calls.
- Dropping the header (or restarting the proxy) forces a clean re-initialization, which is useful after rotating SAP credentials or clearing stale state.
- Detailed lifecycle notes and integration examples are documented in [`docs/MCP_PROXY_USAGE.md`](docs/MCP_PROXY_USAGE.md#streamable-http-session-lifecycle).

## Authentication & Connectivity

- XSUAA scopes and role collections live in [`xs-security.json`](xs-security.json). The proxy maps scopes to CAP roles via a custom auth shim.
- On-premise connectivity is handled via the Connectivity service; headers such as `X-SAP-Connectivity-Mode` are processed in `srv/connections.ts`.
- The `scripts/update-cline-connection.js` utility synchronizes `cline_mcp_settings.json` with SAP JWT tokens and MCP headers. A portable variant lives in `scripts/update-cline-connection-standalone.js`. Both workflows are documented in [`docs/MCP_CONFIG_UPDATE_HOWTO.md`](docs/MCP_CONFIG_UPDATE_HOWTO.md).

## Tooling & Tests

- Smoke tests live under `test/smoke/` (health, SSE, Stream-HTTP, SSE auth).
- Run `npm exec -- tsc --noEmit` to type-check the project.
- The `docs/TESTING_CHEAT_SHEET.md` file summarizes manual verification steps.

## Documentation Map

- [MCP Proxy Usage](docs/MCP_PROXY_USAGE.md)
- [MCP Config Update How-To](docs/MCP_CONFIG_UPDATE_HOWTO.md)
- [Implementation Report](docs/IMPLEMENTATION_REPORT.md)
- [Architecture Decision Records](docs/adrs)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)

## Deployment Notes

- Use `cds build --production` or run the MTA build (`mbt build`) before pushing to SAP BTP.
- The build hooks in `mta.yaml` first compile `submodules/mcp-abap-adt` and copy its `dist` payload into `gen/srv`, so the MTAR already contains the ABAP MCP server without any manual steps.
- The generated `mta.yaml` packages both the CAP service and approuter; adjust resource plans there and deploy with `cf deploy mta_archives/cloud-llm-hub.mtar`.
- Ensure XSUAA and (optionally) Connectivity instances are bound in Cloud Foundry.
- For local XSUAA testing, copy `default-env.json.template` to `default-env.json` and fill in service credentials.
