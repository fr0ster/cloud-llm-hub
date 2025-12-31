# Cloud LLM Hub 🚀

**Enterprise-ready MCP proxy** connecting SAP ABAP systems to AI assistants (Cline, Claude Desktop) and automation tools (n8n, CI/CD, custom apps).

**✨ Key Features:**

- ⚡ **One-command setup** - Get started in 60 seconds
- 🔒 **Enterprise security** - XSUAA authentication, on-premise support
- 🔌 **Multiple transports** - SSE and Stream-HTTP
- 🛠️ **Automation tools** - YAML-driven configuration, CI/CD ready
- 🌐 **Cloud & on-premise** - Seamless SAP Cloud Connector integration

| File or Folder | Purpose                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `app/`         | SAP BTP approuter scaffolding and local default-env configuration                 |
| `db/`          | CAP data models (currently unused, reserved for future persistence)               |
| `srv/`         | MCP proxy implementation (`mcp-proxy.ts`, `mcp-manager.ts`, connectivity helpers) |
| `docs/`        | End-user and operator documentation (usage guides, ADRs, testing cheatsheets)     |
| `tools/`       | Utility scripts (e.g., `update-cline-connection.js` for Cline header sync)        |

## 🎯 Quick Start for Consumers

**New to Cloud LLM Hub?** Start here:

