# Connection Architecture

**Date:** December 1, 2025  
**Version:** 1.0  
**Author:** AI Assistant

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Two Connection Types](#two-connection-types)
3. [When to Use What](#when-to-use-what)
4. [Technical Details](#technical-details)
5. [Usage Examples](#usage-examples)

---

## 🎯 Overview

`cloud-llm-hub` **does NOT duplicate** functionality of `@mcp-abap-adt/connection`, but **extends** it for SAP BTP Cloud integration.

### Why Two Connection Types?

```
┌─────────────────────────────────────────────────────────────┐
│         Base Functionality (mcp-abap-adt)                   │
│                                                              │
│  ✅ MCP Protocol (stdio, HTTP, SSE)                         │
│  ✅ ABAP ADT Handlers (Classes, Programs, etc.)             │
│  ✅ Basic Authentication (username/password)                │
│  ✅ JWT Authentication (direct token)                         │
│  ✅ Direct ABAP connections (axios-based)                   │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ EXTENDED ↓
                           │
┌─────────────────────────▼─────────────────────────────────┐
│      Extension for BTP Cloud (cloud-llm-hub)               │
│                                                            │
│  🆕 BTP Destination Service integration                   │
│  🆕 Cloud Connector support (On-Premise)                  │
│  🆕 Multiple auth types (OAuth2, SAML)                    │
│  🆕 Principal Propagation                                 │
│  🆕 Enterprise-ready REST API (CAP)                       │
│  🆕 Centralized authentication & authorization            │
└────────────────────────────────────────────────────────────┘
```

---

## 🔧 Two Connection Types

### Type 1: Direct Connection (`@mcp-abap-adt/connection`)

**When to use:**

- Local development
- stdio mode (Cline, Cursor, Claude Desktop)
- Direct connections to ABAP without BTP
- Testing and debugging

**How it works:**

```typescript
import { createAbapConnection, SapConfig } from '@mcp-abap-adt/connection';

const config: SapConfig = {
  url: 'https://my-abap-system.com:443',
  authType: 'basic',
  username: 'DEVELOPER',
  password: 'SecretPass123',
  client: '100',
};

const connection = createAbapConnection(config);
```

**Technical details:**

- **HTTP Client:** axios
- **Authentication:** Basic (username/password) or JWT (token in header)
- **Proxy:** Only via `HTTP_PROXY` environment variable
- **Token management:** Manual (passed in config)
- **CSRF handling:** axios-based implementation
- **Session storage:** FileSessionStorage (optional)

**Advantages:**

- ✅ Simple configuration (.env file)
- ✅ Fast startup for development
- ✅ No BTP infrastructure required

**Disadvantages:**

- ❌ Credentials in .env file (security risk)
- ❌ No automatic token refresh
- ❌ Doesn't work with On-Premise via Cloud Connector
- ❌ No centralized destination management

---

### Type 2: BTP Destination (`CloudSdkAbapConnection`)

**When to use:**

- Production deployment on BTP
- On-Premise ABAP via Cloud Connector
- Multi-tenant SaaS applications
- Enterprise scenarios with Principal Propagation

**How it works:**

```typescript
import { CloudSdkAbapConnection } from './connections/CloudSdkAbapConnection';

const connection = new CloudSdkAbapConnection(
  sapConfig,
  'MY_ABAP_DESTINATION' // Destination name in BTP
);
```

**Technical details:**

- **HTTP Client:** SAP Cloud SDK (`executeHttpRequest`)
- **Authentication:** via BTP Destination Service
  - BasicAuthentication
  - OAuth2ClientCredentials
  - OAuth2SAMLBearerAssertion
  - Principal Propagation (user context)
  - NoAuthentication (credentials via `x-sap-login`/`x-sap-password` headers)
- **Proxy:** Cloud Connector (automatically via Destination)
- **Token management:** Automatic via BTP
- **CSRF handling:** Cloud SDK-based implementation
- **Configuration:** Centralized in BTP Cockpit

**Destination Configuration (example):**

```json
{
  "Name": "MY_ABAP_DESTINATION",
  "Type": "HTTP",
  "URL": "https://my-abap-system.com:443",
  "ProxyType": "OnPremise",
  "Authentication": "OAuth2SAMLBearerAssertion",
  "tokenServiceURL": "https://my-uaa.com/oauth/token",
  "clientId": "sb-my-app",
  "clientSecret": "***",
  "sap-client": "100"
}
```

**Advantages:**

- ✅ Centralized destination management (BTP Cockpit)
- ✅ Automatic token management via BTP (handled by BTP infrastructure, not refresh token)
- ✅ Cloud Connector support for On-Premise
- ✅ Principal Propagation (user context forwarding)
- ✅ Multi-tenant isolation
- ✅ Audit logging via BTP
- ✅ No credentials in code

**Disadvantages:**

- ❌ Requires BTP infrastructure
- ❌ More complex setup
- ❌ Doesn't work in local stdio mode

---

## 🎯 When to Use What?

### Decision Tree

```
                    Where is code running?
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
   Local / stdio                    BTP Cloud
        │                                   │
        ▼                                   ▼
 Direct Connection              BTP Destination
  (Basic/JWT)                  (CloudSdkAbapConnection)
        │                                   │
        │                                   │
        ▼                                   ▼
┌──────────────────┐            ┌─────────────────────┐
│ .env file config │            │ Destination Service │
│                  │            │                     │
│ SAP_URL=...      │            │ Destination Name    │
│ SAP_USERNAME=... │            │ + BTP Auth          │
│ SAP_PASSWORD=... │            │                     │
└──────────────────┘            └─────────────────────┘
```

### Use Case Matrix

| Use Case                      | Connection Type    | Why?                              |
| ----------------------------- | ------------------ | --------------------------------- |
| **Local development**         | Direct (Basic/JWT) | .env file, simplicity             |
| **stdio mode (Cline/Cursor)** | Direct (Basic/JWT) | No BTP required                   |
| **BTP Cloud Production**      | BTP Destination    | Security, management              |
| **On-Premise via CC**         | BTP Destination    | ⚠️ ONLY via Destination!          |
| **Principal Propagation**     | BTP Destination    | User context forwarding           |
| **Multi-tenant SaaS**         | BTP Destination    | Isolation, different destinations |
| **Development/Test on BTP**   | Both               | Choose the more convenient        |
| **CI/CD Pipeline**            | Direct (JWT)       | Service account tokens            |

---

## 🔬 Technical Details

### Interface Compatibility

Both types implement the `AbapConnection` interface:

```typescript
interface AbapConnection {
  getConfig(): SapConfig;
  getSessionId(): string;
  setSessionType(type: 'stateless' | 'stateful'): void;
  connect(): Promise<void>;
  getSessionState(): any;
  setSessionState(state: any): void;
  reset(): void;
  getBaseUrl(): Promise<string>;
  getAuthHeaders(): Promise<Record<string, string>>;
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
}
```

**This allows:**

- Transparent substitution of one type for another
- Using the same MCP server code
- Factory pattern for type selection

### CSRF Token Handling

**Direct Connection:**

```typescript
// @mcp-abap-adt/connection
private async fetchCsrfToken(): Promise<string> {
  const response = await axios.get(`${baseUrl}/sap/bc/adt/discovery`, {
    headers: {
      'x-csrf-token': 'fetch',
      'Authorization': `Basic ${base64encode(username:password)}`
    }
  });
  return response.headers['x-csrf-token'];
}
```

**BTP Destination:**

```typescript
// CloudSdkAbapConnection
private async fetchCsrfToken(url: string): Promise<string> {
  const response = await executeHttpRequest(
    { destinationName: this.destinationName },
    {
      method: 'GET',
      url: `${baseUrl}/sap/bc/adt/discovery`,
      headers: {
        'x-csrf-token': 'fetch',
        'Accept': 'application/atomsvc+xml'
      }
    }
  );
  return response.headers['x-csrf-token'];
}
```

**Difference:**

- Different HTTP clients (axios vs Cloud SDK)
- Cloud SDK automatically adds authentication from Destination
- Cloud SDK automatically handles proxy via Cloud Connector

### Stateful sessions & the orphaned-lock fix (`CloudSdkAbapConnection`)

An ADT write runs a **stateful chain** — `validate → create → LOCK → update → unlock → activate` —
and **every request must stay on one connection to the one app-server instance behind the
connectivity proxy**, or the session (and its edit-lock) is lost with a **400 "Session not found"**
and the object is left created-but-locked (orphaned). On the BTP connectivity path two things are
needed to hold that session — both handled inside `CloudSdkAbapConnection`:

1. **Client-generated `SAP_SESSIONID_<SID>_<CLIENT>`.** SAP issues no such cookie on this path
   (only `sap-contextid`), so the client provides it: a stable, unique base64url value (suffix
   derived from the server's `sap-XSRF_<SID>_<CLIENT>`), generated **once and never changed for the
   connection's lifetime**, sent on every request. A real server-issued value always wins.
2. **One keep-alive socket per connector** (a `maxSockets: 1` keep-alive **`httpAgent`** on every
   `executeHttpRequest`). Cloud SDK otherwise builds a fresh agent per call over a shared socket
   pool, so a **cold** chain can send LOCK on one socket/tunnel and the follow-up GET on another →
   session not found. Pinning to one socket keeps the whole chain on one tunnel → one instance.
   **Only `httpAgent` is overridden** — on-prem ADT reaches the Cloud Connector over plain HTTP;
   `httpsAgent` is left to the SDK, which owns destination TLS (TrustAll / trust store / client-cert
   mTLS), so HTTPS destinations keep their TLS config.

Rules of thumb: **one destination = one session = one connector = one connection**; and **never
blind-retry a stateful ADT write** on a session error (it piles up locked/duplicate objects — the
old 400-retry was removed). A `SESSION_LOST` WARN logs any residual anomaly with the session
context. The standalone `@mcp-abap-adt` direct connection is immune because its **persistent axios
socket** already provides #2 for free; `CloudSdkAbapConnection` has to recreate both explicitly.

**Why it hit domains but not classes:** `updateDomain` is read-modify-write (a stateful **GET right
after LOCK**), which is the request that scattered on a cold pool; class source update is a direct
PUT with no post-LOCK read.

### Authentication Flow

**Direct Connection (Basic):**

```
Client → cloud-llm-hub → ABAP System
         │
         └─ Authorization: Basic base64(user:pass)
```

**Direct Connection (JWT):**

```
Client → cloud-llm-hub → ABAP System
         │
         └─ Authorization: Bearer eyJhbGci...
```

**BTP Destination (OAuth2ClientCredentials):**

```
Client → cloud-llm-hub → BTP Destination Service → UAA (get token)
                         │                           │
                         │←──────── OAuth token ──────┘
                         │
                         └──→ ABAP System
                              Authorization: Bearer <token>
```

**BTP Destination (Principal Propagation):**

```
User → BTP → cloud-llm-hub → BTP Destination Service
       │                      │
       │ User JWT             │ Exchange token
       │                      ↓
       │                     UAA (SAML assertion)
       │                      │
       └──────────────────────┴──→ ABAP System
                                   (with user context)
```

### Token Management

**Important:** `cloud-llm-hub` does **NOT** implement token refresh functionality. Token management is handled differently depending on connection type:

**BTP Destination:**

- Token management is **automatic via BTP infrastructure**
- BTP Destination Service handles token acquisition, refresh, and lifecycle
- No refresh token needed - BTP manages everything
- Tokens are automatically refreshed by BTP when needed

**Direct JWT Connection:**

- Token refresh is **client's responsibility**
- `cloud-llm-hub` does **NOT** accept or process refresh tokens
- Clients must refresh tokens themselves and send new JWT token in each request
- No automatic token refresh is performed by cloud-llm-hub

**Why this design?**

- **Separation of concerns:** Token refresh logic belongs to authentication layer (BTP or client), not to MCP proxy
- **Production-ready:** In production on BTP, token management is handled by BTP infrastructure
- **Client control:** Clients have full control over token lifecycle and refresh timing
- **No duplication:** Avoids duplicating token refresh logic that already exists in mcp-abap-adt or BTP

---

## 💡 Usage Examples

### Example 1: Local Development (stdio mode)

**.env file:**

```bash
SAP_URL=https://my-s4hana.com:443
SAP_AUTH_TYPE=basic
SAP_USERNAME=DEVELOPER
SAP_PASSWORD=SecretPass123
SAP_CLIENT=100
```

**Run:**

```bash
cd submodules/mcp-abap-adt
npm run build
node dist/index.js --transport=stdio
```

**Cline MCP Config:**

```json
{
  "mcpServers": {
    "abap-adt": {
      "command": "node",
      "args": ["/path/to/mcp-abap-adt/dist/index.js", "--transport=stdio"]
    }
  }
}
```

---

### Example 2: BTP Cloud Production

**BTP Destination (created in Cockpit):**

```
Name: PROD_S4HANA
Type: HTTP
URL: https://prod-s4hana.mycompany.com:443
ProxyType: Internet
Authentication: OAuth2ClientCredentials
tokenServiceURL: https://myapp.authentication.eu10.hana.ondemand.com/oauth/token
clientId: sb-myapp!t12345
clientSecret: *** (encrypted)
Additional Properties:
  sap-client=100
```

**HTTP Request to cloud-llm-hub:**

```http
POST /mcp/stream/http
Host: cloud-llm-hub.cfapps.eu10.hana.ondemand.com
Content-Type: application/json
X-SAP-Destination: PROD_S4HANA
X-SAP-Client: 100
Authorization: Bearer <user-jwt-token>

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_class",
    "arguments": {
      "class_name": "ZCL_MY_CLASS"
    }
  }
}
```

**What happens:**

1. cloud-llm-hub receives request with header `X-SAP-Destination: PROD_S4HANA`
2. `destinationResolver` resolves destination via BTP Destination Service
3. `CloudSdkAbapConnection` is created with destination name
4. Cloud SDK automatically:
   - Gets OAuth token from UAA
   - Configures proxy (if needed)
   - Adds authentication headers
5. ADT request is executed to ABAP
6. Response is returned to client

---

### Example 3: On-Premise via Cloud Connector

**BTP Destination:**

```
Name: ONPREM_ECC
Type: HTTP
URL: http://sapecc.internal:8000
ProxyType: OnPremise  ← IMPORTANT!
Authentication: BasicAuthentication
User: DEVELOPER
Password: *** (encrypted)
Additional Properties:
  sap-client=100
  CloudConnectorLocationId=mycc-location
```

**Cloud Connector Configuration:**

```
Virtual Host: sapecc.internal
Virtual Port: 8000
Internal Host: 192.168.1.100
Internal Port: 8000
Access Control: Allow /sap/bc/adt/*
```

**HTTP Request:**

```http
POST /mcp/stream/http
X-SAP-Destination: ONPREM_ECC

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_program",
    "arguments": {
      "program_name": "Z_REPORT_001"
    }
  }
}
```

**What happens:**

1. CloudSdkAbapConnection sees `ProxyType: OnPremise`
2. Cloud SDK automatically routes via Cloud Connector
3. Cloud Connector forwards request to internal network
4. ECC system receives request from internal network
5. Response via Cloud Connector → BTP → Client

---

## 🎓 Best Practices

### 1. Connection Type Selection

✅ **DO:**

- Use Direct for local development
- Use BTP Destination for production
- Use BTP Destination for On-Premise
- Test with both types before production deploy

❌ **DON'T:**

- Don't store credentials in code
- Don't use Direct with hard-coded credentials
- Don't try to connect to On-Premise without Cloud Connector

### 2. Configuration Management

✅ **DO:**

```typescript
// Good: Factory pattern
const connection = await createConnection({
  destinationName: req.headers['x-sap-destination'],
  sapConfig: extractedConfig,
});
```

❌ **DON'T:**

```typescript
// Bad: Hard-coded type selection
const connection = new CloudSdkAbapConnection(...);
```

### 3. Error Handling

✅ **DO:**

```typescript
try {
  const connection = await createConnection(options);
  const response = await connection.makeAdtRequest({...});
} catch (error) {
  if (error.code === 'DESTINATION_NOT_FOUND') {
    // Fallback to direct connection?
  }
  throw error;
}
```

### 4. Testing

**Unit Tests:**

```typescript
// Mock different connection types
it('should use CloudSdkAbapConnection for destination', async () => {
  const conn = await createConnection({
    destinationName: 'TEST_DEST',
  });
  expect(conn).toBeInstanceOf(CloudSdkAbapConnection);
});

it('should use direct connection for sapConfig', async () => {
  const conn = await createConnection({
    sapConfig: { url: '...', authType: 'basic' },
  });
  expect(conn).not.toBeInstanceOf(CloudSdkAbapConnection);
});
```

---

## 📚 Additional Resources

- [SAP Cloud SDK Documentation](https://sap.github.io/cloud-sdk/)
- [BTP Destination Service](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/destinations)
- [Cloud Connector](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/cloud-connector)
- [mcp-abap-adt (upstream repository)](https://github.com/fr0ster/mcp-abap-adt)

---

**Version:** 1.0  
**Last Updated:** December 1, 2025  
**Author:** AI Assistant
