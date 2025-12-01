# Integration Architecture

**Date:** December 2025  
**Version:** 1.0  
**Status:** Current

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [Connection Types](#connection-types)
4. [Integration Points](#integration-points)
5. [Data Flow](#data-flow)
6. [Extension Pattern](#extension-pattern)

---

## 🎯 Overview

`cloud-llm-hub` integrates with `mcp-abap-adt` to provide enterprise-grade MCP (Model Context Protocol) services for SAP ABAP ADT systems. The integration follows an **extension pattern** where cloud-llm-hub extends the base functionality of mcp-abap-adt with BTP Cloud capabilities.

### Key Principles

- **Extension, Not Duplication**: cloud-llm-hub extends mcp-abap-adt, not replaces it
- **Separation of Concerns**: Base library handles protocol + ADT, hub handles BTP integration
- **Backward Compatibility**: Direct connections (Basic/JWT) work through base library
- **Enterprise Features**: BTP Destinations, Cloud Connector, CAP integration

---

## 🏗️ Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Layer                              │
│         (Cline, Claude, n8n, CI/CD, Custom)                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/Stream-HTTP
┌──────────────────────▼──────────────────────────────────────┐
│              cloud-llm-hub (CAP Service)                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CAP AuthService (XSUAA)                                │  │
│  │  - Authentication & Authorization                      │  │
│  │  - User context propagation                            │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Proxy (server.ts)                                  │  │
│  │  - Request routing                                      │  │
│  │  - Header extraction                                   │  │
│  │  - Session context management                          │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Manager (mcp-manager.ts)                          │  │
│  │  - Server instance caching                             │  │
│  │  - Connection factory                                  │  │
│  │  - SAP config extraction                               │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Connection Layer (srv/connections/)                     │  │
│  │  - CloudSdkAbapConnection (BTP Destinations)           │  │
│  │  - Destination Resolver                                 │  │
│  │  - Connectivity Proxy                                   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│            mcp-abap-adt (Base Library)                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Server (Protocol Handler)                          │  │
│  │  - stdio, HTTP, SSE, Stream-HTTP transports            │  │
│  │  - Tool registration & execution                        │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ADT Clients (@mcp-abap-adt/adt-clients)                │  │
│  │  - CrudClient, SharedBuilder                            │  │
│  │  - URL construction                                     │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Connection (@mcp-abap-adt/connection)                  │  │
│  │  - Basic/JWT authentication                             │  │
│  │  - Direct HTTP (axios)                                │  │
│  │  - CSRF token management                                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Utilities (sessionContext, getManagedConnection)       │  │
│  │  - AsyncLocalStorage for per-request context            │  │
│  │  - Connection caching & lifecycle                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    SAP BTP Services                           │
│  - Destination Service (authentication, URLs)                 │
│  - Connectivity Service (Cloud Connector)                    │
│  - XSUAA (user authentication)                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    SAP ABAP Systems                           │
│  - Cloud ABAP (Internet)                                      │
│  - On-Premise ABAP (via Cloud Connector)                     │
└───────────────────────────────────────────────────────────────┘
```

---

## 🔌 Connection Types

### Type 1: Direct Connection (Base Library)

**Implementation:** `@mcp-abap-adt/connection`  
**Transport:** axios  
**Authentication:** Basic (username/password) or JWT (direct token)

**Use Cases:**

- Local development
- stdio mode (Cline, Cursor)
- Simple integrations
- Testing

**Configuration:**

```typescript
{
  url: "https://my-abap-system.com:443",
  authType: "basic" | "jwt",
  username: "USER",
  password: "PASS",
  // OR
  jwtToken: "eyJhbGci..."
}
```

**Flow:**

1. Client sends headers: `X-SAP-URL`, `X-SAP-AUTH-TYPE`, credentials
2. `extractSapContext()` extracts config from headers
3. `validateAuthHeaders()` validates (from `@mcp-abap-adt/header-validator`)
4. `sessionContext.run()` sets per-request context
5. `getManagedConnection()` creates/caches connection (from base library)
6. MCP server uses connection for ADT requests

### Type 2: BTP Destination (Extension)

**Implementation:** `CloudSdkAbapConnection`  
**Transport:** SAP Cloud SDK `executeHttpRequest`  
**Authentication:** Via BTP Destination Service

**Use Cases:**

- Production deployments
- Enterprise scenarios
- On-premise systems (via Cloud Connector)
- Principal Propagation
- Multi-tenant SaaS

**Configuration:**

```typescript
{
  destinationName: "MY_ABAP_SYSTEM",
  // Destination contains:
  // - URL (Internet or On-Premise)
  // - Authentication (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
  // - Proxy configuration
  // - SSL certificates
}
```

**Flow:**

1. Client sends header: `X-SAP-Destination: MY_ABAP_SYSTEM`
2. `extractSapContext()` resolves destination via `resolveDestinationSapConfig()`
3. Destination Service provides URL, auth type, credentials
4. `CloudSdkAbapConnection` created with destination name
5. MCP server uses connection for ADT requests
6. Cloud SDK handles authentication, proxy, token refresh automatically

---

## 🔗 Integration Points

### 1. MCP Server Instantiation

**Location:** `srv/mcp-manager.ts::getMCPServer()`

**Process:**

```typescript
// 1. Extract SAP config from headers
const sapContext = await extractSapContext(req);

// 2. Create connection (if destination-based)
let connection: AbapConnection | undefined;
if (destination?.destinationName) {
  connection = new CloudSdkAbapConnection(sapConfig, destinationName);
}

// 3. Create MCP server instance
const { mcp_abap_adt_server } = await import('@fr0ster/mcp-abap-adt');
const mcpServerInstance = new mcp_abap_adt_server({
  connection, // Pass connection for destination-based
  // OR omit connection for direct (uses sessionContext)
  allowProcessExit: false,
  registerSignalHandlers: false,
});
```

**Key Points:**

- Destination-based: Pass `connection` directly
- Direct (Basic/JWT): Omit `connection`, rely on `sessionContext`

### 2. Session Context Management

**Location:** `srv/server.ts::handleStreamHTTP()`

**Process:**

```typescript
// 1. Get sessionContext from mcp-abap-adt
const mcpUtils = require('@fr0ster/mcp-abap-adt/dist/lib/utils.js');
const mcpSessionContext = mcpUtils.sessionContext;

// 2. Run handler in session context
await mcpSessionContext.run(
  {
    sessionId,
    sapConfig: sessionSapConfig, // Per-request config
  },
  async () => {
    // 3. Inside context, getManagedConnection() uses sessionSapConfig
    await transport.handleRequest(req, res, body);
  }
);
```

**Key Points:**

- `sessionContext` is AsyncLocalStorage from mcp-abap-adt
- Each HTTP request gets its own context
- `getManagedConnection()` reads from context automatically

### 3. Connection Factory Pattern

**Location:** `srv/connections/connectionFactory.ts`

**Purpose:** Centralize connection type selection

```typescript
export function createConnection(options: ConnectionOptions): AbapConnection {
  if (options.destinationName) {
    // BTP Destination → CloudSdkAbapConnection
    return new CloudSdkAbapConnection(sapConfig, destinationName);
  }
  // Direct → createAbapConnection from base library
  return createAbapConnection(sapConfig, logger, sessionStorage, sessionId);
}
```

**Key Points:**

- Single entry point for connection creation
- Automatic type selection based on destination presence
- Consistent interface (`AbapConnection`)

### 4. Header Validation

**Location:** `srv/mcp-manager.ts::extractSapContext()`

**Process:**

```typescript
// Priority 1: BTP Destination
if (destinationName) {
  return await resolveDestinationSapConfig(destinationName, jwtToken);
}

// Priority 2: Direct connection - use validateAuthHeaders
const validationResult = validateAuthHeaders(req.headers);
if (!validationResult.isValid) {
  throw new Error(`Invalid authentication headers: ${validationResult.errors.join('; ')}`);
}
```

**Key Points:**

- Uses `@mcp-abap-adt/header-validator` for direct connections
- Centralized validation logic
- Consistent error messages

---

## 📊 Data Flow

### Request Flow (Direct Connection)

```
Client Request
    ↓
CAP AuthService.CheckAuth (XSUAA)
    ↓
server.ts::handleStreamHTTP()
    ↓
Extract headers → sessionSapConfig
    ↓
mcp-manager.ts::getMCPServer()
    ↓
validateAuthHeaders() (from mcp-abap-adt)
    ↓
sessionContext.run({ sapConfig })
    ↓
mcp-abap-adt::getManagedConnection()
    ↓
@mcp-abap-adt/connection::createAbapConnection()
    ↓
MCP Server → ADT Tools → ABAP System
```

### Request Flow (BTP Destination)

```
Client Request
    ↓
CAP AuthService.CheckAuth (XSUAA)
    ↓
server.ts::handleStreamHTTP()
    ↓
Extract X-SAP-Destination header
    ↓
mcp-manager.ts::getMCPServer()
    ↓
resolveDestinationSapConfig()
    ↓
Destination Service (BTP)
    ↓
CloudSdkAbapConnection (created with destinationName)
    ↓
MCP Server (connection passed to constructor)
    ↓
MCP Server → ADT Tools → Cloud SDK → ABAP System
```

---

## 🔄 Extension Pattern

### What cloud-llm-hub Extends

1. **Connection Layer**
   - Base: `@mcp-abap-adt/connection` (axios + Basic/JWT)
   - Extension: `CloudSdkAbapConnection` (Cloud SDK + Destinations)

2. **Authentication**
   - Base: Direct Basic/JWT tokens
   - Extension: BTP Destination Service, OAuth2, SAML, Principal Propagation

3. **Transport**
   - Base: Direct HTTP (axios)
   - Extension: Cloud SDK `executeHttpRequest` (automatic proxy, SSL, token refresh)

4. **Infrastructure**
   - Base: Standalone MCP server
   - Extension: CAP service, REST API, enterprise auth

### What cloud-llm-hub Reuses

1. **MCP Protocol**: Complete protocol implementation from mcp-abap-adt
2. **ADT Clients**: All ADT tool handlers and clients
3. **Session Context**: AsyncLocalStorage for per-request context
4. **Connection Interface**: `AbapConnection` interface compatibility
5. **Utilities**: Logging, error handling, CSRF config (synchronized)

### What cloud-llm-hub Adds

1. **BTP Integration**: Destination Service, Connectivity Service
2. **CAP Framework**: REST API, service definitions, authentication
3. **Enterprise Features**: Multi-tenant, audit logging, rate limiting
4. **Connection Factory**: Centralized connection type selection
5. **Header Validation**: Integration with `@mcp-abap-adt/header-validator`

---

## 📝 Key Design Decisions

### 1. Hybrid Connection Approach

**Decision:** Use both direct connections (via base library) and destination connections (via extension)

**Rationale:**

- Direct connections: Simple, fast, suitable for development
- Destination connections: Enterprise-grade, secure, production-ready
- Both needed for different use cases

### 2. Session Context for Direct Connections

**Decision:** Don't pass `sapConfig` to MCP server constructor for direct connections

**Rationale:**

- Allows per-request JWT tokens (auto-refresh)
- Supports multiple concurrent requests with different tokens
- Matches mcp-abap-adt standalone behavior

### 3. Connection Caching

**Decision:** Cache MCP server instances, not just connections

**Rationale:**

- MCP server initialization is expensive
- Connections are managed by base library (for direct) or Cloud SDK (for destinations)
- Cache key includes destination/auth type/client for proper isolation

### 4. Shared CSRF Config

**Decision:** Create `csrfConfig.ts` with shared constants

**Rationale:**

- Synchronize retry logic between axios and Cloud SDK implementations
- Consistent error messages
- Easy to update parameters in one place

---

## 🔍 Related Documentation

- [MCP ABAP ADT Integration Roadmap](../contributors/MCP_ABAP_ADT_INTEGRATION.md) - Detailed integration plan
- [Connection Architecture](../contributors/CONNECTION_ARCHITECTURE.md) - Connection types explained
- [Code Sharing Policy](../contributors/CODE_SHARING_POLICY.md) - Duplication policy
- [MCP ABAP ADT Usage](../contributors/MCP_ABAP_ADT_USAGE.md) - How to use mcp-abap-adt

---

**Author:** AI Assistant  
**Last Updated:** December 2025  
**Version:** 1.0
