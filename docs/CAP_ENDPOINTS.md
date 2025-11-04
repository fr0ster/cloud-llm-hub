# CAP Endpoint Paths

## AuthService (@path: 'auth')

### CheckAuth
- **Method**: GET
- **URL**: `/odata/v4/auth/CheckAuth()`
- **Parameters**: none
- **Authorization**: Not required (but possible to get user information)
- **Example**: 
  ```bash
  GET http://localhost:4004/odata/v4/auth/CheckAuth()
  ```

### CheckRoles
- **Method**: GET
- **URL**: `/odata/v4/auth/CheckRoles?required=["MCP_Connector"]`
- **Parameters**: 
  - `required` (array of String) - array of role names to check
- **Parameter Format**: JSON array, URL encoded
- **Authorization**: Required (checks roles of the authenticated user)
- **Examples**: 
  ```bash
  # Single role
  GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector"]
  
  # Multiple roles
  GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector","MCP_Admin"]
  ```

## McpProxyService (@path: 'mcp')

⚠️ **IMPORTANT**: All McpProxyService endpoints require authorization with scope `MCP_Connector` (`@requires: 'MCP_Connector'`)

### Health
- **Method**: GET
- **URL**: `/odata/v4/mcp/Health()`
- **Parameters**: none
- **Authorization**: ✅ Required - scope `MCP_Connector` needed
- **Example**: 
  ```bash
  GET http://localhost:4004/odata/v4/mcp/Health()
  Authorization: Basic YWxpY2U6  # for development (alice)
  # or
  Authorization: Bearer <JWT_TOKEN>  # for production
  ```

### ProbeDestination
- **Method**: GET
- **URL**: `/odata/v4/mcp/ProbeDestination?destination=NAME`
- **Or via positional parameter**: `/odata/v4/mcp/ProbeDestination(destination='NAME')`
- **Parameters**: 
  - `destination` (String, required) - destination name
- **Authorization**: ✅ Required - scope `MCP_Connector` needed
- **Implementation**: Uses SAP Cloud SDK's `executeHttpRequest` for automatic destination resolution, authentication, and proxy configuration.
- **Examples**: 
  ```bash
  # Via query parameter (recommended)
  GET http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=S4HANA
  
  # Via positional parameter
  GET http://localhost:4004/odata/v4/mcp/ProbeDestination(destination='S4HANA')
  
  # Production with Bearer token
  GET https://<your-app>.cfapps.<region>.hana.ondemand.com/odata/v4/mcp/ProbeDestination?destination=S4HANA
  Authorization: Bearer <JWT_TOKEN>
  ```

### InvokeTool (Deprecated)
- **Method**: POST
- **URL**: `/odata/v4/mcp/InvokeTool`
- **Status**: ⚠️ Deprecated - use `/mcp/stream/sse` or `/mcp/stream/http` instead

## Important Rules for OData V4

### 1. Functions with parentheses `()`
CAP functions **always** require `()` at the end:
- ✅ Correct: `/odata/v4/mcp/Health()`
- ✅ Correct: `/odata/v4/auth/CheckAuth()`
- ❌ Incorrect: `/odata/v4/mcp/Health`
- ❌ Incorrect: `/odata/v4/auth/CheckAuth`

### 2. Function Parameters
Two methods are available:

**A) Query parameters (recommended for arrays and complex types)**
```
GET /odata/v4/mcp/ProbeDestination?destination=S4HANA
GET /odata/v4/auth/CheckRoles?required=["MCP_Connector"]
```

**B) Positional parameters in URL**
```
GET /odata/v4/mcp/ProbeDestination(destination='S4HANA')
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
GET http://localhost:4004/odata/v4/mcp/Health()

Headers:
  Authorization: Basic YWxpY2U6  # alice: (empty password)

Or in production:
  Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### CheckRoles

```
GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector"]

Headers:
  Authorization: Basic YWxpY2U6  # alice
```

### ProbeDestination

```
GET http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=ABAP_DEV

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

## Troubleshooting

### Error: "Service has no handler"
- Check if the handler file matches the service name:
  - `AuthService` → `srv/auth.ts`
  - `McpProxyService` → `srv/mcp-proxy.ts`

### Error: "Forbidden" or "Unauthorized"
- Check if Authorization header is set
- Check if the token contains the required scope (`MCP_Connector`)
- For development, check if the user exists in `package.json` → `cds.requires.auth[development].users`

### Error: "Malformed parameters"
- Check array format: must be JSON array `["role"]`, not string `"role"`
- URL encode arrays: `["MCP_Connector"]` → `%5B%22MCP_Connector%22%5D`

## Service Differences

| Service | Path | Authorization | Purpose |
|---------|------|---------------|---------|
| `AuthService` | `/odata/v4/auth/*` | Optional | Authentication and role checking |
| `McpProxyService` | `/odata/v4/mcp/*` | **Required** | MCP proxy functionality |
