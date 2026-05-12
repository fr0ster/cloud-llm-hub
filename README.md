# Cloud LLM Hub 🚀

**Enterprise-ready MCP proxy** connecting SAP ABAP systems to AI assistants (Cline, Claude Desktop) and automation tools (n8n, CI/CD, custom apps).

**✨ Key Features:**

- ⚡ **One-command setup** - Get started in 60 seconds
- 🔒 **Enterprise security** - XSUAA authentication, on-premise support
- 🔌 **Stream-HTTP transport** - SSE currently disabled
- 🛠️ **Automation tools** - YAML-driven configuration, CI/CD ready
- 🌐 **Cloud & on-premise** - Seamless SAP Cloud Connector integration

| File or Folder | Purpose                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `app/`         | SAP BTP approuter scaffolding and local default-env configuration                 |
| `db/`          | CAP data models (currently unused, reserved for future persistence)               |
| `srv/`         | MCP proxy implementation (`mcp-proxy.ts`, `mcp-manager.ts`, connectivity helpers) |
| `docs/`        | End-user and operator documentation (usage guides, ADRs, testing cheatsheets)     |
| `tools/`       | Utility scripts (e.g., `update-cline-connection.js` for Cline header sync)        |

## Product Intent and Target Consumers

`mcp-abap-adt` (base layer) was created as a practical toolset for **AI-assisted development / AI pair programming** in SAP ABAP contexts.

`cloud-llm-hub` is the enterprise iteration of that foundation:

- keeps developer productivity goals, but adds a knowledge-first enterprise runtime model;
- enables teams to accumulate and reuse development/support experience together as shared organizational knowledge, so LLM-assisted workflows become more valuable over time;
- increases effectiveness of both the LLM and the developer: the LLM removes routine work, while the developer focuses on decisions that require human judgment;
- enforces role model and function-level authorization boundaries for shared enterprise usage.

Priority of goals in `cloud-llm-hub`:

1. accumulate and reuse experience from real development/support work;
2. improve AI-assisted outcomes from session to session;
3. apply enterprise-grade role and function boundaries.

Target consumers are SAP technical teams:

- SAP support engineers;
- SAP developers (ABAP developers and SAP consultants working as developers).

This project is not positioned as a generic public API business platform or a commercial pipeline product.

## Core Knowledge Model (3 RAG Bases)

The killer feature for consumers is not only MCP integration; it is systematic knowledge accumulation.

1. Client/domain RAG
- customer-specific knowledge: known incidents, analysis outcomes, problem resolutions, internal documents, and constraints for the supported SAP landscape.

2. General SAP engineering RAG
- cross-project SAP knowledge: best practices, anti-patterns, ABAP/RAP BO specifics, legacy on-premise specifics, and modern cloud specifics.

3. Pair-programming session RAG
- durable memory from user+AI collaboration: decisions, accepted approaches, implementation notes, and lessons that should be reused in future sessions.

Enterprise controls (XSUAA roles, scope-based access, separation of functions) are critical, but they support this primary knowledge objective.

## 🎯 Quick Start for Consumers

**New to Cloud LLM Hub?** Start here:

1. **[🚀 Getting Started](docs/usage/GETTING_STARTED.md)** - Complete onboarding guide
2. **[🔌 MCP Connection](docs/usage/MCP_CONNECTION.md)** - Connect Cline / Claude Desktop / agent frameworks
3. **[🤖 OpenAI Agent](docs/usage/OPENAI_AGENT.md)** - Use `/v1/chat/completions` from any OpenAI-compatible client

**For Developers:**

```bash
npm install
cds watch --profile development
```

The proxy listens on `http://localhost:4004`. Development mode enables Basic authentication with mock users (`alice`, `bob`).

## Streamable HTTP & Session Handling

