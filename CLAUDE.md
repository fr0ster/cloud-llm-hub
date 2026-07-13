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

# IMPORTANT: For CAP sub-projects (docs/examples/*), run `cds build` before `mbt build`.
# MTA builder runs `npm ci` but does NOT run `cds build` — if the CDS model changed,
# the gen/ folder will contain stale compiled output and new entities/functions won't appear.
# Sequence: npx cds build && npx mbt build && cf deploy ...
```

## Architecture

### Core Components

- **srv/server.ts** - CAP bootstrap, Express routes for `/mcp/stream/http` and `/v1/*`
- **srv/agent-manager.ts** - SmartAgent lifecycle, LLM/RAG/MCP wiring, tool vectorization
- **srv/agent-config.ts** - Configuration from env vars (LLM provider, model, RAG, MCP)
- **srv/openai-handler.ts** - OpenAI-compatible chat endpoint (streaming + non-streaming)
- **srv/anthropic-handler.ts** - Anthropic Messages API handler
- **srv/mcp-manager.ts** - MCP server lifecycle, SAP context extraction from headers, per-request servers
- **srv/mcp-proxy.ts** - CAP service handlers, health check, ProbeDestination diagnostics
- **srv/connections/** - Connection factory pattern for BTP destinations and direct connections

### MCP Transport

- **Stream-HTTP**: `POST /mcp/stream/http` - request-response with session ID
  - First request must omit `Mcp-Session-Id` header; server returns generated ID
  - Subsequent requests include the session ID for server reuse
- **Planner/controller (agent)**: `POST /mcp/agent/stream/http` - stateless MCP surface exposing two tools for an external planner (e.g. Claude Code): `list_destinations` (reachable systems) and `execute_step` (delegate ONE step to the SmartAgent executor). The connecting client plans; the agent behind the tool is a stateless executor. Connection is built lazily per call from `x-sap-*` headers. Destination resolution: `execute_step`'s `destination` arg is OPTIONAL — it falls back to the connection's default `X-SAP-Destination` header. Primary model is one MCP server per system (destination + creds in headers, route by server name); the arg is the override for when one connection reaches several systems. See `srv/agent-mcp.ts`.
- **OpenAI-compatible**: `POST /v1/chat/completions` - chat completions via SmartAgent pipeline
- **Anthropic Messages API**: `POST /v1/messages` - translates Anthropic format to SmartAgent pipeline; enables Claude CLI via `ANTHROPIC_BASE_URL`
- **Destination management**: `POST /v1/destinations/refresh` - re-init unreachable destinations on demand; `GET /odata/v4/mcp-proxy/ListDestinations()` - list all destinations with reachability status
- **Destination mapping**: `GET /v1/destinations/resolve?system=E19.100` - resolve SAP system code to BTP destination name; configured via `DESTINATION_MAPPING` env var
- **Token**: `GET /v1/token` - return caller's JWT token; UI page at `/chat/webapp/token.html`

### Authentication

- **Development**: Mocked auth (`alice` has MCP_Connector + MCP_Admin roles, `bob` has MCP_Connector only)
- **Production**: XSUAA (OAuth 2.0) via SAP BTP, token validity 7 days
- Roles defined in `xs-security.json`

### SAP Connectivity

- Uses SAP Cloud SDK (`@sap-cloud-sdk/http-client`) for destination resolution
- Supports on-premise systems via Cloud Connector (Connectivity service)
- Connection types: BTP Destination (CloudSdkAbapConnection) and Direct (createAbapConnection)

### Destination lifecycle (equal, lazy, block-until-ready)

- No privileged "primary" destination. Startup is ready immediately; it does NOT
  block on any destination vectorizing. All destinations warm in a sequential
  background pass and/or lazily on first request.
- `getSmartAgent` waits (bounded) for a destination's vectorization instead of
  erroring `agent not initialized`. `LLM_AGENT_DESTINATION_INIT_WAIT_MS` (default
  90000) caps the wait. After timeout: explicit-destination requests throw a
  retryable 503; non-explicit throw unless `LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK=true`.
- `LLM_AGENT_MCP_DESTINATION` is now only an optional "warm this first" hint — it
  is initialized like any other destination, just earlier in the queue.
- `ensureDestinationInit` dedups concurrent inits (one vectorization per
  destination) across startup, background, `/destinations/refresh`, the retry
  timer, and the lazy `getSmartAgent` path.

### Shared tool corpus + build-time embedding bundle

- The tool-intent RAG is **destination-independent** (tools come from
  `HandlerExporter`, identical for every SAP system), so it is built **once** and
  shared by all destination agents (`ensureSharedToolsVectorized`, global
  single-flight) — not re-vectorized per destination.
- `srv/tool-embeddings.json` is a **committed build-time bundle** of precomputed
  embeddings (like `srv/tool-intents.json`). At startup the shared store loads it
  via `upsertPrecomputedRaw` with **zero embedding calls** when the config-only
  `embedderFingerprint` matches and each entry's text is identical; mismatched
  fingerprint → full runtime vectorize; missing/changed tools → supplement only
  those. This removes the cold-start warmup after a deploy.
- Regenerate after tools / `tool-intents.json` / the embedder change:
  `npx tsx tools/generate-tool-intents.ts` (enrich any uncached tools) then
  `npx tsx tools/generate-tool-embeddings.ts` (needs AI Core creds, e.g. a deploy
  worktree's `AICORE_*`). The embeddings generator fail-fasts if any tool is
  uncached. The bundle's fingerprint must match the target embedder — one AI Core
  bundle covers the `sap-ai-sdk` targets; `openai` targets fall back to the
  share-only path (still one vectorization, not N).

### LLM Provider

Configurable via `LLM_AGENT_PROVIDER` env var:
- **`sap-ai-sdk`** (default) — SAP AI Core Orchestration, models deployed in AI Launchpad
- **`openai`** — any OpenAI-compatible API (OpenAI, Azure OpenAI, Ollama, vLLM)
- **`anthropic`** / **`deepseek`** — direct provider APIs

For non-SAP providers: set `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL`.

## Key Dependencies

- `@sap/cds` ^9 - CAP framework
- `@modelcontextprotocol/sdk` ^1.23.0 - MCP protocol
- `@mcp-abap-adt/core` ^4.9.0 - ABAP MCP server implementation
- `@mcp-abap-adt/llm-agent` ^5.18.3 - SmartAgent pipeline, RAG, tool selection
- `@sap-cloud-sdk/*` - Destination resolution, HTTP client

## Code Style

- **Biome** for linting and formatting (replaced ESLint)
- Single quotes, 2-space indents, 100-char line width
- TypeScript strict mode enabled

## npm Package Verification

When checking whether an installed npm package contains specific code, always search inside `node_modules/` directly (e.g., `grep -r "pattern" node_modules/@scope/package/`). VS Code search and ripgrep skip `node_modules` by default due to `.gitignore`, which leads to false "not found" conclusions. The code may be there — you're just not looking in the right place.

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

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.
