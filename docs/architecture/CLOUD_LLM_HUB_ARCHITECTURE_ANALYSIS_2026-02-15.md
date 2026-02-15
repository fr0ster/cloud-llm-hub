# cloud-llm-hub: Top-to-Bottom Architecture (Detailed)

Date: 2026-02-15  
Scope: **`cloud-llm-hub` only** as the top-level integration layer.  
`mcp-abap-adt` is treated as a lower foundational dependency.

## 1. What `cloud-llm-hub` is in this system

`cloud-llm-hub` is a **platform integration hub** built on top of the base MCP core, solving enterprise concerns:

- hosts MCP endpoints inside a CAP service;
- adds an auth perimeter via XSUAA + CAP user context;
- introduces role-based access model (scopes, role templates, role collections);
- connects SAP ABAP via BTP Destination/Connectivity and Cloud Connector;
- provides managed deployment on BTP Cloud Foundry (srv + approuter + managed services);
- adds Agent/LLM integration (SAP AI Core + MCP client integration).

In short, `cloud-llm-hub` does not replace `mcp-abap-adt`; it **operationalizes and extends** it for BTP production environments.

### 1.1 Product intent: base vs enterprise iteration

Base `mcp-abap-adt` intent:

- provide a practical toolset for AI-assisted development and AI pair programming;
- make ABAP analysis and development workflows more convenient for individual developers/consultants.

`cloud-llm-hub` enterprise intent:

- keep the same AI-assisted development foundation, but move it into enterprise operations;
- enable teams to accumulate and retain development/support experience together as a shared organizational knowledge layer, so LLM-assisted workflows become progressively more valuable;
- increase effectiveness of both the LLM and the developer: the LLM absorbs repetitive routine work, while the developer focuses on decisions that require human judgment;
- enforce enterprise controls (role model and function-level authorization boundaries) around the same MCP capabilities.

### 1.2 Target consumer audience

Primary consumers of `cloud-llm-hub` are SAP-focused technical teams:

- SAP support engineers who need stable MCP-based operational access to ABAP systems.
- SAP developers (including ABAP developers and SAP consultants acting as developers).
- Internal enterprise teams integrating SAP workflows into controlled platform environments.

This project is intentionally optimized for engineering/support usage, not for a broad public consumer market.

### 1.3 Non-goals for product positioning

- It is not positioned as a public commercial API platform.
- It is not designed as a generic revenue pipeline product.
- It is not intended to prioritize non-SAP general-purpose developer audiences.

### 1.4 Exposed API classes (consumer vs technical)

Consumer-facing APIs (business usage):

- `POST /mcp/stream/http` for MCP tool-driven ABAP operations.
- `/odata/v4/agent/...` for agent chat/history/health flows used by support/developer users.

Technical/operational APIs (platform operations):

- `GET /odata/v4/mcp/Health()` for service liveness checks.
- `GET /odata/v4/mcp/ProbeDestination?destination=...` for destination/connectivity diagnostics.
- `InvokeTool` is retained only as a legacy/deprecated operational action.

## 2. Responsibility boundaries (critical)

### 2.1 What belongs to `cloud-llm-hub`

- CAP API and stream endpoint hosting:
  - `srv/server.ts`
  - `srv/mcp-proxy.ts`
  - `srv/*.cds`
- Auth/roles gateway:
  - `srv/auth.ts`
  - `xs-security.json`
  - `package.json` (`cds.requires.auth`)
- SAP context extraction and connection orchestration:
  - `srv/mcp-manager.ts`
  - `srv/connections/*`
- BTP destination/connectivity adaptation:
  - `srv/connections/destinationResolver.ts`
  - `srv/connections/CloudSdkAbapConnection.ts`
  - `srv/connections/connectivityProxy.ts`
- BTP CF deployment model:
  - `mta.yaml`
  - `app/router/*`
- Agent layer:
  - `srv/agent-service.ts`
  - `srv/agent-manager.ts`
  - `srv/agent-config.ts`

### 2.2 What remains in base `mcp-abap-adt`

- MCP protocol runtime (tool execution engine).
- ADT toolset and handlers.
- Base connection/auth libraries.
- Developer-first workflow focus for AI-assisted dev / AI pair programming.

