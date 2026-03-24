# CAP Endpoint Paths

## McpProxyService (@path: 'mcp-proxy')

⚠️ **IMPORTANT**: All McpProxyService endpoints require authorization with scope `MCP_Connector` (`@requires: 'MCP_Connector'`)

> **Note**: The CDS service path was changed from `'mcp'` to `'mcp-proxy'` to avoid
> conflicting with custom Express routes on `/mcp/stream/http`. See
> [CAP_EXPRESS_AUTH.md](../development/CAP_EXPRESS_AUTH.md#cds-service-path-conflict).

### Health

- **Method**: GET
- **URL**: `/odata/v4/mcp-proxy/Health()`
- **Parameters**: none
- **Authorization**: ✅ Required - scope `MCP_Connector` needed
- **Example**:
  ```bash
  GET http://localhost:4004/odata/v4/mcp-proxy/Health()
  Authorization: Basic YWxpY2U6  # for development (alice)
  # or
  Authorization: Bearer <JWT_TOKEN>  # for production
  ```

### ProbeDestination

- **Method**: GET
- **URL**: `/odata/v4/mcp-proxy/ProbeDestination?destination=NAME`
- **Or via positional parameter**: `/odata/v4/mcp-proxy/ProbeDestination(destination='NAME')`
- **Parameters**:
  - `destination` (String, required) - destination name
- **Authorization**: ✅ Required - scope `MCP_Connector` needed
- **Implementation**: Uses SAP Cloud SDK's `executeHttpRequest` for automatic destination resolution, authentication, and proxy configuration.
- **Examples**:

  ```bash
  # Via query parameter (recommended)
  GET http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination?destination=S4HANA

  # Via positional parameter
  GET http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination(destination='S4HANA')

  # Production with Bearer token
  GET https://<your-app>.cfapps.<region>.hana.ondemand.com/odata/v4/mcp-proxy/ProbeDestination?destination=S4HANA
  Authorization: Bearer <JWT_TOKEN>
  ```

### InvokeTool (Deprecated)

- **Method**: POST
- **URL**: `/odata/v4/mcp-proxy/InvokeTool`
- **Status**: ⚠️ Deprecated - use `/mcp/stream/http` instead

## Express Endpoints (Non-CAP)

These endpoints are registered directly in Express and bypass CAP's OData layer.

### Stream SSE (disabled)

- **Method**: GET, POST
- **URL**: `/mcp/stream/sse`
- **Status**: Not available in the current build (returns `404`)

### Stream HTTP (StreamableHTTP)

- **Method**: POST
- **URL**: `/mcp/stream/http`
- **Authorization**: ✅ Required - scope `MCP_Connector` needed
- **Content-Type**: `application/json` (NDJSON streaming)
- **Purpose**: Bidirectional NDJSON streaming transport for MCP protocol
- **Headers** (optional):
  - `X-MCP-Timeout`: Request timeout in milliseconds (default: 10000ms in debug, 5000ms in production)
  - `X-Request-Timeout`: Alternative header for timeout
- **Example**:

  ```bash
  POST http://localhost:4004/mcp/stream/http
  Authorization: Basic YWxpY2U6
  Content-Type: application/json
  X-MCP-Timeout: 60000

  {"jsonrpc":"2.0","id":"1","method":"ping"}
  ```

## Important Rules for OData V4

### 1. Functions with parentheses `()`

CAP functions **always** require `()` at the end:

- ✅ Correct: `/odata/v4/mcp-proxy/Health()`
- ✅ Correct: `/odata/v4/auth/CheckAuth()`
- ❌ Incorrect: `/odata/v4/mcp-proxy/Health`
- ❌ Incorrect: `/odata/v4/auth/CheckAuth`

### 2. Function Parameters

Two methods are available:

**A) Query parameters (recommended for arrays and complex types)**

```
GET /odata/v4/mcp-proxy/ProbeDestination?destination=S4HANA
GET /odata/v4/auth/CheckRoles?required=["MCP_Connector"]
```

**B) Positional parameters in URL**

```
GET /odata/v4/mcp-proxy/ProbeDestination(destination='S4HANA')
GET /odata/v4/auth/CheckRoles(required=['MCP_Connector'])
```

### 3. Arrays in Query Parameters

Arrays are passed as JSON, URL encoded:

- ✅ Correct: `?required=["MCP_Connector"]` (JSON array)
- ✅ URL encoded: `?required=%5B%22MCP_Connector%22%5D`
- ❌ Incorrect: `?required=MCP_Connector`
- ❌ Incorrect: `?required[]=MCP_Connector`

