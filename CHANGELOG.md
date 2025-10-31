# Changelog

All notable changes to this project will be documented in this file. The format follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles.

## [Unreleased]
### Added
- Streamable HTTP session lifecycle documentation in `docs/MCP_PROXY_USAGE.md`, clarifying how `Mcp-Session-Id` is negotiated and reused.
- Standalone `scripts/update-cline-connection.js` utility with documentation for copying and running it outside the repository.
- Multi-Target Application descriptor (`mta.yaml`) with default modules and service bindings for SAP BTP Cloud Foundry deployments.

### Changed
- Reworked `srv/mcp-manager.ts` to reuse the same MCP transport across session-bound requests while resetting cleanly when a new initialization arrives.
- Updated `README.md` with an accurate project overview, session handling guidance, and documentation map.
- Extended `docs/MCP_PROXY_USAGE.md` with standalone CLI usage instructions and BTP deployment steps.
- Added `@sap/cds-dk` dev dependency to support `cds build` during MTA packaging.

## [0.2.0] - 2025-10-29
### Added
- **SSE Endpoint** (`GET /mcp/stream/sse`): Server-Sent Events streaming with heartbeat (15s), reconnection hints, and no buffering.
- **Stream-HTTP Endpoint** (`POST /mcp/stream/http`): Bidirectional NDJSON streaming with backpressure control.
- **AuthShim Middleware**: Universal authentication supporting Basic auth (dev) and Bearer JWT (production).
- **XSUAA Security Model**: New scopes (`MCP_Connect`, `MCP_Read`, `MCP_Admin`) and roles (`MCP_Connector`, `MCP_Admin`).
- **Development Profile**: Mock users (alice with admin, bob with connector access).
- **MCP Backend Integration**: Configuration for `mcp-abap-adt` backend at `http://127.0.0.1:7070`.
- **Comprehensive Documentation**:
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