## 3. Top-to-bottom architecture (stack walk)

## 3.1 Layer A — Client & Entry Layer

### Entry surfaces

Consumer-facing API:

- MCP stream endpoint:
  - `POST /mcp/stream/http` (custom Express route in `srv/server.ts`)
- Agent service endpoints:
  - `/odata/v4/agent/...`

Technical/operational API:

- CAP OData operational endpoints:
  - `GET /odata/v4/mcp/Health()`
  - `GET /odata/v4/mcp/ProbeDestination?destination=...`

### Role

- accept external requests;
- validate auth;
- forward into managed execution pipeline.

---

## 3.2 Layer B — Auth & Role Gateway (CAP + XSUAA)

### Components

- `srv/auth.cds`: contracts for `CheckAuth`, `CheckRoles`.
- `srv/auth.ts`: runtime handlers.
- `srv/server.ts`: middleware `ensureAuth` -> call `AuthService.CheckAuth`.
- `xs-security.json`: scope/role model.

### Implementation

- `CheckAuth`:
  - rejects anonymous/no-user context;
  - returns authenticated user id + roles.
- `CheckRoles(required[])`:
  - checks `req.user.is(role)`;
  - returns missing roles or `authorized: true`.

### Role model (XSUAA)

- Scopes:
  - `$XSAPPNAME.proxyAccess`
  - `$XSAPPNAME.MCP_Connect`
  - `$XSAPPNAME.MCP_Read`
  - `$XSAPPNAME.MCP_Admin`
  - `$XSAPPNAME.MCP_Connector`
- Role templates:
  - `CloudLLMHubProxy`
  - `MCP_Connector`
  - `MCP_Admin`
- Role collections:
  - `Cloud LLM Hub Proxy Access`
  - `MCP Connector Access`
  - `MCP Admin Access`

### Dev/prod auth behavior

- Dev (`cds.requires.auth.[development]`): mocked users (`alice`, `bob`).
- Prod: `kind: xsuaa`, `passport.strategy: JWT`.

---

## 3.3 Layer C — Stream Runtime Orchestrator

### Component

- `srv/server.ts`

### Responsibilities

- normalize transport headers (Content-Type/Accept for streamable HTTP);
- enforce auth middleware;
- dispatch to per-request MCP runtime creation;
- enforce transport policy (`/mcp/stream/sse` not supported);
- handle lifecycle (close/error/finally cleanup).

### Transport policy

- supported: `POST /mcp/stream/http`;
- `GET /mcp/stream/http` -> 405;
- `/mcp/stream/sse` -> 404 with migration hint to stream/http.

---

## 3.4 Layer D — MCP Manager (request-level composition root)

### Component

- `srv/mcp-manager.ts`

### Key functions

- `extractSapContext(req)`:
  - mode 1: destination mode (`X-SAP-Destination`);
  - mode 2: direct mode (`X-SAP-*`), validated via `validateAuthHeaders`.
- `createMCPServerForRequest(req)`:
  - creates connection;
  - creates `EmbeddableMcpServer` per request;
  - creates `StreamableHTTPServerTransport`;
  - connects server to transport;
  - returns cleanup lifecycle callback.

### Key architecture property

`cloud-llm-hub` runs with a **per-request MCP server model**:

- each request gets isolated connection/server/transport context;
- cleanup is guaranteed in `finally`;
- reduces cross-session and cross-tenant state leakage risks.

---

## 3.5 Layer E — Connection Strategy Layer

### Component

- `srv/connections/connectionFactory.ts`

### Strategy rule

- if `destinationName` exists -> `CloudSdkAbapConnection`;
- otherwise -> `createAbapConnection(...)` from `@mcp-abap-adt/connection`.

### Practical result

`cloud-llm-hub` supports both:

- enterprise destination-driven access (recommended on BTP);
- direct SAP header mode (compatibility and local scenarios).

---

## 3.6 Layer F — Destination & Connectivity Integration

### Component 1: `destinationResolver.ts`

