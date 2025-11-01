# Changelog

All notable changes to this project will be documented in this file. The format follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles.

## [Unreleased]
### Added
- Streamable HTTP session lifecycle documentation in `docs/MCP_PROXY_USAGE.md`, clarifying how `Mcp-Session-Id` is negotiated and reused.
- Standalone `scripts/update-cline-connection.js` utility with documentation for copying and running it outside the repository.
- Lightweight `scripts/update-cline-connection-standalone.js` CLI plus expanded `docs/MCP_CONFIG_UPDATE_HOWTO.md` coverage for out-of-repo updates.
- Declarative YAML orchestrator `scripts/update-cline-from-yaml.js` (with `js-yaml` runtime dependency) for multi-connection automation driven by service-key aware playbooks, now including built-in template scaffolding and SAP mode validation.
- Diagnostic endpoint `GET /mcp/destination/probe` to validate Destination Service connectivity from the deployed CAP app.
- `scripts/update-cline-from-yaml.js` templates now accept CLI overrides for MCP endpoint, transport type, description, and authentication (header, bearer, basic) so direct-JWT playbooks can be generated without manual edits.
- Multi-Target Application descriptor (`mta.yaml`) with default modules and service bindings for SAP BTP Cloud Foundry deployments.
- Automated MTA build hook that compiles and bundles the `mcp-abap-adt` submodule, plus a production dependency on `dotenv` to satisfy the embedded server at runtime.

### Changed
- Reworked `srv/mcp-manager.ts` to reuse the same MCP transport across session-bound requests while resetting cleanly when a new initialization arrives.
- Updated `README.md` with an accurate project overview, session handling guidance, and documentation map.
- Extended `docs/MCP_PROXY_USAGE.md` with standalone CLI usage instructions and BTP deployment steps.
- Added `@sap/cds-dk` dev dependency to support `cds build` during MTA packaging.
- `docs/ASSISTANT_GUIDELINES.md` snapshot describing project essentials for new assistant sessions.
- `docs/MCP_CONFIG_UPDATE_HOWTO.md` rewritten to showcase the `cloud.*` YAML schema and Cloud Foundry service-key lookup.
- Introduced `docs/MCP_HEADER_MATRIX.md` describing required headers and value sources for each template scenario.
- Updated `docs/templates/mcp-config/` scaffolds (direct-jwt, cloud-*) to reflect MCP basic auth and clarify optional service-key entries.
- Simplified cloud destination templates by treating the BTP Destination name as a constant and removing the unused `destination-file` alias.
- YAML resolver now supports explicitly empty string passwords (e.g., MCP Basic auth with an empty secret) while keeping validation in place for missing values.
- `scripts/update-cline-connection.js` honours empty MCP passwords when supplied, matching the updated template workflow.

### Removed
- Legacy destination templates under `docs/templates/mcp-config/` in favour of the new `cloud-internet` / `cloud-destination` variants.

## [0.2.0] - 2025-10-29
### Added
- **SSE Endpoint** (`GET /mcp/stream/sse`): Server-Sent Events streaming with heartbeat (15s), reconnection hints, and no buffering.
- **Stream-HTTP Endpoint** (`POST /mcp/stream/http`): Bidirectional NDJSON streaming with backpressure control.
- **AuthShim Middleware**: Universal authentication supporting Basic auth (dev) and Bearer JWT (production).
- **XSUAA Security Model**: New scopes (`MCP_Connect`, `MCP_Read`, `MCP_Admin`) and roles (`MCP_Connector`, `MCP_Admin`).
- **Development Profile**: Mock users (alice with admin, bob with connector access).
- **MCP Backend Integration**: Configuration for `mcp-abap-adt` backend at `http://127.0.0.1:7070`.
- Consolidated documentation references so Quick Start and testing steps now live in `README.md`, `docs/MCP_PROXY_USAGE.md`, and `docs/TESTING_CHEAT_SHEET.md`.
- **Comprehensive Documentation**:
### Removed
- Deprecated documents (`docs/QUICK_START.md`, `docs/QUICK_START_ASCII.txt`, `docs/TZ_MCP_SSE_StreamHTTP_Proxy_UA.md`, `docs/TZ_MCP_SSE_StreamHTTP_Proxy_XSUAA_v1.3.md`, `docs/TESTING_GUIDE.md`, `docs/IMPLEMENTATION_REPORT.md`) that duplicated current guides or obsolete specs.

  - `docs/MCP_PROXY_USAGE.md` - Full usage guide with curl/JavaScript examples
  - `docs/examples/` - Cline configuration examples for SSE and Stream-HTTP
  - `README.new.md` - Updated project README with streaming endpoints documentation
- **Smoke Tests**: Bash scripts for health, SSE, and Stream-HTTP endpoint testing (`test/smoke/`).
- **Templates**: `default-env.json.template` for local XSUAA testing.

### Changed
- Enhanced `xs-security.json` with MCP-specific scopes and role collections.
- Updated `package.json` with `@sap/xsenv` dependency and `mcpTarget` configuration.
- Refactored `srv/mcp-proxy.ts` with streaming endpoints and proper authorization checks.

### Technical Details
- TypeScript compilation: ✅ No errors
- Dependencies: Added `@sap/xsenv ^4`
- CAP CDS version: ^9
- Node.js: v22.16.0 (with warnings about @sap/xsenv engine requirements)

### Documentation
- Implementation report: `docs/IMPLEMENTATION_REPORT.md`
- Technical specification v1.3: `docs/TZ_MCP_SSE_StreamHTTP_Proxy_XSUAA_v1.3.md`

## [0.1.0] - 2025-10-28
### Added
- Initial SAP CAP project scaffold with TypeScript support.
- Baseline MCP proxy service (`srv/mcp-proxy.cds` / `srv/mcp-proxy.ts`) protected via XSUAA scope `proxyAccess`.
- Cloud Foundry configuration artifacts (`xs-security.json`, approuter skeleton).
- Architecture decision records covering hub proxy design, CF auth/destinations, and TypeScript stack.
- Roadmap documentation with progress tracking.

