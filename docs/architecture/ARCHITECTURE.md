# Cloud LLM Hub — Developer Architecture Guide

> **Version:** 1.3.2 | **Stack:** SAP CAP (Node.js) + TypeScript + SAP BTP  
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
graph TB
    subgraph MCP_ABAP["mcp-abap-adt  (separate project)"]
        direction TB
        CORE["@mcp-abap-adt/core
        ━━━━━━━━━
        EmbeddableMcpServer
        MCP tools for ABAP:
        read class, search objects,
        get table content, etc."]
        CONN_PKG["@mcp-abap-adt/connection
        ━━━━━━━━━
        AbapConnection interface
        SapConfig type
        createAbapConnection
        CSRF handling"]
        HV["@mcp-abap-adt/header-validator
        ━━━━━━━━━
        validateAuthHeaders
        Header parsing"]
        IFACE["@mcp-abap-adt/interfaces
        ━━━━━━━━━
        ILogger, IAdtResponse
        Header constants
        IAbapConnection"]
        LOG["@mcp-abap-adt/logger
        ━━━━━━━━━
        defaultLogger"]
        LLM["@mcp-abap-adt/llm-proxy
        ━━━━━━━━━
        SapCoreAIProvider
        SapCoreAIAgent
        MCPClientWrapper"]
    end

    subgraph CLH["cloud-llm-hub  (this project)"]
        direction TB
        SERVER["server.ts — HTTP transport, auth"]
        MGR["mcp-manager.ts — creates EmbeddableMcpServer per request"]
        CONNECTIONS["connections/ — CloudSdkAbapConnection, destinationResolver"]
        AGENT["agent-manager.ts — LLM provider, agent orchestration"]
        LIB["lib/ — logger adapter, error utils"]
    end

    MGR -->|"creates instance"| CORE
    MGR -->|"validates headers"| HV
    CONNECTIONS -->|"implements interface"| CONN_PKG
    CONNECTIONS -->|"uses CSRF config"| CONN_PKG
    AGENT -->|"creates provider + agent"| LLM
    LIB -->|"wraps"| LOG
    LIB -->|"implements"| IFACE
    MGR -->|"uses types + constants"| IFACE

    style MCP_ABAP fill:#1e3a5f,color:#fff
    style CLH fill:#1a4731,color:#fff
    style CORE fill:#2563eb,color:#fff
    style LLM fill:#7c3aed,color:#fff
```

### What each `@mcp-abap-adt/*` package provides

| Package | What cloud-llm-hub uses from it | Where used |
|---------|--------------------------------|------------|
| **`@mcp-abap-adt/core`** | `EmbeddableMcpServer` — the MCP server with all ABAP tools (read class, search, table content, etc.) | `mcp-manager.ts` |
| **`@mcp-abap-adt/connection`** | `AbapConnection` interface, `SapConfig` type, `createAbapConnection()` factory, `CSRF_CONFIG`, `OnPremAbapConnection` base class | `connections/*`, `mcp-manager.ts` |
| **`@mcp-abap-adt/header-validator`** | `validateAuthHeaders()` — validates SAP auth headers for direct connections | `mcp-manager.ts` |
| **`@mcp-abap-adt/interfaces`** | `ILogger`, `IAdtResponse`, `IAbapConnection`, `ITokenRefresher`, `HEADER_*` constants | Throughout `srv/` |
| **`@mcp-abap-adt/logger`** | `defaultLogger` — base logging implementation | `lib/logger.ts` |
| **`@mcp-abap-adt/llm-proxy`** | `SapCoreAIProvider`, `SapCoreAIAgent`, `MCPClientWrapper`, `BaseAgent`, `Message` type | `agent-manager.ts`, `agent-service.ts` |

### Boundary of responsibility

```mermaid
graph LR
    subgraph BOUNDARY_CLH["cloud-llm-hub responsibility"]
        A["HTTP transport
        + auth + routing"]
        B["BTP Destination
        resolution"]
        C["Cloud Connector
        proxy"]
        D["Agent orchestration
        + SAP AI Core"]
    end

    subgraph BOUNDARY_MCP["mcp-abap-adt responsibility"]
        E["MCP protocol
        implementation"]
        F["ABAP/ADT tools
        read, search, etc."]
        G["AbapConnection
        base classes"]
        H["LLM provider
        abstractions"]
    end

    A -->|"creates + injects connection"| E
    B -->|"resolves credentials for"| G
    D -->|"uses"| H

    style BOUNDARY_CLH fill:#1a4731,color:#fff
    style BOUNDARY_MCP fill:#1e3a5f,color:#fff
```

**Key principle:** Cloud LLM Hub is the orchestrator — it creates a connection (`AbapConnection`), injects it into `EmbeddableMcpServer`, and manages the full lifecycle (auth → destination → connection → MCP server → transport → cleanup). The MCP server uses that connection to talk to ABAP. Cloud LLM Hub never calls ABAP tools directly — all ABAP interaction goes through the embedded MCP server. The Agent Service adds an LLM-agent layer on top, where SAP AI Core LLM autonomously decides which MCP tools to call.

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
│   └── lib/                      # Shared utilities
│       ├── errorUtils.ts         # Centralized error handling
│       └── logger.ts             # Logger adapter wrapping @mcp-abap-adt/logger
├── app/
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
| **Agent Manager** | `agent-manager.ts` | Creates `SapCoreAIProvider` with OAuth2 token from AI Core service binding. Builds MCP client config to loop back into own proxy. Caches agent instances (30 min TTL). |
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

```mermaid
sequenceDiagram
    participant Client as AI Assistant<br/>(Cline / Claude)
    participant AR as Approuter
    participant MW as Express Middleware<br/>(server.ts)
    participant AuthSrv as AuthService<br/>(auth.ts)
    participant Handler as handleStreamHTTP<br/>(server.ts)
    participant MCPMgr as mcp-manager.ts
    participant ConnFactory as connectionFactory.ts
    participant DestRes as destinationResolver.ts
    participant CloudSDK as CloudSdkAbapConnection
    participant MCP as EmbeddableMcpServer<br/>(@mcp-abap-adt/core)
    participant Transport as StreamableHTTP<br/>Transport
    participant ABAP as SAP ABAP System

    Client->>AR: POST /mcp/stream/http<br/>+ Auth header<br/>+ X-SAP-Destination header
    AR->>MW: Forward (with JWT)

    Note over MW: Fix Content-Type & Accept<br/>headers for Cline compat

    MW->>AuthSrv: srv.run('CheckAuth', req)
    AuthSrv-->>MW: {authenticated: true, id, roles}

    MW->>Handler: handleStreamHTTP(req, res)

    Handler->>Handler: Read & parse request body<br/>(JSON-RPC MCP message)

    Handler->>MCPMgr: createMCPServerForRequest(req)

    MCPMgr->>MCPMgr: extractSapContext(req)

    alt X-SAP-Destination present
        MCPMgr->>DestRes: resolveDestinationSapConfig(name, jwt?)
        DestRes-->>MCPMgr: {sapConfig, proxyType, authType}
        MCPMgr->>ConnFactory: createConnection({sapConfig, destinationName})
        ConnFactory->>CloudSDK: new CloudSdkAbapConnection(config, dest)
    else Direct connection (URL + Basic/JWT)
        MCPMgr->>MCPMgr: validateAuthHeaders(req.headers)
        MCPMgr->>ConnFactory: createConnection({sapConfig})
        ConnFactory->>ConnFactory: createAbapConnection(config)
    end

    MCPMgr->>MCP: new EmbeddableMcpServer({connection, logger})
    MCPMgr->>Transport: new StreamableHTTPServerTransport({stateless})
    MCPMgr->>MCP: mcpServer.connect(transport)

    MCPMgr-->>Handler: {server, connection, transport, cleanup}

    Handler->>Transport: transport.handleRequest(req, res, body)
    Transport->>MCP: Process JSON-RPC request
    MCP->>CloudSDK: makeAdtRequest(options)
    CloudSDK->>ABAP: executeHttpRequest({destinationName}, ...)
    ABAP-->>CloudSDK: ADT Response
    CloudSDK-->>MCP: IAdtResponse
    MCP-->>Transport: MCP Response
    Transport-->>Handler: HTTP Response written

    Handler->>Handler: cleanup() — close transport, reset connection

    Handler-->>Client: JSON response
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

```mermaid
sequenceDiagram
    participant Client as App / User
    participant AR as Approuter
    participant AgentSrv as AgentService<br/>(agent-service.ts)
    participant AgentMgr as agent-manager.ts
    participant AgentCfg as agent-config.ts
    participant AICoreProvider as SapCoreAIProvider
    participant AICore as SAP AI Core
    participant MCPClient as MCPClientWrapper
    participant MCPProxy as MCP Proxy<br/>(/mcp/stream/http)

    Client->>AR: POST /agent/Chat<br/>{message: "..."}
    AR->>AgentSrv: CAP dispatches to Chat handler

    AgentSrv->>AgentCfg: getAgentConfig()
    Note over AgentCfg: Reads LLM_AGENT_MODEL,<br/>TEMPERATURE, MAX_TOKENS<br/>from env vars +<br/>AI Core from VCAP_SERVICES

    AgentSrv->>AgentMgr: createLLMProvider(config)
    AgentMgr->>AgentMgr: Get OAuth2 token<br/>from AI Core service binding

    AgentMgr->>AICoreProvider: new SapCoreAIProvider({...})

    AgentSrv->>AICoreProvider: provider.chat([{role:'user', content: msg}])
    AICoreProvider->>AICore: POST /chat/completions<br/>Bearer {oauth2_token}
    AICore-->>AICoreProvider: LLM response

    Note over AgentMgr: Optional: Agent mode with MCP tools
    AgentMgr->>MCPClient: new MCPClientWrapper({url, headers})
    MCPClient->>MCPProxy: POST /mcp/stream/http<br/>+ X-SAP-Destination header
    MCPProxy-->>MCPClient: MCP tool results

    AICoreProvider-->>AgentSrv: response.content
    AgentSrv-->>Client: LLM response string
```

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
| `LLM_AGENT_MCP_DESTINATION` | `agent-config.ts` | BTP Destination name for ABAP system |
| `LLM_AGENT_MCP_ENDPOINT` | `agent-config.ts` | MCP proxy URL (optional, auto-detected) |
| `VCAP_SERVICES` | `agent-config.ts`, `destinationResolver.ts` | Service bindings (AI Core, Destination, Connectivity) |
| `MCP_SKIP_AUTO_START` | `env-setup.ts` | Prevents mcp-abap-adt auto-start |
| `MCP_SKIP_ENV_LOAD` | `env-setup.ts` | Prevents mcp-abap-adt .env loading |

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

## 15. Key Design Decisions

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

---

> **Last updated:** February 2026 | **Source:** Auto-generated from codebase analysis