- resolves destination via SAP Cloud SDK `getDestination`;
- extracts `url`, `proxyType`, `authentication`, `sap-client`, `CloudConnectorLocationId`;
- maps auth to `SapConfig.authType`:
  - `BasicAuthentication` -> `basic`
  - `OAuth2ClientCredentials` / `OAuth2SAMLBearerAssertion` -> `jwt`
- validates required destination metadata.

### Component 2: `CloudSdkAbapConnection.ts`

- implements `AbapConnection` over `executeHttpRequest`;
- handles CSRF flow, cookie/session headers, stateful/stateless mode;
- delegates auth/routing/proxy to Cloud SDK + destination infrastructure.

### Component 3: `connectivityProxy.ts`

- handles on-premise network scenarios via Connectivity/Cloud Connector.

---

## 3.7 Layer G — Embedded MCP Runtime Bridge

### Mechanics

- `cloud-llm-hub` instantiates `EmbeddableMcpServer` from `@mcp-abap-adt/core/server`;
- injects selected connection instance;
- MCP tool execution is handled by base runtime using hub-managed connection context.

### Why this matters

- `cloud-llm-hub` controls security/deployment/connectivity concerns;
- base MCP runtime handles protocol/tool execution concerns;
- clean separation of platform concerns vs protocol concerns.

---

## 3.8 Layer H — CAP OData Operational Surface

### `srv/mcp-proxy.ts`

- `Health()`:
  - operational service health check.
- `ProbeDestination(destination)`:
  - runtime destination reachability test;
  - returns proxy/auth/client/connectivity metadata + probe status.
- `InvokeTool`:
  - legacy action (returns deprecated guidance).

This is a dedicated operational API surface for DevOps/Support workflows.

---

## 3.9 Layer I — Agent / LLM Layer

### Components

- `srv/agent-config.ts`: env + VCAP config loader.
- `srv/agent-manager.ts`: provider setup, MCP client config, agent cache lifecycle.
- `srv/agent-service.ts`: CAP chat/health/history endpoints.

### LLM integration

- SAP AI Core service binding from `VCAP_SERVICES`;
- model/runtime params controlled by env vars (`LLM_AGENT_*`);
- HTTP auth to AI Core derived from service credentials.

### MCP integration for agent

- `MCPClientWrapper` built with endpoint + auth headers;
- `X-SAP-Destination` propagated into MCP proxy path;
- if MCP connectivity fails, agent continues in LLM-only degraded mode.

---

## 3.10 Layer J — BTP CF Deployment Layer

### `mta.yaml` topology

#### Modules

- `cloud-llm-hub-srv` (Node.js CAP runtime)
- `cloud-llm-hub` (approuter)

#### Resources

- `cloud-llm-hub-auth` (xsuaa)
- `cloud-llm-hub-destination`
- `cloud-llm-hub-connectivity`
- `cloud-llm-hub-ai-core`

### Deployment semantics

- approuter forwards auth token to srv;
- srv binds to auth/destination/connectivity/aicore services;
- Agent layer runtime config is injected via deployment env vars.

## 4. Detailed runtime flows

## 4.1 MCP Stream Request (destination mode)

1. Client -> `POST /mcp/stream/http`.
2. `ensureAuth` -> `AuthService.CheckAuth`.
3. `extractSapContext` detects `X-SAP-Destination`.
4. `resolveDestinationSapConfig` loads destination metadata.
5. `createConnection` -> `CloudSdkAbapConnection`.
6. `createMCPServerForRequest` creates embedded MCP server.
7. MCP tool execution -> SAP ADT via Cloud SDK path.
8. Response is streamed back.
9. Cleanup closes transport/resets connection.

## 4.2 MCP Stream Request (direct mode)

1. Client provides `X-SAP-URL` + auth headers.
2. `validateAuthHeaders` validates/prioritizes auth mode.
3. `SapConfig` is built.
4. `createConnection` -> base connection (`createAbapConnection`).
5. Same downstream path: embedded MCP server -> tool execution -> response -> cleanup.

## 4.3 Destination Probe

1. Client calls `ProbeDestination`.
2. CAP handler resolves destination and runs `executeHttpRequest`.
3. Returns connectivity/auth/proxy metadata + probe status.

