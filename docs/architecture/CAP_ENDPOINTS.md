# CAP Endpoint Paths

## McpProxyService (@path: 'mcp-proxy')

⚠️ **IMPORTANT**: Authorization differs by surface. The OData endpoints of `McpProxyService` need an authenticated XSUAA user — there is no `@requires` annotation on the service in the CDS model, so no particular role is enforced there. The raw `/mcp/**` and `/v1/**` routes are different: `requireMcpRole` in `srv/server.ts` rejects a token that carries none of **`MCP_Reader`, `MCP_Analyst`, `MCP_Developer`, `MCP_Full`** with 403. A valid JWT alone is not enough for those.

> **Note**: The CDS service path was changed from `'mcp'` to `'mcp-proxy'` to avoid
> conflicting with custom Express routes on `/mcp/stream/http`. See
> [CAP_EXPRESS_AUTH.md](../development/CAP_EXPRESS_AUTH.md#cds-service-path-conflict).

### Health

- **Method**: GET
- **URL**: `/odata/v4/mcp-proxy/Health()`
- **Parameters**: none
- **Authorization**: ✅ Authenticated XSUAA user required (OData surface — no specific scope enforced; `/mcp/**` and `/v1/**` additionally require an MCP role)
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
- **Authorization**: ✅ Authenticated XSUAA user required (OData surface — no specific scope enforced)
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
- **Authorization**: ✅ Authenticated XSUAA user **with an MCP role** — `requireMcpRole` in `srv/server.ts` returns 403 unless the token carries `MCP_Reader`, `MCP_Analyst`, `MCP_Developer` or `MCP_Full`
- **Content-Type**: `application/json` — exactly **one** JSON-RPC message per request (`srv/server.ts` runs a single `JSON.parse` over the whole body)
- **Accept**: `application/json, text/event-stream` — the response is SSE when the server streams progress
- **Purpose**: MCP Streamable HTTP transport, **stateless** (`sessionIdGenerator: undefined`) — no `Mcp-Session-Id` is issued or expected
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
GET /odata/v4/auth/CheckRoles?required=["MCP_Developer"]
```

**B) Positional parameters in URL**

```
GET /odata/v4/mcp-proxy/ProbeDestination(destination='S4HANA')
GET /odata/v4/auth/CheckRoles(required=['MCP_Reader'])
```

### 3. Arrays in Query Parameters

Arrays are passed as JSON, URL encoded:

- ✅ Correct: `?required=["MCP_Reader"]` (JSON array)
- ✅ URL encoded: `?required=%5B%22MCP_Reader%22%5D`
- ❌ Incorrect: `?required=MCP_Reader`
- ❌ Incorrect: `?required[]=MCP_Reader`

### 4. Authorization

#### Development (Basic Auth)

```bash
# alice (MCP_Full + MCP_Developer + MCP_Analyst + MCP_Reader)
Authorization: Basic YWxpY2U6

# bob (MCP_Developer + MCP_Analyst + MCP_Reader)
Authorization: Basic Ym9iOg==

# carol (MCP_Analyst + MCP_Reader)
Authorization: Basic Y2Fyb2w6

# dave (MCP_Reader)
Authorization: Basic ZGF2ZTo=
```

#### Production (Bearer JWT)

```bash
Authorization: Bearer <JWT_TOKEN>
```

The JWT token must contain one of: `MCP_Reader`, `MCP_Analyst`, `MCP_Developer`, `MCP_Full`.

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
- Check if the token contains one of the issued scopes (`MCP_Reader`, `MCP_Analyst`, `MCP_Developer`, `MCP_Full`)
- For development, check if the user exists in `package.json` → `cds.requires.auth[development].users`

### Error: "Function not found" or 404

- CAP functions require `()` at the end: `/odata/v4/mcp-proxy/Health()` not `/odata/v4/mcp-proxy/Health`
- Express endpoints don't use `/odata/v4/` prefix: `/mcp/stream/http` not `/odata/v4/mcp-proxy/stream/http`

### Error: "Malformed parameters"

- Check array format: must be JSON array `["role"]`, not string `"role"`
- URL encode arrays: `["MCP_Reader"]` → `%5B%22MCP_Reader%22%5D`

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

## Service-to-Service Authentication (consumer xsuaa tiers)

For service-to-service integrations via `client_credentials`, the deployment provisions three xsuaa instances, each granting a different default scope. External consumer services obtain credentials from whichever tier matches their required tool set.

| xsuaa instance | Default scope | Exposition tiers | Example consumer |
|---|---|---|---|
| `cloud-llm-hub-auth` (main) | `MCP_Reader` (via `authorities`) | `readonly + search` | Read-only monitors, health checks |
| `cloud-llm-hub-analyst-consumer` | `MCP_Analyst` | `+ system` | [`calm-dump-analyzer`](../examples/calm-dump-analyzer/) (dumps, SQL, profiling) |
| `cloud-llm-hub-developer-consumer` | `MCP_Developer` | `+ high` (CRUD) | Internal CI tooling (CreateUnitTest, activation) |

`MCP_Full` is deliberately **not** exposed via a dedicated consumer xsuaa — full access for unattended service flows requires explicit justification per use case. To grant `MCP_Full` to a specific new consumer, add `grant-as-authority-to-apps` to the `MCP_Full` scope in the `cloud-llm-hub-auth` resource's `config` in `mta.yaml`, and provision the consumer xsuaa there.

### How the cross-app scope grant works

1. **The provider grants.** The `cloud-llm-hub-auth` resource in `mta.yaml` carries the scopes in its `config` (not in `xs-security.json`). `MCP_Analyst` and `MCP_Developer` name their consumer in `grant-as-authority-to-apps` as `$XSAPPNAME(application,cloud-llm-hub-<tier>-consumer-${space-guid})`. MTA fills in the space guid; xsuaa resolves the tenant suffix (`!tNNN`) of the referenced app itself.
2. **The consumer accepts.** Each `xs-security-<tier>-consumer.json` declares `"authorities": ["$ACCEPT_GRANTED_AUTHORITIES"]` — it takes whatever the provider granted it, without naming the provider.
3. At `client_credentials` token issuance time, xsuaa inlines the granted scope into the consumer's token. `cloud-llm-hub-srv` accepts it unchanged because `@sap/xssec` validates signature, `iss`, and `aud` within the shared subaccount trust boundary — all three are common across xsuaa instances in the same subaccount.

Nothing in these descriptors names a subaccount, so a deployment needs no edits to them. `tools/make-staging-mta.js` renames the whole `config` for staging, so a staging deployment grants its own consumers, not production's.

To check a deployment, fetch a `client_credentials` token for a consumer and confirm its `scope` claim holds the granted scope: `tools/verify-consumer-xsuaa.sh`.

### Overriding in a deployment

A deployment that needs different grants overrides the `config` of these resources in its `.mtaext` (a key set there replaces the same key from `mta.yaml`). Prefer that to editing the descriptor files in a fork: an edited tracked file can conflict on every upstream update.