- The proxy exposes the Stream-HTTP endpoint (`POST /mcp/stream/http`) implemented in `srv/mcp-proxy.ts`.
- An **OpenAI-compatible chat endpoint** (`POST /v1/chat/completions`) and an **Anthropic Messages API endpoint** (`POST /v1/messages`) are also available. The Anthropic endpoint enables Claude CLI connections via the `ANTHROPIC_BASE_URL` environment variable — it translates the Anthropic message format through the SmartAgent pipeline and streams back Anthropic-compatible SSE events.
- Embedded MCP servers are created per request in `srv/mcp-manager.ts` (no server instance cache).
- The first Streamable HTTP request **must** omit the `Mcp-Session-Id` header. The proxy returns a generated session ID which clients must echo in subsequent calls.
- Dropping the header (or restarting the proxy) forces a clean re-initialization, which is useful after rotating SAP credentials or clearing stale state.
- Detailed connection and session examples are documented in [`docs/usage/MCP_CONNECTION.md`](docs/usage/MCP_CONNECTION.md) and the [`Stream-HTTP` API reference](docs/architecture/API_REFERENCE.md#12-stream-http).

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
- The `tools/update-cline-connection.js` utility synchronizes `cline_mcp_settings.json` with SAP JWT tokens and MCP headers. It works both inside the repository (with automatic defaults) and standalone (with explicit `--settings`), and supports both CLI and YAML modes. CLI overrides such as `--mcp-endpoint`, `--mcp-type`, `--mcp-username`, and `--mcp-password ""` allow generating ready-to-apply templates without manual edits.

## Tooling & Tests

- **Code Quality**: ESLint and Prettier configured for consistent code style.
  - Run `npm run lint` to check for issues.
  - Run `npm run lint:fix` to auto-fix issues.
  - Run `npm run format` to format code with Prettier.
- **Integration tests**: YAML-driven test runner via `npm test` (requires `test/integration.yaml` config).
  - Copy `test/integration.yaml.template` to `test/integration.yaml` and fill in your values.
  - Supports both local and BTP deployments, configures SAP context (direct/destination mode).
- **Endpoint test script**: `tools/test-endpoints.sh` covers MCP, OpenAI-compatible, and Anthropic Messages API protocols against local and BTP deployments.
- **Local MCP proxy** (`npm run proxy [DESTINATION]`): convenience wrapper around `@mcp-abap-adt/proxy` that bridges `localhost:3001` to the deployed `cloud-llm-hub-srv` in the targeted CF subaccount. Use it during local development so MCP clients (Cline, Claude Desktop, scripts, `curl`) can hit the service through `localhost` without juggling JWT tokens, BTP destinations, or the public approuter URL on every request — the proxy handles XSUAA auth-code flow once per session and self-heals its service-key cache when CF target switches. See [`docs/usage/MCP_CONNECTION.md` → Local Proxy](docs/usage/MCP_CONNECTION.md#local-proxy-npm-run-proxy).
- Legacy smoke tests under `test/smoke/` (manual scripts for health and Stream-HTTP).
- Run `npm exec -- tsc --noEmit` to type-check the project.
- Manual verification steps are covered by [`docs/deployment/TESTING_AFTER_DEPLOYMENT.md`](docs/deployment/TESTING_AFTER_DEPLOYMENT.md) and [`docs/llm-agent/TESTING.md`](docs/llm-agent/TESTING.md).

## 📚 Documentation

Full documentation is organized by purpose in the **[docs/](docs/)** directory — the canonical index with section groupings is **[docs/README.md](docs/README.md)**. Highlights:

### 🎯 For New Users

- **[🚀 Getting Started](docs/usage/GETTING_STARTED.md)** — onboarding guide
- **[🔌 MCP Connection](docs/usage/MCP_CONNECTION.md)** — connecting Cline / Claude Desktop / agent frameworks
- **[🐛 Troubleshooting](docs/usage/TROUBLESHOOTING.md)** — common issues
- **[🤖 OpenAI Agent](docs/usage/OPENAI_AGENT.md)** — `/v1/chat/completions` consumer guide

### 🏗️ Architecture

- **[🗺️ Architecture Overview](docs/architecture/ARCHITECTURE.md)**
- **[📡 API Reference](docs/architecture/API_REFERENCE.md)** — full API spec
- **[🔌 CAP Endpoints](docs/architecture/CAP_ENDPOINTS.md)** — service endpoints
- **[🧩 Extension Guide](docs/architecture/EXTENSION_GUIDE.md)** — adding tools / providers
- **[✨ Features](docs/architecture/FEATURES.md)** — capabilities overview
- **[📊 MCP Header Matrix](docs/architecture/MCP_HEADER_MATRIX.md)** — routing / auth header reference

### 🚀 Deployment

- **[📘 Deploy Guide](docs/deployment/DEPLOY_GUIDE.md)** — full BTP / CF deployment
- **[⚡ Quick Deploy](docs/deployment/QUICK_DEPLOY.md)** — accelerated path
- **[✅ Testing After Deployment](docs/deployment/TESTING_AFTER_DEPLOYMENT.md)** — post-deploy verification
- **[📋 Installation Plan](docs/deployment/INSTALLATION_PLAN.md)** / **[📄 Summary](docs/deployment/INSTALLATION_SUMMARY.md)**

### 🛠️ Development

- **[📖 Contributing Guide](CONTRIBUTING.md)**
- **[👥 Contributors](CONTRIBUTORS.md)**
- **[🎨 Code Style](docs/contributors/CODE_STYLE.md)**
- **[🔗 Connection Architecture](docs/contributors/CONNECTION_ARCHITECTURE.md)** — BTP destination vs. direct connection factory pattern
- **[🔐 CAP Express Auth](docs/development/CAP_EXPRESS_AUTH.md)** — XSUAA + middleware notes
- **[🌐 Cross-Platform Guide](docs/development/CROSS_PLATFORM_GUIDE.md)** / **[🪟 Windows Setup](docs/development/WINDOWS_SETUP.md)**

### 🤖 LLM Agent

- **[⚙️ Config Usage](docs/llm-agent/CONFIG_USAGE.md)** — SmartAgent configuration
- **[🧩 Embedded Usage](docs/llm-agent/EMBEDDED_USAGE.md)** — embedding the pipeline
- **[🧪 Testing](docs/llm-agent/TESTING.md)**

### 🎓 Tutorials

- **[🧭 AI Pair-Programming Principles](docs/tutorials/AI_PAIR_PROGRAMMING_PRINCIPLES.md)**
- **[📦 Creating a RAP Business Object](docs/tutorials/rap-bo-creation/README.md)** — concrete Material Master walkthrough
- **[📚 Building a RAP BO with AI](docs/tutorials/rap-bo-book-catalog/README.md)** — advanced AI-assisted Book Catalog flow
- **[🔎 Codebase Analysis with AI](docs/tutorials/codebase-analysis/README.md)** — analyze how a codebase implements a target mechanism

### 📁 Additional Resources

- **[📋 Configuration Templates](docs/templates/)** — ready-to-use MCP configs
- **[💡 Examples](docs/examples/)** — integration examples (`abap-dump-monitor`, `calm-dump-analyzer`, …)

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

## Configuration & Secrets

Sensitive configuration (like LLM model names, destination names) should not be committed to Git. Instead, use an MTA Extension Descriptor:

1. Copy the template:
   ```bash
   cp mta-config.mtaext.template mta-config.mtaext
   ```
2. Edit `mta-config.mtaext` with your real values. This file is git-ignored.
3. Deploy with the configuration:
   ```bash
   cf deploy gen/mta_archives/cloud-llm-hub.tar -e mta-config.mtaext --abort-on-error --delete-services
   ```
