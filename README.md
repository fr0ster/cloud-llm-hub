# Cloud LLM Hub 🚀

**Enterprise-ready MCP proxy** connecting SAP ABAP systems to AI assistants (Cline, Claude Desktop) and automation tools (n8n, CI/CD, custom apps).

**✨ Key Features:**
- ⚡ **One-command setup** - Get started in 60 seconds
- 🔒 **Enterprise security** - XSUAA authentication, on-premise support
- 🔌 **Multiple transports** - SSE and Stream-HTTP
- 🛠️ **Automation tools** - YAML-driven configuration, CI/CD ready
- 🌐 **Cloud & on-premise** - Seamless SAP Cloud Connector integration

File or Folder | Purpose
---------|----------
`app/` | SAP BTP approuter scaffolding and local default-env configuration
`db/` | CAP data models (currently unused, reserved for future persistence)
`srv/` | MCP proxy implementation (`mcp-proxy.ts`, `mcp-manager.ts`, connectivity helpers)
`docs/` | End-user and operator documentation (usage guides, ADRs, testing cheatsheets)
`tools/` | Utility scripts (e.g., `update-cline-connection.js` for Cline header sync)
`submodules/` | External MCP providers (notably `mcp-abap-adt`)

## 🎯 Quick Start for Consumers

**New to Cloud LLM Hub?** Start here:

1. **[⚡ Quick Setup Guide](docs/QUICK_SETUP.md)** - Get running in 60 seconds
2. **[🚀 Getting Started](docs/GETTING_STARTED.md)** - Complete onboarding guide
3. **[🔌 Integration Examples](docs/INTEGRATIONS.md)** - Ready-to-use code for Cline, n8n, CI/CD, and more

**For Developers:**
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

## Destination Diagnostics

- `GET /mcp/ProbeDestination?destination=<name>` (CAP function) resolves a Destination service entry using SAP Cloud SDK's `executeHttpRequest`, establishes connectivity (including Connectivity proxy when required for on-premise destinations), performs an ADT discovery request, and returns the HTTP status. Responses include metadata such as proxy type, SAP client, Cloud Connector location ID, authentication type, and the probe timestamp. Requires the same authorization as the MCP streaming endpoints. The implementation leverages SAP Cloud SDK for automatic destination resolution, authentication handling, and proxy configuration.

## Authentication & Connectivity