1. **[⚡ Quick Setup Guide](docs/usage/QUICK_SETUP.md)** - Get running in 60 seconds
2. **[🚀 Getting Started](docs/usage/GETTING_STARTED.md)** - Complete onboarding guide
3. **[🔌 Integration Examples](docs/architecture/INTEGRATIONS.md)** - Ready-to-use code for Cline, n8n, CI/CD, and more

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
- Detailed lifecycle notes and integration examples are documented in [`docs/usage/MCP_PROXY_USAGE.md`](docs/usage/MCP_PROXY_USAGE.md#streamable-http-session-lifecycle).

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
- The `tools/update-cline-connection.js` utility synchronizes `cline_mcp_settings.json` with SAP JWT tokens and MCP headers. It works both inside the repository (with automatic defaults) and standalone (with explicit `--settings`), and supports both CLI and YAML modes. All workflows are documented in [`docs/usage/MCP_CONFIG_UPDATE_HOWTO.md`](docs/usage/MCP_CONFIG_UPDATE_HOWTO.md), including CLI overrides such as `--mcp-endpoint`, `--mcp-type`, `--mcp-username`, and `--mcp-password ""` for generating ready-to-apply templates without manual edits.

## Tooling & Tests

- **Code Quality**: ESLint and Prettier configured for consistent code style.
  - Run `npm run lint` to check for issues.
  - Run `npm run lint:fix` to auto-fix issues.
  - Run `npm run format` to format code with Prettier.
- **Integration tests**: YAML-driven test runner via `npm test` (requires `test/integration.yaml` config).
  - Copy `test/integration.yaml.template` to `test/integration.yaml` and fill in your values.
  - Supports both local and BTP deployments, configures SAP context (direct/destination mode).
- Legacy smoke tests under `test/smoke/` (manual scripts for health, SSE, Stream-HTTP).
- Run `npm exec -- tsc --noEmit` to type-check the project.
- The `docs/development/TESTING_CHEAT_SHEET.md` file summarizes manual verification steps.

## 📚 Documentation

Full documentation is organized by purpose in the **[docs/](docs/)** directory:

### 🎯 For New Users

Start here to get up and running quickly:

- **[⚡ Quick Setup](docs/usage/QUICK_SETUP.md)** - Get running in 60 seconds
- **[🚀 Getting Started](docs/usage/GETTING_STARTED.md)** - Complete onboarding guide
- **[🐛 Troubleshooting](docs/usage/TROUBLESHOOTING.md)** - Common issues and solutions

### 📖 Usage Guides

Learn how to use Cloud LLM Hub effectively:

- **[👥 Consumer Guide](docs/usage/CONSUMER_GUIDE.md)** - End-user focused guide
- **[📖 Proxy Usage](docs/usage/MCP_PROXY_USAGE.md)** - Detailed usage examples
- **[🔧 Configuration](docs/usage/MCP_CONFIG_UPDATE_HOWTO.md)** - Automated setup tools
- **[🤖 Assistant Guidelines](docs/usage/ASSISTANT_GUIDELINES.md)** - AI assistant integration best practices

### 🏗️ Architecture

Understand how the system works:

- **[📡 API Reference](docs/architecture/API_REFERENCE.md)** - Complete API specification
- **[🔌 CAP Endpoints](docs/architecture/CAP_ENDPOINTS.md)** - Service endpoints documentation
- **[✨ Features](docs/architecture/FEATURES.md)** - Why choose Cloud LLM Hub?
- **[🔌 Integrations](docs/architecture/INTEGRATIONS.md)** - Integration examples
- **[📊 MCP Header Matrix](docs/architecture/MCP_HEADER_MATRIX.md)** - Header configuration reference
- **[⚡ Performance](docs/architecture/PERFORMANCE.md)** - Performance optimization
- **[📋 Implementation Status](docs/architecture/IMPLEMENTATION_STATUS.md)** - Feature implementation tracking

### 🛠️ Development

For contributors and developers:

- **[📖 Contributing Guide](CONTRIBUTING.md)** - How to contribute
- **[👥 Contributors](CONTRIBUTORS.md)** - List of contributors
- **[🛠️ Contributor Docs](docs/contributors/)** - Development guides
  - [Setup Guide](docs/contributors/SETUP.md) - Development environment
  - [Git Workflow](docs/contributors/WORKFLOW.md) - Fork → Branch → PR
  - [Code Style](docs/contributors/CODE_STYLE.md) - Coding standards
  - [Architecture](docs/contributors/ARCHITECTURE.md) - System overview
  - [Testing Guide](docs/contributors/TESTING.md) - Testing practices
  - [🗺️ mcp-abap-adt Integration](docs/contributors/MCP_ABAP_ADT_INTEGRATION.md) - v1.1.22 integration roadmap
- **[🐛 Debugging](docs/development/DEBUGGING.md)** - Debugging techniques
- **[🔍 Debug Cline Requests](docs/development/DEBUG_CLINE_REQUESTS.md)** - Cline integration debugging
- **[🧪 Testing Cheat Sheet](docs/development/TESTING_CHEAT_SHEET.md)** - Testing workflows
- **[🔑 JWT Token Refresh](docs/development/JWT_TOKEN_REFRESH_GUIDE.md)** - Token management

### 🚀 Deployment

Deploy and operate in production:

- **[✅ Deployment Checklist](docs/deployment/DEPLOYMENT_CHECKLIST.md)** - Deployment procedures
- **[🔄 Migration Guide](docs/deployment/MIGRATION_GUIDE.md)** - Version upgrade instructions
- **[📊 Monitoring](docs/deployment/MONITORING.md)** - Monitoring setup and metrics
- **[🔧 Operations](docs/deployment/OPERATIONS.md)** - Production runbook

### 📁 Additional Resources

- **[📝 Architecture Decision Records](docs/adrs/)** - Design decisions
- **[📋 Templates](docs/templates/mcp-config/)** - Ready-to-use configurations
- **[💡 Examples](docs/examples/)** - Integration examples

### 🌍 Internationalization

- **[🇺🇦 Українська](docs/uk/)** - Ukrainian translations (partial)
  - [Швидкий старт](docs/uk/QUICK_SETUP.md)
  - [Вирішення проблем](docs/uk/TROUBLESHOOTING.md)

## Deployment Notes

- Use the optimized build command `npm run build:mta` before pushing to SAP BTP.
- The build process in `mta.yaml` uses a custom builder with `npm ci --omit=dev` and aggressive cleanup (removal of source maps, documentation, and development tools) to achieve a small deployment footprint (**~16MB**).
- The `mta.yaml` descriptor packages both the CAP service and approuter, and automatically provisions:
  - XSUAA service (`cloud-llm-hub-auth`) for authentication
  - Destination service (`cloud-llm-hub-destination`) for destination management
  - Connectivity service (`cloud-llm-hub-connectivity`) with `ConnectorID: AA45023094B911E8B0C6F0E30A06C478` for on-premise connectivity via Cloud Connector
- Deploy with `npm run deploy`. All services are automatically bound to the application.
- **Important:** After deployment, the XSUAA service might be updated. You may need to recreate the service key (`cf create-service-key cloud-llm-hub-auth mcp`) and fetch it again using `npm run get:key`.
- For local XSUAA testing, copy `default-env.json.template` to `default-env.json` and fill in service credentials, or use `npm run update:env` to fetch credentials from the deployed application.
