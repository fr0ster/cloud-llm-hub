# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloud LLM Hub is an enterprise-ready Model Context Protocol (MCP) proxy connecting SAP ABAP systems to AI assistants (Cline, Claude Desktop) and automation tools. Built on SAP Cloud Application Programming Model (CAP) with TypeScript.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Local development (mocked auth with users alice/bob)
cds watch --profile development

# Production start
npm run start

# Type checking
npm run test:check

# Linting (Biome - auto-fix)
npm run lint

# Linting (check only, no changes)
npm run lint:check

# Format code
npm run format
```

## Testing

```bash
# Integration tests (requires test/integration.yaml config)
npm test

# Unit tests (Jest)
npm run test:unit
npm run test:unit:watch
npm run test:unit:coverage
```

For integration tests, copy `test/integration.yaml.template` to `test/integration.yaml` and configure your SAP system credentials.

## Build & Deployment

```bash
# Development build
cds build

# Production build
cds build --production

# MTA build (for SAP BTP deployment)
mbt build

# Deploy to Cloud Foundry
cf deploy mta_archives/cloud-llm-hub_<version>.mtar
```

## Architecture

### Core Components

- **srv/server.ts** - CAP bootstrap, Express route for `/mcp/stream/http`
- **srv/mcp-manager.ts** - MCP server lifecycle, SAP context extraction from headers, per-request servers
- **srv/mcp-proxy.ts** - CAP service handlers, health check, ProbeDestination diagnostics
- **srv/connections/** - Connection factory pattern for BTP destinations and direct connections

### MCP Transport

- **Stream-HTTP**: `POST /mcp/stream/http` - request-response with session ID
  - First request must omit `Mcp-Session-Id` header; server returns generated ID
  - Subsequent requests include the session ID for server reuse
- **OpenAI-compatible**: `POST /v1/chat/completions` - chat completions via SmartAgent pipeline
- **Anthropic Messages API**: `POST /v1/messages` - translates Anthropic format to SmartAgent pipeline; enables Claude CLI via `ANTHROPIC_BASE_URL`
- **Destination management**: `POST /v1/destinations/refresh` - re-init unreachable destinations on demand; `GET /odata/v4/mcp-proxy/ListDestinations()` - list all destinations with reachability status

### Authentication

- **Development**: Mocked auth (`alice` has MCP_Connector + MCP_Admin roles, `bob` has MCP_Connector only)
- **Production**: XSUAA (OAuth 2.0) via SAP BTP
- Roles defined in `xs-security.json`

### SAP Connectivity

- Uses SAP Cloud SDK (`@sap-cloud-sdk/http-client`) for destination resolution
- Supports on-premise systems via Cloud Connector (Connectivity service)
- Connection types: BTP Destination (CloudSdkAbapConnection) and Direct (createAbapConnection)

## Key Dependencies

- `@sap/cds` ^9 - CAP framework
- `@modelcontextprotocol/sdk` ^1.23.0 - MCP protocol
- `@mcp-abap-adt/core` ^1.4.3 - ABAP MCP server implementation
- `@sap-cloud-sdk/*` - Destination resolution, HTTP client

## Code Style

- **Biome** for linting and formatting (replaced ESLint)
- Single quotes, 2-space indents, 100-char line width
- TypeScript strict mode enabled

## Git Workflow

- Branch from `main`, create PRs targeting `main`
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- CI runs: lint check, type check, build

## Language Conventions

- All code, documentation, and commits in **English**
- User communication may be in **Ukrainian**

## Utility Scripts

```bash
npm run update:cline       # Sync Cline MCP settings with JWT tokens
npm run update:env         # Fetch BTP credentials to default-env.json
npm run bump:version       # Bump semantic version
npm run sync:version       # Sync version to mta.yaml
```