- XSUAA scopes and role collections live in [`xs-security.json`](xs-security.json). The proxy maps scopes to CAP roles via a custom auth shim.
- Authentication is handled in-process using CAP service invocations (`srv.run()`) to eliminate network overhead and ensure proper user/tenant/locale context propagation.
- **Destination Handling**: All destination interactions (internet and on-premise) use SAP Cloud SDK's `executeHttpRequest` from `@sap-cloud-sdk/http-client`, which automatically handles:
  - Destination resolution and URL construction
  - Authentication (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
  - Token lifecycle management and refresh
  - Proxy configuration (including Cloud Connector for on-premise destinations)
- **On-Premise Connectivity**: The Connectivity service is configured in `mta.yaml` with a specified `ConnectorID` for Cloud Connector integration. When a destination with `ProxyType=OnPremise` is used, `executeHttpRequest` automatically routes requests through the Connectivity proxy.
- The `tools/update-cline-connection.js` utility synchronizes `cline_mcp_settings.json` with SAP JWT tokens and MCP headers. It works both inside the repository (with automatic defaults) and standalone (with explicit `--settings`), and supports both CLI and YAML modes. All workflows are documented in [`docs/MCP_CONFIG_UPDATE_HOWTO.md`](docs/MCP_CONFIG_UPDATE_HOWTO.md), including CLI overrides such as `--mcp-endpoint`, `--mcp-type`, `--mcp-username`, and `--mcp-password ""` for generating ready-to-apply templates without manual edits.

## Tooling & Tests

- **Integration tests**: YAML-driven test runner via `npm test` (requires `test/integration.yaml` config).
  - Copy `test/integration.yaml.template` to `test/integration.yaml` and fill in your values.
  - Supports both local and BTP deployments, configures SAP context (direct/destination mode).
- Legacy smoke tests under `test/smoke/` (manual scripts for health, SSE, Stream-HTTP).
- Run `npm exec -- tsc --noEmit` to type-check the project.
- The `docs/TESTING_CHEAT_SHEET.md` file summarizes manual verification steps.

## 📚 Documentation

### For Consumers (Using Cloud LLM Hub)
- **[⚡ Quick Setup](docs/QUICK_SETUP.md)** - 60-second setup guide
- **[🚀 Getting Started](docs/GETTING_STARTED.md)** - Complete onboarding
- **[✨ Features & Benefits](docs/FEATURES.md)** - Why choose Cloud LLM Hub?
- **[🔌 Integration Examples](docs/INTEGRATIONS.md)** - Cline, n8n, CI/CD, Python, Node.js
- **[👥 Consumer Guide](docs/CONSUMER_GUIDE.md)** - End-user focused guide
- **[🔧 Configuration Guide](docs/MCP_CONFIG_UPDATE_HOWTO.md)** - Automated setup tools
- **[📡 API Reference](docs/API_REFERENCE.md)** - Complete API specification
- **[📖 Proxy Usage Guide](docs/MCP_PROXY_USAGE.md)** - Detailed usage examples
- **[🐛 Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

### For Developers (Contributing)
- **[📖 Contributing Guide](CONTRIBUTING.md)** - How to contribute
- **[🔧 Contributor Documentation](docs/contributors/)** - Complete contributor guides
  - [Setup Guide](docs/contributors/SETUP.md) - Development environment
  - [Git Workflow](docs/contributors/WORKFLOW.md) - Fork → Branch → PR
  - [Code Style](docs/contributors/CODE_STYLE.md) - Coding standards
  - [Architecture](docs/contributors/ARCHITECTURE.md) - System overview
  - [Testing Guide](docs/contributors/TESTING.md) - Testing practices

### For Operators (Production)
- **[🔧 Operations Guide](docs/OPERATIONS.md)** - Production runbook
- **[📊 Monitoring Guide](docs/MONITORING.md)** - Monitoring setup and metrics
- **[⚡ Performance Guide](docs/PERFORMANCE.md)** - Performance optimization and tuning
- **[🔄 Migration Guide](docs/MIGRATION_GUIDE.md)** - Version upgrade instructions
- [Deployment Checklist](docs/DEPLOYMENT_CHECKLIST.md) - Deployment procedures
- [Implementation Report](docs/IMPLEMENTATION_REPORT.md)
- [Architecture Decision Records](docs/adrs)

### Templates & Examples
- [MCP Config Templates](docs/templates/mcp-config) - Ready-to-use YAML configurations
- [Example Configurations](docs/examples) - Cline settings examples

## Deployment Notes

- Use `cds build --production` or run the MTA build (`mbt build`) before pushing to SAP BTP.
- The build hooks in `mta.yaml` first compile `submodules/mcp-abap-adt` and copy its `dist` payload into `gen/srv`, so the MTAR already contains the ABAP MCP server without any manual steps.
- The `mta.yaml` descriptor packages both the CAP service and approuter, and automatically provisions:
  - XSUAA service (`cloud-llm-hub-auth`) for authentication
  - Destination service (`cloud-llm-hub-destination`) for destination management
  - Connectivity service (`cloud-llm-hub-connectivity`) with `ConnectorID: AA45023094B911E8B0C6F0E30A06C478` for on-premise connectivity via Cloud Connector
- Deploy with `cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar`. All services are automatically bound to the application.
- For local XSUAA testing, copy `default-env.json.template` to `default-env.json` and fill in service credentials, or use `npm run update:env` to fetch credentials from the deployed application.
