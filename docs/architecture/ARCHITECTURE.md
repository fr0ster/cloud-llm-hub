# Cloud LLM Hub — Developer Architecture Guide

> **Version:** 3.0.0 | **Stack:** SAP CAP (Node.js) + TypeScript + SAP BTP
> **Purpose:** This document gives a new developer everything needed to understand, navigate, and modify the codebase.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Relationship with mcp-abap-adt](#2-relationship-with-mcp-abap-adt)
3. [Project Structure](#3-project-structure)
4. [Module Map & Responsibilities](#4-module-map--responsibilities)
5. [Module Dependency Graph](#5-module-dependency-graph)
6. [Request Lifecycle — MCP Proxy Flow](#6-request-lifecycle--mcp-proxy-flow)
7. [Request Lifecycle — Agent / LLM Flow](#7-request-lifecycle--agent--llm-flow)
8. [Authentication & Authorization Flow](#8-authentication--authorization-flow)
9. [Connection Strategy](#9-connection-strategy)
10. [SAP BTP Deployment Architecture](#10-sap-btp-deployment-architecture)
11. [CDS Service Model](#11-cds-service-model)
12. [Configuration & Environment](#12-configuration--environment)
13. [External Dependencies](#13-external-dependencies)
14. [Testing Strategy](#14-testing-strategy)
15. [Key Design Decisions](#15-key-design-decisions)

---

## 1. High-Level Overview

Cloud LLM Hub is an **enterprise MCP orchestrator and LLM-agent platform** built on SAP CAP. It connects AI assistants (Cline, Claude Desktop, n8n) and autonomous LLM agents with SAP ABAP systems, managing transport, authentication, destination resolution, and agent orchestration. It has two main runtime paths:

```mermaid
graph LR
    subgraph Clients
        CL[Cline / Claude Desktop]
        N8N[n8n / CI-CD]
        APP[Custom Apps]
    end

    subgraph "Cloud LLM Hub (CAP)"
        AR[Approuter]
        SRV[CAP Server]
        MCP_PROXY[MCP Gateway<br/>Stream-HTTP]
        AGENT[Agent Service<br/>OData]
        AUTH[Auth Service]
    end

    subgraph "SAP Backend"
        ABAP[SAP ABAP System]
        AICORE[SAP AI Core]
    end

    CL -->|Stream-HTTP| AR
    N8N -->|Stream-HTTP| AR
    APP -->|OData| AR

    AR --> SRV
    SRV --> MCP_PROXY
    SRV --> AGENT
    SRV --> AUTH

    MCP_PROXY -->|ADT Requests| ABAP
    AGENT -->|LLM Chat| AICORE
    AGENT -.->|MCP Tools| MCP_PROXY
```

**Two runtime paths:**

| Path | Entry Point | Purpose |
|------|-------------|---------|
| **MCP Gateway** | `POST /mcp/stream/http` | Orchestrates MCP protocol requests: auth, destination resolution, connection creation, then delegates to embedded `mcp-abap-adt` server; used by AI assistants directly |
| **Agent Service** | `GET/POST /agent/*` (OData) | LLM-agent endpoint: receives natural language → calls SAP AI Core LLM → uses MCP tools via internal orchestration loop |

---

## 2. Relationship with mcp-abap-adt

**`mcp-abap-adt`** is a separate open-source project that implements the actual MCP server with ABAP/ADT tools. **Cloud LLM Hub does NOT implement MCP tools itself** — it uses `mcp-abap-adt` as an embedded component, orchestrating connections, authentication, and agent workflows around it.

### How the two projects relate

```mermaid
flowchart LR
    A(Request) --> B(cloud-llm-hub<br/>Auth + Destination<br/>+ Connection) -- injects<br/>connection --> C(mcp-abap-adt<br/>MCP Server<br/>+ ABAP Tools) --> D(SAP ABAP)

    style B fill:#16a34a,color:#fff,font-size:16px
    style C fill:#2563eb,color:#fff,font-size:16px
    style D fill:#9333ea,color:#fff,font-size:16px
```

**Key point:** `mcp-abap-adt` is the **base implementation** of the MCP server. Cloud LLM Hub **delegates all MCP work** to it. The delegation pattern:

1. Cloud LLM Hub handles everything **before** MCP: auth, destination resolution, connection creation
2. Cloud LLM Hub creates `EmbeddableMcpServer` (from `@mcp-abap-adt/core`) and **injects** the connection
3. From that point, `mcp-abap-adt` does **all** the MCP protocol handling and ABAP tool execution
4. Cloud LLM Hub never calls ABAP tools directly — it only provides the connection

### What cloud-llm-hub uses from `@mcp-abap-adt/*`

| Package | Role | Where used |
|---------|------|------------|
| **`core`** (`^8.11.0`) | `EmbeddableMcpServer` — the MCP server with all ABAP tools. **This is where all MCP work happens.** | `mcp-manager.ts` |
| **`connection`** | `AbapConnection` interface + base classes that cloud-llm-hub implements | `connections/*` |
| **`llm-agent`** (`^20.6.0`) | Public interface/contract surface the code programs against — `IRag`, `IMcpClient`, `ISubAgent`, `IFinalizer`, `McpToolResult`, `ToolCallRecord`, etc. (re-exports `interfaces` + `types`) | Throughout `srv/` (type imports) |
| **`llm-agent-libs`** (`^20.6.0`) | `SmartAgent`, `SmartAgentBuilder`, `DagPlanInterpreter`, `SmartAgentSubAgent` — the SmartAgent + RAG + DAG-coordinator **implementation** | `agent-manager.ts` |
| **`llm-agent-mcp`** (`^20.6.0`) | `McpClientAdapter` — wraps the embedded MCP client as an `IMcpClient` | `agent-manager.ts` |
| **`adt-clients`** (`^7.6.0`) | ADT HTTP clients underlying the ABAP tools | `mcp-abap-adt` (transitive) |
| **`header-validator`** | Validates SAP auth headers for direct connections | `mcp-manager.ts` |
| **`interfaces`** (`^11.3.0`) | Shared contracts: `ILogger`, `IAbapConnection`, `HEADER_*` constants | Throughout `srv/` |
| **`logger`** | Base logging implementation | `lib/logger.ts` |

### Implications for developers

- **Adding/modifying MCP tools** (e.g., new ABAP read operation) → change `mcp-abap-adt`, NOT this project
- **Adding/modifying transport, auth, routing, BTP integration** → change this project (`srv/`)
- **Adding new connection type** (e.g., new auth method) → implement `AbapConnection` interface in `srv/connections/`, register in `connectionFactory.ts`
- **Changing LLM provider behavior** → if it's provider abstraction → `mcp-abap-adt/llm-proxy`; if it's SAP AI Core binding specifics → `agent-manager.ts` in this project
- **Updating `mcp-abap-adt` version** → update in `package.json`, test that `EmbeddableMcpServer` API hasn't changed, run integration tests

---

## 3. Project Structure

```mermaid
graph TD
    ROOT["cloud-llm-hub/"]

    ROOT --> SRV_DIR["srv/ — Backend source code"]
    ROOT --> APP_DIR["app/ — SAP BTP Approuter"]
    ROOT --> DB_DIR["db/ — CAP data models (reserved)"]
    ROOT --> DOCS_DIR["docs/ — Documentation"]
    ROOT --> TEST_DIR["test/ — Integration & smoke tests"]
    ROOT --> TOOLS_DIR["tools/ — Utility scripts"]

    SRV_DIR --> SRV_CORE["Core modules<br/>server.ts, mcp-proxy.ts,<br/>mcp-manager.ts"]
    SRV_DIR --> SRV_AGENT["Agent modules<br/>agent-service.ts,<br/>agent-manager.ts,<br/>agent-config.ts"]
    SRV_DIR --> SRV_AUTH["Auth module<br/>auth.ts, auth.cds"]
    SRV_DIR --> SRV_CONN["connections/<br/>Connection strategies"]
    SRV_DIR --> SRV_LIB["lib/<br/>errorUtils.ts, logger.ts"]
    SRV_DIR --> SRV_CDS["CDS models<br/>mcp-proxy.cds,<br/>agent-service.cds"]

    style SRV_DIR fill:#2563eb,color:#fff
    style SRV_CORE fill:#1e40af,color:#fff
    style SRV_AGENT fill:#1e40af,color:#fff
    style SRV_CONN fill:#1e40af,color:#fff
```

### File Layout

```
cloud-llm-hub/
├── srv/                          # ⭐ All backend logic
│   ├── server.ts                 # CAP bootstrap, Express middleware, Stream-HTTP endpoint
│   ├── mcp-proxy.ts              # CAP service handlers (Health, ProbeDestination, InvokeTool)
│   ├── mcp-proxy.cds             # CDS model for McpProxyService
│   ├── mcp-manager.ts            # Per-request MCP server creation factory
│   ├── agent-service.ts          # CAP service handlers for Agent (Chat, Health)
│   ├── agent-service.cds         # CDS model for AgentService
│   ├── agent-manager.ts          # LLM provider creation, agent caching, MCP client
│   ├── agent-config.ts           # Agent configuration from env vars / VCAP_SERVICES
│   ├── auth.ts                   # CAP AuthService handlers (CheckAuth, CheckRoles)
│   ├── auth.cds                  # CDS model for AuthService
│   ├── env-setup.ts              # Environment bootstrap (must be imported first)
│   ├── connections/              # Connection strategy implementations
│   │   ├── index.ts              # Barrel exports
│   │   ├── connectionFactory.ts  # Factory: picks CloudSdk vs Direct connection
│   │   ├── CloudSdkAbapConnection.ts  # BTP Destination-based connection
│   │   ├── destinationResolver.ts     # SAP Cloud SDK destination resolution
│   │   ├── connectivityProxy.ts       # On-premise Cloud Connector support
│   │   └── BtpOnPremDestinationConnection.ts  # On-prem connection via proxy
│   ├── openai-handler.ts         # OpenAI-compatible /v1/* HTTP handlers
│   └── lib/                      # Shared utilities
│       ├── errorUtils.ts         # Centralized error handling
│       ├── logger.ts             # Logger adapter wrapping @mcp-abap-adt/logger
│       ├── btp-oauth.ts          # Shared BTP OAuth2 token helper
│       ├── btp-destinations.ts   # BTP Destination Service client
│       └── ai-core-models.ts     # AI Core model list (cached)
├── app/
│   ├── chat/webapp/              # Browser chat UI (vanilla HTML/JS)
│   │   └── index.html            # Terminal-style chat, file artifact cards, streaming parser
│   └── router/                   # SAP BTP Approuter (xs-app.json routes)
├── test/                         # Tests (YAML-driven integration, smoke, unit)
├── tools/                        # DevOps scripts (cline config sync, env setup, deploy)
├── mta.yaml                      # MTA deployment descriptor
├── xs-security.json              # XSUAA scopes, roles, role-collections
├── package.json                  # Dependencies & npm scripts
└── tsconfig.json                 # TypeScript configuration
```

---

## 4. Module Map & Responsibilities

```mermaid
graph TD
    subgraph ENTRY["Layer 1 — Entry Points  (CAP auto-loaded)"]
        direction LR
        A["server.ts
        ━━━━━━━━━
        CAP Bootstrap
        Express middleware
        Stream-HTTP endpoint
        Auth middleware"]
        B["mcp-proxy.ts
        ━━━━━━━━━
        CAP OData handlers
        Health check
        ProbeDestination"]
        C["agent-service.ts
        ━━━━━━━━━
        CAP OData handlers
        Chat endpoint
        Health check"]
    end

    subgraph CORE["Layer 2 — Core Logic"]
        direction LR
        E["auth.ts
        ━━━━━━━━━
        CheckAuth handler
        CheckRoles handler
        XSUAA integration"]
        D["mcp-manager.ts
        ━━━━━━━━━
        extractSapContext
        createMCPServer
        ForRequest
        Per-request lifecycle"]
        F["agent-manager.ts
        ━━━━━━━━━
        createLLMProvider
        getAgent
        Agent caching
        MCP client config"]
    end

    subgraph INFRA["Layer 3 — Infrastructure"]
        direction LR
        H["lib/
        ━━━━━━━━━
        errorUtils
        logger
        loggerAdapter"]
        G["connections/
        ━━━━━━━━━
        connectionFactory
        CloudSdkAbapConn
        BtpOnPremConn
        destinationResolver
        connectivityProxy"]
        I["agent-config.ts
        ━━━━━━━━━
        loadAgentConfig
        getAgentConfig
        AI Core service binding
        Env var reading"]
    end

    A --> E
    A --> D
    B --> D
    C --> F

    D --> G
    D --> H
    F --> I
    F -.->|MCP tools| D
    G --> H

    style A fill:#dc2626,color:#fff
    style B fill:#dc2626,color:#fff
    style C fill:#dc2626,color:#fff
    style D fill:#ea580c,color:#fff
    style E fill:#16a34a,color:#fff
    style F fill:#ea580c,color:#fff
    style G fill:#2563eb,color:#fff
    style H fill:#6b7280,color:#fff
    style I fill:#7c3aed,color:#fff
```

### Module Details

| Module | File | Responsibility |
|--------|------|---------------|
| **CAP Bootstrap** | `server.ts` | Registers Express middleware on `cds.on('bootstrap')`. Mounts `/mcp/stream/http` POST endpoint. Handles Content-Type normalization for Cline. Calls `requireAuth` → `AuthService.CheckAuth` before each request. |
| **MCP Proxy Service** | `mcp-proxy.ts` + `.cds` | CAP service at path `/mcp`. Exposes `Health()`, `ProbeDestination(destination)`, `InvokeTool()` (deprecated). Uses SAP Cloud SDK `executeHttpRequest` for destination probing. |
| **MCP Manager** | `mcp-manager.ts` | Core factory. `extractSapContext()` reads SAP config from HTTP headers (destination or direct). `createMCPServerForRequest()` creates fresh Connection → EmbeddableMcpServer → StreamableHTTPServerTransport per request. |
| **Agent Service** | `agent-service.ts` + `.cds` | CAP service at path `/agent`. Exposes `Chat(message)`, `GetHistory()`, `ClearHistory()`, `Health()`. Delegates to `agent-manager.ts`. |
| **Agent Manager** | `agent-manager.ts` | Creates SmartAgent with RAG pipeline via SmartAgentBuilder. Manages per-destination state (MCP adapter + tools RAG). Shared embedder and facts/feedback/state RAG stores across destinations. Background + on-demand vectorization for all destinations (no privileged primary); requests wait for a destination via `ensureDestinationInit`. LLM provider is configurable via `LLM_AGENT_PROVIDER` — supports `sap-ai-sdk` (default), `openai` (any OpenAI-compatible API via `baseURL`), `anthropic`, and `deepseek`. Wires the honesty-controller DAG coordinator: `buildAgentForDestination` + `buildExecutorWorker` (v6.28+). |
| **Honesty Reviewer** | `lib/{recording-mcp-client,reviewer-core,notice-finalizer,notify-policy,step-reviewer}.ts` | Result-based honesty guard (v6.28+). `recording-mcp-client.ts` decorates `IMcpClient` to capture each tool's `McpToolResult` per `traceId`; `reviewer-core.ts` + `notice-finalizer.ts` implement `IFinalizer`/`NoticeFinalizer` comparing response claims against captured results; `notify-policy.ts` decides notice wording; `step-reviewer.ts` provides `evaluateGated` (deterministic check + token-gated LLM critic) which `NoticeFinalizer` invokes. The controller wiring itself lives in `agent-manager.ts` (`buildAgentForDestination` → `builder.withDagCoordinator({ …, finalizer: new NoticeFinalizer(recMcp, …) })`). Kill-switch: `LLM_AGENT_STEP_REVIEW_ENABLED=false`. |
| **OpenAI Handler** | `openai-handler.ts` | OpenAI-compatible HTTP handlers: `POST /v1/chat/completions` (streaming + JSON), `GET /v1/models` (with destination metadata), `GET /v1/usage`. Reads `X-SAP-Destination` header for per-request destination switching. |
| **Agent Config** | `agent-config.ts` | Reads `LLM_AGENT_MODEL`, `LLM_AGENT_TEMPERATURE`, `LLM_AGENT_MAX_TOKENS`, `LLM_AGENT_MCP_DESTINATION` from env vars. Reads AI Core service binding from `VCAP_SERVICES`. Singleton pattern. |
| **Auth Service** | `auth.ts` + `.cds` | CAP service at path `/auth`. `CheckAuth()` validates user identity. `CheckRoles(required)` checks specific roles. Used by `server.ts` middleware for `/mcp/*` routes. |
| **Connection Factory** | `connections/connectionFactory.ts` | Decision: `destinationName` → `CloudSdkAbapConnection`; no destination → `createAbapConnection` (direct). |
| **CloudSdk Connection** | `connections/CloudSdkAbapConnection.ts` | `AbapConnection` implementation using `executeHttpRequest` from SAP Cloud SDK. Auto destination resolution, auth, proxy, CSRF token management. |
| **Destination Resolver** | `connections/destinationResolver.ts` | Resolves BTP Destination to `SapConfig` via `getDestination()`. Handles `BasicAuthentication`, `OAuth2ClientCredentials`, `OAuth2SAMLBearerAssertion`. |
| **Connectivity Proxy** | `connections/connectivityProxy.ts` | On-premise support: loads Connectivity service credentials, obtains tokens, builds proxy config for Cloud Connector. |
| **BTP OnPrem Connection** | `connections/BtpOnPremDestinationConnection.ts` | Extends `OnPremAbapConnection` with BTP proxy headers (`Proxy-Authorization`, `SAP-Connectivity-SCC-Location_ID`). |
| **Error Utils** | `lib/errorUtils.ts` | `logErrorSafely()`, `formatErrorMessage()`, `createErrorResponse()`. Handles AxiosError, Cloud SDK errors, and standard errors safely. |
| **Logger** | `lib/logger.ts` | Wraps `@mcp-abap-adt/logger` with extended CSRF/TLS methods. Exports `logger` and `loggerAdapter` (ILogger interface). |
| **Env Setup** | `env-setup.ts` | **Must be imported first.** Sets `MCP_SKIP_AUTO_START`, `MCP_SKIP_ENV_LOAD`. Loads `.env` only in local dev. |

---

## 5. Module Dependency Graph

```mermaid
graph TB
    subgraph "Entry Points (CAP auto-loads)"
        server_ts["server.ts"]
        mcp_proxy_ts["mcp-proxy.ts"]
        agent_service_ts["agent-service.ts"]
        auth_ts["auth.ts"]
    end

    subgraph "Core Logic"
        mcp_manager["mcp-manager.ts"]
        agent_manager["agent-manager.ts"]
        agent_config["agent-config.ts"]
    end

    subgraph "connections/"
        conn_factory["connectionFactory.ts"]
        cloud_sdk_conn["CloudSdkAbapConnection.ts"]
        dest_resolver["destinationResolver.ts"]
        conn_proxy["connectivityProxy.ts"]
        btp_onprem["BtpOnPremDestinationConnection.ts"]
        conn_index["index.ts (barrel)"]
    end

    subgraph "lib/"
        error_utils["errorUtils.ts"]
        logger_mod["logger.ts"]
    end

    subgraph "External Packages"
        mcp_adt_core["@mcp-abap-adt/core"]
        mcp_adt_conn["@mcp-abap-adt/connection"]
        mcp_adt_hv["@mcp-abap-adt/header-validator"]
        mcp_adt_iface["@mcp-abap-adt/interfaces"]
        mcp_adt_logger["@mcp-abap-adt/logger"]
        mcp_adt_llm["@mcp-abap-adt/llm-proxy"]
        mcp_sdk["@modelcontextprotocol/sdk"]
        sap_cds["@sap/cds"]
        sap_cloud_sdk["@sap-cloud-sdk/*"]
        sap_xsenv["@sap/xsenv"]
    end

    env_setup["env-setup.ts"]

    %% server.ts dependencies
    server_ts --> env_setup
    server_ts --> mcp_manager
    server_ts --> error_utils
    server_ts --> sap_cds

    %% mcp-proxy.ts dependencies
    mcp_proxy_ts --> sap_cds
    mcp_proxy_ts --> sap_cloud_sdk
    mcp_proxy_ts --> error_utils

    %% mcp-manager.ts dependencies
    mcp_manager --> env_setup
    mcp_manager --> conn_factory
    mcp_manager --> conn_index
    mcp_manager --> dest_resolver
    mcp_manager --> error_utils
    mcp_manager --> logger_mod
    mcp_manager --> mcp_adt_core
    mcp_manager --> mcp_adt_conn
    mcp_manager --> mcp_adt_hv
    mcp_manager --> mcp_adt_iface
    mcp_manager --> mcp_sdk

    %% agent-service.ts dependencies
    agent_service_ts --> agent_config
    agent_service_ts --> agent_manager
    agent_service_ts --> mcp_adt_llm

    %% agent-manager.ts dependencies
    agent_manager --> agent_config
    agent_manager --> mcp_adt_llm

    %% agent-config.ts dependencies
    agent_config --> sap_cds

    %% auth.ts dependencies
    auth_ts --> sap_cds

    %% connectionFactory.ts dependencies
    conn_factory --> cloud_sdk_conn
    conn_factory --> mcp_adt_conn
    conn_factory --> logger_mod

    %% CloudSdkAbapConnection.ts dependencies
    cloud_sdk_conn --> env_setup
    cloud_sdk_conn --> mcp_adt_conn
    cloud_sdk_conn --> sap_cloud_sdk
    cloud_sdk_conn --> logger_mod
    cloud_sdk_conn --> error_utils

    %% destinationResolver.ts dependencies
    dest_resolver --> mcp_adt_conn
    dest_resolver --> sap_cloud_sdk
    dest_resolver --> sap_xsenv
    dest_resolver --> error_utils

    %% connectivityProxy.ts dependencies
    conn_proxy --> sap_xsenv
    conn_proxy --> btp_onprem
    conn_proxy --> mcp_adt_conn

    %% BtpOnPremDestinationConnection.ts dependencies
    btp_onprem --> mcp_adt_conn
    btp_onprem --> logger_mod

    %% logger.ts dependencies
    logger_mod --> mcp_adt_logger
    logger_mod --> mcp_adt_iface

    %% error_utils dependencies
    error_utils --> mcp_adt_conn

    style server_ts fill:#dc2626,color:#fff
    style mcp_manager fill:#ea580c,color:#fff
    style agent_manager fill:#ea580c,color:#fff
    style conn_factory fill:#2563eb,color:#fff
    style cloud_sdk_conn fill:#2563eb,color:#fff
    style dest_resolver fill:#2563eb,color:#fff
    style env_setup fill:#9333ea,color:#fff
```

---

## 6. Request Lifecycle — MCP Proxy Flow

This is the primary flow when an AI assistant (Cline, Claude Desktop) sends an MCP request.

#### Step 1 — Authentication

```mermaid
sequenceDiagram
    participant Client as AI Assistant
    participant AR as Approuter
    participant MW as server.ts
    participant Auth as AuthService

    Client->>AR: POST /mcp/stream/http
    AR->>MW: Forward with JWT
    MW->>Auth: CheckAuth(req)
    Auth-->>MW: authenticated, id, roles
    MW->>MW: handleStreamHTTP(req, res)
```

#### Step 2 — Create Connection + MCP Server

```mermaid
sequenceDiagram
    participant Handler as server.ts
    participant Mgr as mcp-manager.ts
    participant Dest as destinationResolver
    participant Conn as connectionFactory

    Handler->>Mgr: createMCPServerForRequest(req)
    Mgr->>Mgr: extractSapContext(req)

    alt BTP Destination
        Mgr->>Dest: resolveDestinationSapConfig(name)
        Dest-->>Mgr: sapConfig + authType
        Mgr->>Conn: createConnection(sapConfig, dest)
    else Direct connection
        Mgr->>Mgr: validateAuthHeaders
        Mgr->>Conn: createConnection(sapConfig)
    end

    Mgr->>Mgr: new EmbeddableMcpServer(connection)
    Mgr->>Mgr: new StreamableHTTPTransport
    Mgr-->>Handler: server + transport + cleanup
```

#### Step 3 — Execute MCP Request

```mermaid
sequenceDiagram
    participant Handler as server.ts
    participant Transport as HTTPTransport
    participant MCP as EmbeddableMcpServer
    participant ABAP as SAP ABAP

    Handler->>Transport: handleRequest(req, res, body)
    Transport->>MCP: JSON-RPC request
    MCP->>ABAP: ADT HTTP call
    ABAP-->>MCP: ADT response
    MCP-->>Transport: MCP response
    Transport-->>Handler: HTTP response
    Handler->>Handler: cleanup()
```

### Per-Request Architecture (Key Design)

Each HTTP request creates **three fresh objects** — no shared state between requests:

```mermaid
graph LR
    REQ[HTTP Request] --> CONN[New AbapConnection]
    REQ --> SRV[New EmbeddableMcpServer]
    REQ --> TRANS[New StreamableHTTPTransport]

    CONN --> SRV
    SRV --> TRANS

    TRANS --> RES[HTTP Response]

    style REQ fill:#dc2626,color:#fff
    style CONN fill:#2563eb,color:#fff
    style SRV fill:#2563eb,color:#fff
    style TRANS fill:#2563eb,color:#fff
    style RES fill:#16a34a,color:#fff
```

---

## 7. Request Lifecycle — Agent / LLM Flow

#### Step 1 — Config + Provider

```mermaid
sequenceDiagram
    participant Client as App / User
    participant Srv as AgentService
    participant Cfg as agent-config.ts
    participant Mgr as agent-manager.ts

    Client->>Srv: POST /agent/Chat {message}
    Srv->>Cfg: getAgentConfig()
    Cfg-->>Srv: model, temperature, AI Core binding
    Srv->>Mgr: createLLMProvider(config)
    Mgr->>Mgr: Get OAuth2 token from AI Core
    Mgr-->>Srv: SapCoreAIProvider
```

#### Step 2 — LLM Call

```mermaid
sequenceDiagram
    participant Srv as AgentService
    participant Provider as SapCoreAIProvider
    participant AICore as SAP AI Core

    Srv->>Provider: provider.chat(messages)
    Provider->>AICore: POST /chat/completions
    AICore-->>Provider: LLM response
    Provider-->>Srv: response.content
    Srv-->>Srv: return to client
```

#### Step 3 — Agent Mode (optional, with MCP tools)

```mermaid
sequenceDiagram
    participant Agent as SapCoreAIAgent
    participant MCP as MCPClientWrapper
    participant Proxy as /mcp/stream/http

    Agent->>MCP: connect to own MCP Gateway
    Agent->>Agent: LLM decides which tool to call
    Agent->>MCP: call MCP tool
    MCP->>Proxy: POST /mcp/stream/http
    Proxy-->>MCP: tool result
    MCP-->>Agent: result for next LLM step
```

#### Step 4 — Honesty Controller (DAG coordinator + reviewer) *(v6.28+)*

Every channel that reaches the destination agent — `execute_step`, `/v1/chat/completions`, and `/v1/messages` — now runs through an explicit **controller** built on the imported llm-agent **DAG-coordinator** interfaces, not the bare SmartAgent loop:

```mermaid
sequenceDiagram
    participant Chan as execute_step / v1 chat / v1 messages
    participant Coord as DAG Coordinator
    participant Exec as Executor Worker (SmartAgent, ISubAgent)
    participant Rec as RecordingMcpClient
    participant Rev as Reviewer (NoticeFinalizer / IFinalizer)

    Chan->>Coord: request
    Coord->>Exec: dispatch (coordinator-less worker)
    Exec->>Rec: run MCP tools
    Rec-->>Exec: McpToolResult (captured per traceId)
    Exec-->>Coord: response text (streamed live to Chan)
    Coord->>Rev: response CLAIMS vs captured tool RESULTS
    Rev-->>Chan: trailing UNVERIFIED_WRITE: notice (only on contradiction)
```

- The SmartAgent itself becomes a **coordinator-less executor worker** — it no longer owns the top-level loop.
- The reviewer compares what the response text **claims** to have written against the **actual tool results**, not tool names (`CreateDomain` self-activates via `activate:true`, so name-only matching false-positives).
- **NOTICE-ONLY**: the executor's content still streams live; the notice is appended as a trailing chunk. It is a soft warning ("verify against the system"), never a hard block — the consumer decides.
- Uniform across all three channels (previously this existed only on `execute_step`). Disabled entirely via `LLM_AGENT_STEP_REVIEW_ENABLED=false`. Not wired into the LLM-only path (no ABAP tools → nothing to verify).

---

## 8. Authentication & Authorization Flow

```mermaid
graph TB
    subgraph XSUAA["XSUAA Security Model"]
        S1["proxyAccess"]
        S2["MCP_Connect"]
        S3["MCP_Read"]
        S4["MCP_Admin"]
        S5["MCP_Connector"]

        RT1["CloudLLMHubProxy
        Role Template"] --> S1
        RT2["MCP_Connector
        Role Template"] --> S2
        RT2 --> S3
        RT3["MCP_Admin
        Role Template"] --> S4
        RT3 --> S2
        RT3 --> S3

        RC1["Cloud LLM Hub Proxy Access"] --> RT1
        RC2["MCP Connector Access"] --> RT2
        RC3["MCP Admin Access"] --> RT3
    end

    subgraph AUTH_FLOW["Runtime Auth Flow"]
        REQ["Incoming Request
        + JWT / Basic Auth"]
        MW["Express Middleware
        ensureAuth"]
        CAPS["cds.connect.to
        AuthService"]
        CA["CheckAuth handler
        auth.ts"]
        CR["CheckRoles handler
        auth.ts"]

        REQ --> MW
        MW --> CAPS
        CAPS --> CA
        CA -->|Success| HANDLER["MCP/Agent Handler"]
        CA -->|401| REJECT["Reject Unauthorized"]
        HANDLER -.-> CR
    end

    style RC1 fill:#f59e0b,color:#000
    style RC2 fill:#f59e0b,color:#000
    style RC3 fill:#f59e0b,color:#000
    style CA fill:#16a34a,color:#fff
```

### Auth Modes

| Environment | Auth Kind | Details |
|------------|-----------|---------|
| **Development** (`cds watch`) | Mocked | Users `alice` (MCP_Connector + MCP_Admin) and `bob` (MCP_Connector) |
| **Production** (BTP) | XSUAA JWT | Token validated by CAP middleware, roles from JWT claims |

---

## 9. Connection Strategy

```mermaid
graph TB
    REQ[HTTP Request Headers]

    REQ -->|"Has X-SAP-Destination?"| CHECK{Destination<br/>header?}

    CHECK -->|Yes| DEST_PATH["Destination Path"]
    CHECK -->|No| DIRECT_PATH["Direct Path"]

    subgraph "Destination Path (BTP)"
        DEST_PATH --> DR[destinationResolver.ts<br/>getDestination via Cloud SDK]
        DR --> AUTH_CHECK{Auth Type?}

        AUTH_CHECK -->|BasicAuthentication| CLOUD_SDK1[CloudSdkAbapConnection<br/>executeHttpRequest]
        AUTH_CHECK -->|OAuth2ClientCredentials| CLOUD_SDK2[CloudSdkAbapConnection<br/>Auto token management]
        AUTH_CHECK -->|OAuth2SAMLBearerAssertion| CLOUD_SDK3[CloudSdkAbapConnection<br/>Principal Propagation]

        DR --> PROXY_CHECK{ProxyType?}
        PROXY_CHECK -->|OnPremise| ONPREM[Cloud Connector<br/>Connectivity Service]
        PROXY_CHECK -->|Internet| INTERNET[Direct HTTPS]
    end

    subgraph "Direct Path"
        DIRECT_PATH --> HV[header-validator<br/>validateAuthHeaders]
        HV --> DIRECT_AUTH{Auth?}

        DIRECT_AUTH -->|Basic| BASIC_CONN[createAbapConnection<br/>username/password via axios]
        DIRECT_AUTH -->|JWT| JWT_CONN[createAbapConnection<br/>Bearer token via axios]
    end

    style DEST_PATH fill:#2563eb,color:#fff
    style DIRECT_PATH fill:#16a34a,color:#fff
    style CLOUD_SDK1 fill:#1e40af,color:#fff
    style CLOUD_SDK2 fill:#1e40af,color:#fff
    style CLOUD_SDK3 fill:#1e40af,color:#fff
    style BASIC_CONN fill:#15803d,color:#fff
    style JWT_CONN fill:#15803d,color:#fff
```

### Connection Classes

```mermaid
classDiagram
    class AbapConnection {
        <<interface>>
        +getConfig() SapConfig
        +getSessionId() string
        +setSessionType(type)
        +connect()
        +reset()
        +getBaseUrl() string
        +getAuthHeaders() Record
        +makeAdtRequest(options) IAdtResponse
    }

    class CloudSdkAbapConnection {
        -csrfToken: string
        -cookies: string
        -destinationName: string
        +makeAdtRequest(options)
        -ensureFreshCsrfToken(url)
        -fetchCsrfToken(url)
    }

    class BtpOnPremDestinationConnection {
        -proxySettings: ConnectivityProxyConfig
        +updateProxyAuthorization(header)
        +updatePrincipalPropagation(token)
        -buildProxyAgent()
    }

    class BaseAbapConnection {
        <<from @mcp-abap-adt/connection>>
    }

    class OnPremAbapConnection {
        <<from @mcp-abap-adt/connection>>
    }

    AbapConnection <|.. CloudSdkAbapConnection
    AbapConnection <|.. BaseAbapConnection
    OnPremAbapConnection <|-- BtpOnPremDestinationConnection
    BaseAbapConnection <|-- OnPremAbapConnection

    class connectionFactory {
        +createConnection(options) AbapConnection
        +isCloudSdkConnection(conn) boolean
        +getConnectionTypeName(conn) string
    }

    connectionFactory --> CloudSdkAbapConnection : destinationName present
    connectionFactory --> BaseAbapConnection : direct URL
```

---

## 10. SAP BTP Deployment Architecture

```mermaid
graph TB
    subgraph "SAP BTP Space"
        subgraph "Applications"
            APPROUTER["cloud-llm-hub<br/>(Approuter)<br/>━━━━━━━━━<br/>Type: approuter.nodejs<br/>Memory: 256MB"]
            SRV_APP["cloud-llm-hub-srv<br/>(CAP Server)<br/>━━━━━━━━━<br/>Type: nodejs<br/>Instances: 1"]
        end

        subgraph "Services (Resources)"
            XSUAA["cloud-llm-hub-auth<br/>━━━━━━━━━<br/>Service: xsuaa<br/>Plan: application"]
            DEST["cloud-llm-hub-destination<br/>━━━━━━━━━<br/>Service: destination<br/>Plan: lite"]
            CONN["cloud-llm-hub-connectivity<br/>━━━━━━━━━<br/>Service: connectivity<br/>Plan: lite"]
            AICORE_SVC["cloud-llm-hub-ai-core<br/>━━━━━━━━━<br/>Service: aicore<br/>Plan: extended"]
        end

        APPROUTER -->|"srv-api<br/>destination"| SRV_APP
        SRV_APP --> XSUAA
        SRV_APP --> DEST
        SRV_APP --> CONN
        SRV_APP --> AICORE_SVC
        APPROUTER --> XSUAA
    end

    subgraph "External"
        SCC["SAP Cloud Connector"]
        ABAP_SYS["SAP ABAP<br/>On-Premise"]
        AI_CORE["SAP AI Core<br/>LLM Inference"]
    end

    CONN -.->|"ConnectorID"| SCC
    SCC -.-> ABAP_SYS
    DEST -->|"Destination config"| ABAP_SYS
    AICORE_SVC --> AI_CORE

    style APPROUTER fill:#f59e0b,color:#000
    style SRV_APP fill:#2563eb,color:#fff
    style XSUAA fill:#7c3aed,color:#fff
    style DEST fill:#7c3aed,color:#fff
    style CONN fill:#7c3aed,color:#fff
    style AICORE_SVC fill:#7c3aed,color:#fff
```

### MTA Build & Deploy

```
npm run build:mta    →  mbt build → gen/mta_archives/cloud-llm-hub.tar
npm run deploy       →  cf deploy gen/mta_archives/cloud-llm-hub.tar
```

The `mta.yaml` build step runs:
1. `npm ci` — install dependencies
2. `npx cds build --production` — compile CDS models to `gen/srv`
3. `npm ci --omit=dev` — reinstall without devDeps in gen/srv
4. Aggressive cleanup (~16MB final size)

---

## 11. CDS Service Model

```mermaid
graph LR
    subgraph "McpProxyService (@path: /mcp)"
        MH["Health() → HealthStatus"]
        MPD["ProbeDestination(dest) → DestinationProbeResult"]
        MIT["InvokeTool(request) → ProxyResult  ⚠️ DEPRECATED"]
    end

    subgraph "AgentService (@path: /agent)"
        AC["Chat(message) → String"]
        AGH["GetHistory() → ChatMessage[]"]
        ACH["ClearHistory() → {success, message}"]
        AAH["Health() → AgentHealthStatus"]
    end

    subgraph "AuthService (@path: /auth)"
        ACA["CheckAuth() → AuthInfo"]
        ACR["CheckRoles(required) → RoleCheckResult"]
    end

    style MH fill:#2563eb,color:#fff
    style MPD fill:#2563eb,color:#fff
    style AC fill:#16a34a,color:#fff
    style ACA fill:#dc2626,color:#fff
```

**Note:** The Stream-HTTP MCP endpoint (`POST /mcp/stream/http`) is **not** a CDS function — it is a custom Express route registered in `server.ts` during `cds.on('bootstrap')`.

---

## 12. Configuration & Environment

```mermaid
graph TB
    subgraph "Configuration Sources"
        ENV["Environment Variables<br/>(mta.yaml / CF CLI)"]
        VCAP["VCAP_SERVICES<br/>(Service Bindings)"]
        DEF_ENV["default-env.json<br/>(Local dev only)"]
        DOT_ENV[".env file<br/>(Local dev only)"]
        HEADERS["HTTP Request Headers<br/>(Per-request SAP config)"]
    end

    subgraph "Configuration Consumers"
        AC2["agent-config.ts"]
        ES["env-setup.ts"]
        DR2["destinationResolver.ts"]
        MM2["mcp-manager.ts"]
    end

    ENV -->|LLM_AGENT_*| AC2
    VCAP -->|aicore binding| AC2
    VCAP -->|destination credentials| DR2
    DEF_ENV -->|VCAP_SERVICES mock| DR2
    DOT_ENV -->|LLM keys| ES
    HEADERS -->|X-SAP-Destination<br/>X-SAP-URL<br/>Authorization| MM2

    style HEADERS fill:#dc2626,color:#fff
    style ENV fill:#f59e0b,color:#000
    style VCAP fill:#f59e0b,color:#000
```

### Key Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `LLM_AGENT_MODEL` | `agent-config.ts` | LLM model name (e.g., `gpt-4o-mini`, `claude-3-5-sonnet`) |
| `LLM_AGENT_TEMPERATURE` | `agent-config.ts` | Temperature (0.0–2.0, default: 0.7) |
| `LLM_AGENT_MAX_TOKENS` | `agent-config.ts` | Max response tokens (default: 2000) |
| `LLM_AGENT_MCP_DESTINATION` | `agent-config.ts` | Optional "warm this first" BTP Destination hint (NOT privileged; does not block startup) |
| `LLM_AGENT_DESTINATION_INIT_WAIT_MS` | `agent-manager.ts` | Max ms `getSmartAgent` waits for a destination to vectorize before erroring (default: 90000) |
| `LLM_AGENT_MCP_ENDPOINT` | `agent-config.ts` | MCP proxy URL (optional, auto-detected) |
| `LLM_AGENT_RESOURCE_GROUP` | `ai-core-models.ts` | AI Core resource group (default: `default`) |
| `LLM_AGENT_PROVIDER` | `agent-config.ts` | LLM provider (`sap-ai-sdk` \| `openai` \| `anthropic` \| `deepseek`, default: `sap-ai-sdk`) |
| `LLM_AGENT_API_KEY` | `agent-config.ts` | API key for non-SAP LLM providers (OpenAI, Anthropic, DeepSeek) |
| `LLM_AGENT_BASE_URL` | `agent-config.ts` | Base URL for LLM provider API (required for OpenAI-compatible endpoints) |
| `LLM_AGENT_HISTORY_RECENCY_WINDOW` | `agent-config.ts` | Max recent messages to LLM (older excluded, available via RAG) |
| `LLM_AGENT_PIPELINE_MODE` | `agent-config.ts` | Agent pipeline mode (`default` \| `pipeline`, default: `default`) |
| `DESTINATION_MAPPING` | `agent-config.ts` | JSON mapping of destination names to display labels or aliases |
| `VCAP_SERVICES` | `agent-config.ts`, `destinationResolver.ts` | Service bindings (AI Core, Destination, Connectivity) |
| `MCP_SKIP_AUTO_START` | `env-setup.ts` | Prevents mcp-abap-adt auto-start |
| `MCP_SKIP_ENV_LOAD` | `env-setup.ts` | Prevents mcp-abap-adt .env loading |
| `LLM_AGENT_STEP_REVIEW_ENABLED` | `agent-manager.ts` | Honesty guard kill-switch (default: on/`true`); `false` disables the reviewer (`NoticeFinalizer`) entirely — no `UNVERIFIED_WRITE:` notices on any channel |

### Key HTTP Headers (Per-Request)

| Header | Purpose |
|--------|---------|
| `Authorization` | Bearer JWT or Basic auth for XSUAA |
| `X-SAP-Destination` | BTP Destination name → triggers CloudSdkAbapConnection |
| `X-SAP-URL` | Direct SAP system URL (no destination) |
| `X-SAP-Client` | SAP client number |
| `X-SAP-Login` / `X-SAP-Password` | Override destination auth with Basic |
| `X-SAP-Connectivity-Mode` | `onprem` to route through Cloud Connector |
| `X-SAP-Connectivity-Location-ID` | Cloud Connector location ID |
| `X-Rag-Collections` | Comma-separated RAG collection names to include in agent context |

---

## 13. External Dependencies

```mermaid
graph TB
    subgraph "@mcp-abap-adt ecosystem"
        CORE["@mcp-abap-adt/core<br/>EmbeddableMcpServer"]
        CONN_PKG["@mcp-abap-adt/connection<br/>AbapConnection, SapConfig,<br/>createAbapConnection"]
        HV_PKG["@mcp-abap-adt/header-validator<br/>validateAuthHeaders"]
        IFACE["@mcp-abap-adt/interfaces<br/>Header constants, ILogger,<br/>IAdtResponse"]
        LOG_PKG["@mcp-abap-adt/logger<br/>defaultLogger"]
        LLM_PKG["@mcp-abap-adt/llm-proxy<br/>SapCoreAIProvider,<br/>SapCoreAIAgent,<br/>MCPClientWrapper"]
    end

    subgraph "MCP Protocol"
        MCP_SDK["@modelcontextprotocol/sdk<br/>StreamableHTTPServerTransport"]
    end

    subgraph "SAP BTP"
        SAP_CDS["@sap/cds<br/>CAP runtime"]
        SAP_SDK_C["@sap-cloud-sdk/connectivity<br/>getDestination"]
        SAP_SDK_H["@sap-cloud-sdk/http-client<br/>executeHttpRequest"]
        SAP_XSENV["@sap/xsenv<br/>VCAP_SERVICES loader"]
        SAP_XSSEC["@sap/xssec<br/>JWT validation"]
    end

    subgraph "General"
        AXIOS["axios"]
        EXPRESS["express"]
        DOTENV["dotenv"]
    end

    style CORE fill:#2563eb,color:#fff
    style CONN_PKG fill:#2563eb,color:#fff
    style LLM_PKG fill:#2563eb,color:#fff
    style SAP_CDS fill:#7c3aed,color:#fff
```

---

## 14. Testing Strategy

```mermaid
graph LR
    subgraph "Test Types"
        UT["Unit Tests<br/>test/unit/<br/>Jest + ts-jest"]
        IT["Integration Tests<br/>test/test-cap-from-yaml.js<br/>YAML-driven"]
        ST["Smoke Tests<br/>test/smoke/<br/>Shell scripts"]
        AT["Agent Tests<br/>test/test-agent*.sh<br/>BTP + OData"]
    end

    subgraph "Commands"
        C1["npm run test:unit"]
        C2["npm test"]
        C3["Manual execution"]
        C4["Manual execution"]
    end

    C1 --> UT
    C2 --> IT
    C3 --> ST
    C4 --> AT
```

| Command | What it does |
|---------|-------------|
| `npm run test:unit` | Jest unit tests |
| `npm run test:unit:watch` | Jest in watch mode |
| `npm run test:unit:coverage` | Jest with coverage |
| `npm test` | YAML-driven integration tests (requires `test/integration.yaml`) |
| `npm run test:check` | TypeScript type-check (`tsc --noEmit`) |
| `npm run lint` | Biome linter (check + auto-fix) |
| `npm run format` | Biome formatter |

---

## 15. Multi-Destination Architecture (v2.2.0)

Cloud LLM Hub automatically discovers SAP ABAP destinations from BTP Destination Service and manages per-destination state.

### Destination Discovery & Filtering

```mermaid
graph LR
    BTP_API["BTP Destination Service<br/>GET /destination-configuration/v1/subaccountDestinations"] --> FILTER["Filter Heuristic"]
    FILTER -->|"OnPremise + BasicAuth<br/>Exclude OData, /srvd_a2x/<br/>Exclude cloud-connector"| SAP_DESTS["SAP ABAP Destinations"]
```

**Heuristic:** `isSapAbapDestination()` selects OnPremise + BasicAuthentication destinations, excluding OData service endpoints and technical destinations (`cloud-connector`, `cloud_connector`, `connectivity`).

### Per-Destination State

```mermaid
graph TB
    subgraph "Shared Components"
        EMB["Embedder<br/>(text-embedding model)"]
        FACTS["Facts RAG Store"]
        FB["Feedback RAG Store"]
        STATE["State RAG Store"]
    end

    subgraph "Per-Destination State Map"
        D1["S4HANA_DEV<br/>status: ready<br/>toolCount: 259"]
        D2["S4HANA_TST<br/>status: vectorizing<br/>toolCount: 0"]
        D3["S4HANA_QAS<br/>status: pending<br/>toolCount: 0"]
    end

    D1 --> MCP1["McpClientAdapter"]
    D1 --> RAG1["Tools RAG Store"]
    D2 --> MCP2["McpClientAdapter"]
    D2 --> RAG2["Tools RAG Store"]

    EMB --> RAG1
    EMB --> RAG2

    style D1 fill:#16a34a,color:#fff
    style D2 fill:#f59e0b,color:#000
    style D3 fill:#6b7280,color:#fff
```

Each destination has its own `McpClientAdapter` (MCP connection) and `Tools RAG Store` (vectorized tool descriptions). The embedder and facts/feedback/state RAG stores are shared.

**Note:** The tools RAG store uses a `NamespaceIgnoringRag` wrapper that strips `ragFilter` before querying. This is because tools have no namespace — unlike domain RAG stores which use `ragFilter.namespace` to separate collections.

### Startup & Background Vectorization

1. **No blocking primary.** Startup is ready immediately (shared LLMs init lazily) — readiness does NOT depend on any destination vectorizing. There is no privileged destination.
2. `initBackgroundDestinations()` fires (non-blocking) and warms **all** destinations equally:
   - Fetches all BTP destinations via Destination Service API
   - Registers ALL as `pending` immediately (visible in UI)
   - Vectorizes each sequentially in background (the `LLM_AGENT_MCP_DESTINATION` hint, if set, goes first)
3. A request to a not-yet-ready destination **waits** (bounded by `LLM_AGENT_DESTINATION_INIT_WAIT_MS`, default 90s) in `getSmartAgent` and is served once ready — instead of erroring `agent not initialized`. Concurrent inits are deduped via `ensureDestinationInit`.
4. UI polls `GET /v1/models` every 15s to update destination status

### Destination Switching

- Client sends `X-SAP-Destination: <name>` header on `POST /v1/chat/completions`
- `getSmartAgent(model?, destination?)` checks pre-built `DestinationState` map
- If destination is `ready`, uses pre-built adapter + tools RAG — no rebuild needed
- Old agent stays ready during any rebuild (no 503 errors)

---

## 16. Key Design Decisions

### Per-Request Architecture (No Server Cache)

Every MCP request creates a **fresh** Connection + MCP Server + Transport. No session caching. This eliminates stale credential/state issues but means each request independently resolves destinations and creates CSRF tokens.

### Two Auth Layers

1. **XSUAA** (outer) — authenticates the user calling Cloud LLM Hub
2. **SAP system auth** (inner) — authenticates against the target ABAP system, configured per-request via headers or BTP Destination

### env-setup.ts Must Be First Import

The `@mcp-abap-adt` submodule has auto-start code that runs on import. `env-setup.ts` sets `MCP_SKIP_AUTO_START=true` and `MCP_SKIP_ENV_LOAD=true` **before** any submodule imports to prevent unintended behavior.

### SAP Cloud SDK for Destination Handling

All destination-based connections use `executeHttpRequest` from `@sap-cloud-sdk/http-client` instead of manual axios calls. This gives automatic:
- Destination resolution
- Auth token management (Basic, OAuth2, SAML Bearer)
- Cloud Connector proxy routing
- Token refresh

### Agent Self-Loop Pattern

The Agent Service connects its MCP client **back to its own MCP proxy endpoint** (`/mcp/stream/http`) with the destination header. This means the LLM agent uses the same MCP infrastructure that external AI assistants use.

```mermaid
graph LR
    AGENT[Agent Service] -->|"POST /mcp/stream/http<br/>X-SAP-Destination: ABAP_SYS"| PROXY[MCP Proxy]
    PROXY --> ABAP[ABAP System]

    style AGENT fill:#16a34a,color:#fff
    style PROXY fill:#2563eb,color:#fff
```

### Stateless by Default

- `MCP_ENABLE_SESSION_STORAGE=false` by default
- No in-memory session store between requests
- Agent instances cached for 30 min (performance optimization only)
- Fresh auth on every MCP proxy request

### Honesty controller (executor + reviewer)

The controller is explicit, in the agent layer — not baked into the `execute_step` tool. Key decisions:

- **Explicit controller, not an implicit tool wrapper.** Every channel (`execute_step`, `/v1/chat`, `/v1/messages`) is dispatched through a DAG coordinator built on the imported llm-agent interfaces; the SmartAgent runs underneath it as a coordinator-less executor worker (`ISubAgent`). This replaced the interim `execute_step`-only honesty wrapper.
- **Ground truth = tool RESULTS, not tool names.** `RecordingMcpClient` (`srv/lib/recording-mcp-client.ts`) is a thin `IMcpClient` decorator that captures each executed ABAP tool's `McpToolResult`, scoped per `traceId` and freed after the request. The reviewer parses the write tool's result envelope (`{success, status, error}`) — matching by name alone false-positives, since e.g. `CreateDomain` self-activates via `activate:true`.
- **Reaction = notify + safe-stop, not a hard block.** On a contradiction the reviewer appends a trailing `UNVERIFIED_WRITE:` notice; it never renders a verdict itself. ADT edit-locks are released (`connection.closeSession()`) on every exit path regardless. This is interim behavior until the llm-agent planner/controller lands upstream.

---

> **Last updated:** 2026-07-22 | **Source:** Auto-generated from codebase analysis