## 4.4 Agent Chat

1. Client -> `AgentService.Chat(message)`.
2. Agent config is loaded (AI Core + MCP destination).
3. SAP AI provider is created.
4. Agent instance is created or loaded from cache.
5. Agent runs chat (with tools or LLM-only fallback).
6. Response text is returned.

## 5. Security model in detail

## 5.1 Perimeter

- XSUAA JWT at ingress via approuter/CAP.

## 5.2 Service-level checks

- middleware in `server.ts` calls `CheckAuth` before MCP stream processing.
- `CheckRoles` can be used as additional policy gate for sensitive operations.

## 5.3 Header trust boundaries

- Destination mode: trust boundary is `X-SAP-Destination` + BTP service bindings.
- Direct mode: trust boundary is `X-SAP-*` headers only after `validateAuthHeaders`.

## 5.4 Token handling

- MCP stream path does not maintain custom long-lived auth state inside hub; it relies on request context and platform bindings.
- Agent layer uses AI Core OAuth credentials from service binding.

## 6. Configuration model

## 6.1 Runtime config sources

- CAP auth mode: `package.json` (`cds.requires.auth`)
- XSUAA scopes/roles: `xs-security.json`
- deployment vars/services: `mta.yaml`
- Agent env vars: `LLM_AGENT_*`, `MCP_*`
- destination metadata: Destination Service + SAP Cloud SDK (`VCAP_SERVICES`)

## 6.2 Effective priority model (practical)

- perimeter auth in prod: XSUAA binding.
- SAP endpoint metadata in destination mode: Destination Service.
- LLM backend config: AI Core service binding + env overrides.

## 7. Observability and operations

## 7.1 Current state

- structured logging via `cds.log(...)` across auth/stream/destination/agent layers;
- operational CAP endpoints (`Health`, `ProbeDestination`);
- normalized error handling (`srv/lib/errorUtils.ts`).

## 7.2 Existing strengths

- explicit lifecycle logs for auth, stream runtime, destination resolution, agent connectivity;
- built-in degraded mode for agent when MCP is unavailable.

## 7.3 Improvements to consider

- p95/p99 latency metrics for MCP stream endpoint;
- end-to-end correlation ID propagation (approuter -> CAP -> MCP runtime -> SAP calls);
- alerting for degraded mode frequency.

## 8. Non-functional characteristics

## 8.1 Scalability

- stateless/per-request runtime model is suitable for horizontal scaling;
- minimized long-lived mutable state in request pipeline.

## 8.2 Isolation

- each MCP stream request gets isolated runtime objects (connection/server/transport);
- lower risk of cross-request contamination.

## 8.3 Compatibility

- supports both destination mode and direct mode;
- exposes both CAP OData and MCP stream surfaces for different clients/use cases.

## 9. What hub adds over base MCP (summary matrix)

- Auth gateway: `cloud-llm-hub` yes, base no.
- XSUAA role model: `cloud-llm-hub` yes, base no.
- BTP destination/connectivity orchestration: `cloud-llm-hub` yes.
- BTP CF MTA deployment topology: `cloud-llm-hub` yes.
- Agent + SAP AI Core integration: `cloud-llm-hub` yes.
- MCP protocol/tool engine: base yes, hub consumes.

## 10. Risks and control points

- role enforcement is partly middleware-driven rather than fully policy-annotated in CDS; policy consistency should be tightened.
- dual SAP access modes (destination/direct) require strict contract and regression testing for security parity.
- per-request server model requires continuous latency/CPU/memory monitoring under peak load.
- Agent runtime depends on correct service bindings/env; operational diagnostics playbook should be explicit.

## 11. Recommended architecture statement

`cloud-llm-hub` is a **CAP-based Integration Hub** that extends base `mcp-abap-adt` in BTP CF through:

- security perimeter (XSUAA + role model),
- destination-driven SAP connectivity (including on-prem via Connectivity/Cloud Connector),
- per-request embedded MCP runtime orchestration,
- enterprise deployment topology,
- integrated Agent/LLM surface.

This is the complete top-to-bottom architecture profile of the top-level system layer.