### 4. Authorization

#### Development (Basic Auth)

```bash
# alice (MCP_Connector + MCP_Admin)
Authorization: Basic YWxpY2U6

# bob (MCP_Connector)
Authorization: Basic Ym9iOg==
```

#### Production (Bearer JWT)

```bash
Authorization: Bearer <JWT_TOKEN>
```

The JWT token must contain scope `MCP_Connector` (or `MCP_Admin`).

## Examples for Postman

### Health Check (only works with authorization!)

```
GET http://localhost:4004/odata/v4/mcp-proxy/Health()

Headers:
  Authorization: Basic YWxpY2U6  # alice: (empty password)

Or in production:
  Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### ProbeDestination

```
GET http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination?destination=ABAP_DEV

Headers:
  Authorization: Basic YWxpY2U6  # alice
```

**Expected Response:**

```json
{
  "destination": "ABAP_DEV",
  "connectivity": "internet",
  "proxyType": "Internet",
  "authentication": "BasicAuthentication",
  "sapClient": "100",
  "cloudConnectorLocationId": "",
  "tokenExpiresAt": 0,
  "probe": {
    "status": 200,
    "statusText": "OK",
    "contentType": "application/atomsvc+xml"
  },
  "timestamp": "2025-11-04T09:30:00.000Z"
}
```

### Stream HTTP (MCP protocol)

```
POST http://localhost:4004/mcp/stream/http

Headers:
  Authorization: Basic YWxpY2U6
  Content-Type: application/json
  X-MCP-Timeout: 60000

Body:
  {"jsonrpc":"2.0","id":"1","method":"ping"}
```

## Testing Endpoints

### Using the YAML Test Runner

- Copy the template and fill values:

  ```bash
  cp test/integration.yaml.template test/integration.yaml
  # Edit test/integration.yaml
  ```

- Run tests:

  ```bash
  npm test
  ```

- YAML fields: `baseUrl`, `auth.header`, `sap.mode` (direct/destination), `sap.direct.*` or `sap.destination.*`, optional `timeoutMs`, `streamTimeoutMs`, `headers`.

#### Manual Testing with curl

```bash
# Health check (CAP function)
curl -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/odata/v4/mcp-proxy/Health()

# Destination probe (CAP function)
curl -H "Authorization: Basic YWxpY2U6" \
  "http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination?destination=S4HANA"

# Stream HTTP (Express endpoint)
curl -X POST \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-MCP-Timeout: 60000" \
  -d '{"jsonrpc":"2.0","id":"1","method":"ping"}' \
  http://localhost:4004/mcp/stream/http
```

## Troubleshooting

### Error: "Service has no handler"

- Check if the handler file matches the service name:
  - `McpProxyService` → `srv/mcp-proxy.ts`

### Error: "Forbidden" or "Unauthorized"

- Check if Authorization header is set
- Check if the token contains the required scope (`MCP_Connector`)
- For development, check if the user exists in `package.json` → `cds.requires.auth[development].users`

### Error: "Function not found" or 404

- CAP functions require `()` at the end: `/odata/v4/mcp-proxy/Health()` not `/odata/v4/mcp-proxy/Health`
- Express endpoints don't use `/odata/v4/` prefix: `/mcp/stream/http` not `/odata/v4/mcp-proxy/stream/http`

### Error: "Malformed parameters"

- Check array format: must be JSON array `["role"]`, not string `"role"`
- URL encode arrays: `["MCP_Connector"]` → `%5B%22MCP_Connector%22%5D`

## Endpoint Summary

| Endpoint Type      | Path Prefix       | Authorization | Purpose                                               |
| ------------------ | ----------------- | ------------- | ----------------------------------------------------- |
| **CAP Functions**  | `/odata/v4/mcp-proxy/*` | **Required**  | OData V4 service functions (Health, ProbeDestination) |
| **Express Routes** | `/mcp/*`          | **Required**  | Direct Express endpoints (stream/http)                |

### CAP Functions

- Use OData V4 syntax: `/odata/v4/mcp-proxy/Health()`
- Functions require `()` at the end
- Parameters can be query params or positional: `?destination=NAME` or `(destination='NAME')`

### Express Endpoints

- Direct Express routes: `/mcp/stream/http`
- No OData prefix required
- Used for streaming protocols (NDJSON)
