# API Reference

**Version:** 2.3.0
**Last Updated:** 2026-04-08

Complete API specification for Cloud LLM Hub endpoints.

## Base URL

- **Development:** `http://localhost:4004`
- **Production:** `https://<your-app>.cfapps.<region>.hana.ondemand.com`

## Authentication

All endpoints require authentication via one of:

- **Basic Authentication** (development only): `Authorization: Basic <base64-encoded-credentials>`
- **Bearer Token** (production): `Authorization: Bearer <XSUAA-JWT-token>`

### Obtaining XSUAA Token

```bash
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

## Endpoints

### 1. Health Check

**Endpoint:** `GET /odata/v4/mcp-proxy/Health()`

**Description:** Returns health status of the MCP proxy service.

**Authentication:** Required

**Response:**

```json
{
  "status": "UP",
  "timestamp": "2025-11-05T12:00:00.000Z"
}
```

**Status Codes:**

- `200 OK` - Service is healthy
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - Insufficient permissions

**Example:**

```bash
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp-proxy/Health\(\)
```

---

### 2. Probe Destination

**Endpoint:** `GET /odata/v4/mcp-proxy/ProbeDestination?destination={name}`

**Description:** Tests destination connectivity and configuration using SAP Cloud SDK.

**Authentication:** Required

**Query Parameters:**

- `destination` (required) - Destination name configured in BTP Destination service

**Response:**

```json
{
  "destination": "SAP_DEV_DEST",
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
  "timestamp": "2025-11-05T12:00:00.000Z"
}
```

**Status Codes:**

- `200 OK` - Destination probe successful
- `400 Bad Request` - Missing or invalid destination parameter
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Destination not found
- `502 Bad Gateway` - Destination connection failed

**Example:**

```bash
curl -H "Authorization: Basic YWxpY2U6" \
     "http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination?destination=SAP_DEV_DEST"
```

---

### 3. OpenAI-Compatible Chat Completions

**Endpoint:** `POST /v1/chat/completions`

**Description:** OpenAI-compatible chat endpoint powered by SmartAgent with RAG-based tool selection. LLM provider is configurable via `LLM_AGENT_PROVIDER` env var (`sap-ai-sdk`, `openai`, `anthropic`, `deepseek`).

**Authentication:** Required

**Headers:**

- `Authorization` (required) - Basic or Bearer token
- `Content-Type: application/json` (required)
- `X-SAP-Destination` (optional) - Override active SAP destination for this request
- `X-Rag-Collections` (optional) - Comma-separated list of RAG collection names to query

**Request Body:**

```json
{
  "model": "anthropic--claude-4.5-sonnet",
  "messages": [
    { "role": "user", "content": "List all classes in package Z_MY_PKG" }
  ],
  "stream": true,
  "tools": [],
  "rag_collections": ["my-collection"]
}
```

- `model` (optional) — LLM model name; if different from current, triggers model switch
- `messages` (required) — OpenAI-format message array
- `stream` (optional, default: `true`) — SSE streaming or JSON response
- `tools` (optional) — external tool definitions to pass alongside MCP tools
- `rag_collections` (optional) — array of RAG collection names to include in context (alternative to `X-Rag-Collections` header)

**Response (streaming):** Server-Sent Events with OpenAI delta format.

**Response (non-streaming):**

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "model": "anthropic--claude-4.5-sonnet",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Found 12 classes..." },
      "finish_reason": "stop"
    }
  ]
}
```

**Status Codes:**

- `200 OK` - Chat response
- `401 Unauthorized` - Missing or invalid authentication
- `503 Service Unavailable` - SmartAgent is initializing (MCP connect + tool corpus load), or the tool corpus was not built (`ToolCorpusMissingError` — run the build step)

**Honesty guard note *(v6.28+)*:** the response (streaming or non-streaming, and the same on `/v1/messages` and `execute_step`) may carry a trailing `UNVERIFIED_WRITE:` line when the reviewer finds a claimed write (create/update/activate/…) unsupported by the actual tool results. It's a soft warning — verify against the system before relying on the claim — never a block. Disable via `LLM_AGENT_STEP_REVIEW_ENABLED=false`.

---

### 4. List Models

**Endpoint:** `GET /v1/models`

**Description:** Returns available LLM models from the configured provider (SAP AI Core, OpenAI, Anthropic, DeepSeek — see `LLM_AGENT_PROVIDER`), plus destination status information.

**Authentication:** Required

**Response:**

```json
{
  "object": "list",
  "data": [
    { "id": "anthropic--claude-4.5-sonnet", "object": "model", "created": 0, "owned_by": "sap-ai-core" },
    { "id": "gpt-4o-mini", "object": "model", "created": 0, "owned_by": "sap-ai-core" }
  ],
  "_active_model": "anthropic--claude-4.5-sonnet",
  "_active_destination": "S4HANA_DEV",
  "_destinations": [
    { "name": "S4HANA_DEV", "status": "ready", "toolCount": 259 },
    { "name": "S4HANA_TST", "status": "vectorizing", "toolCount": 0 },
    { "name": "S4HANA_QAS", "status": "pending", "toolCount": 0 }
  ]
}
```

**Extension fields** (not part of OpenAI spec):

- `_active_model` — currently selected LLM model
- `_active_destination` — currently active SAP destination
- `_destinations` — array of discovered destinations with vectorization status and tool count

---

### 5. Token Usage

**Endpoint:** `GET /v1/usage`

**Description:** Returns cumulative token usage statistics for the current session.

**Authentication:** Required

---

### 6. Get Token

**Endpoint:** `GET /v1/token`

**Description:** Returns the caller's JWT token from the `Authorization: Bearer` header. Useful for extracting and reusing the token in external tools or scripts.

**Authentication:** Required (Bearer token only)

**Response:**

```json
{
  "token": "<jwt-token>"
}
```

**Status Codes:**

- `200 OK` - Token returned
- `401 Unauthorized` - No Bearer token found in request

**Example:**

```bash
curl -H "Authorization: Bearer <token>" \
     http://localhost:4004/v1/token
```

---

### 7. Resolve System Destination

**Endpoint:** `GET /v1/destinations/resolve`

**Description:** Resolves a system code (e.g., `DEV.100`) to the corresponding BTP destination name using configured mappings.

**Authentication:** Required

**Query Parameters:**

- `system` (required) - System code in format `<SID>.<client>` (e.g., `DEV.100`)

**Response:**

```json
{
  "system": "DEV.100",
  "destination": "S4HANA_DEV"
}
```

**Status Codes:**

- `200 OK` - Destination resolved
- `400 Bad Request` - Missing `system` query parameter
- `404 Not Found` - No mapping found for the given system code

**Example:**

```bash
curl -H "Authorization: Bearer <token>" \
     "http://localhost:4004/v1/destinations/resolve?system=DEV.100"
```

---

### 8. List Destination Mappings

**Endpoint:** `GET /v1/destinations/mappings`

**Description:** Lists all configured system-to-destination mappings.

**Authentication:** Required

**Response:**

```json
{
  "mappings": {
    "DEV.100": "S4HANA_DEV",
    "TST.100": "S4HANA_TST"
  }
}
```

**Status Codes:**

- `200 OK` - Mappings returned

**Example:**

```bash
curl -H "Authorization: Bearer <token>" \
     http://localhost:4004/v1/destinations/mappings
```

---

### 9. Refresh Destinations

**Endpoint:** `POST /v1/destinations/refresh`

**Description:** Re-initializes unreachable destinations. Triggers reconnection for destinations that failed initial setup or became unavailable.

**Authentication:** Required

**Response:**

```json
{
  "destinations": [
    { "name": "S4HANA_DEV", "status": "ready" },
    { "name": "S4HANA_TST", "status": "error" }
  ]
}
```

**Status Codes:**

- `200 OK` - Refresh completed
- `500 Internal Server Error` - Refresh operation failed

**Example:**

```bash
curl -X POST -H "Authorization: Bearer <token>" \
     http://localhost:4004/v1/destinations/refresh
```

---

### 10. List RAG Backends (Planned)

**Endpoint:** `GET /v1/rag/backends`

**Description:** Lists available RAG backend types and their configuration status.

> **Note:** This endpoint is planned and available on a feature branch. Not yet in production.

**Authentication:** Required

---

### 11. SSE Stream (disabled)

**Endpoint:** `GET /mcp/stream/sse`

**Description:** SSE transport is currently disabled. Requests return `404`.

---

### 12. Stream-HTTP

**Endpoint:** `POST /mcp/stream/http`

**Description:** Off by default: answers `404` `PLAIN_MCP_DISABLED` unless `LLM_AGENT_PLAIN_MCP=true`. The agent MCP (`/mcp/agent/stream/http`) is the default external channel. MCP Streamable HTTP. **One JSON-RPC message per HTTP request** — `srv/server.ts` reads the whole body and runs a single `JSON.parse`, so a body holding several objects is a parse error. The transport is stateless (`sessionIdGenerator: undefined`), so each request stands alone. Responses stream back as SSE when the tool emits progress.

**Authentication:** Required

**Headers:**

- `Authorization` (required) - Basic or Bearer token
- `Content-Type: application/json` (required)
- `Accept: application/json, text/event-stream` (required)
- `X-SAP-Destination` (optional) - Destination name for destination mode
- `X-SAP-URL` (optional) - Direct SAP URL for direct mode
- `X-SAP-Client` (optional) - SAP client number
- `X-SAP-Auth-Type` (optional) - `jwt` or `basic`
- `X-SAP-JWT-Token` (optional) - SAP JWT token (for direct mode)

**Request Body:**

- Content-Type: `application/json`
- Exactly one JSON-RPC 2.0 request object

**Response:**

- `application/json` for a plain result, or `text/event-stream` when the server
  streams progress — hence the required `Accept` above
- One JSON-RPC 2.0 response per request

**Status Codes:**

- `200 OK` - Stream started successfully
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - Insufficient permissions
- `502 Bad Gateway` - MCP server connection failed

**Example:**

```bash
# One JSON-RPC message per request — the server reads the whole body and runs a
# single JSON.parse (srv/server.ts), so two objects in one body is a parse error.
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -H "X-SAP-Destination: SAP_DEV_DEST" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http

curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -H "X-SAP-Destination: SAP_DEV_DEST" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"GetObjectList","arguments":{"objectType":"CLAS"}}}' \
     http://localhost:4004/mcp/stream/http
```

**Response Format:**

```
{"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
{"jsonrpc":"2.0","id":2,"result":{"objects":[...]}}
```

**Session Management:**

There is none. The transport is created with `sessionIdGenerator: undefined`
(`srv/mcp-manager.ts`), i.e. stateless mode: the server issues no
`Mcp-Session-Id` and expects none back. Each request builds its own MCP server
from its own `x-sap-*` headers, so there is nothing to reset.

---

## SAP Connection Headers

### Destination Mode (Recommended)

**Header:** `X-SAP-Destination: <destination-name>`

**Description:** Use SAP BTP Destination service for connection configuration.

**Supported Authentication Types:**

- `BasicAuthentication` — destination stores credentials
- `OAuth2ClientCredentials` — automatic token management via BTP
- `OAuth2SAMLBearerAssertion` — Principal Propagation with user context
- `NoAuthentication` — destination has no credentials; caller must provide `X-SAP-Login` and `X-SAP-Password` headers

**Benefits:**

- Centralized configuration
- Automatic authentication handling
- Cloud Connector support
- No credentials in requests (except `NoAuthentication`)

**Credential Override:** For any destination type, you can override authentication by providing `X-SAP-Login` and `X-SAP-Password` headers. This is useful for testing or when destination-configured credentials need to be replaced.

### Responsible person and master system

For every system type, an explicit `x-sap-responsible` wins, followed by the logged-on SAP user from `/sap/bc/adt/core/http/systeminformation`, then uppercased `x-sap-login` if the endpoint has no user or is unavailable. The endpoint exists on ABAP Cloud and newer on-premise releases. Under principal propagation, `x-sap-login` is only a responsible hint, never an authentication credential. With no user, creates are refused with `system_context_missing`; send `x-sap-responsible` with an SAP user ID.

Values are scoped to each request on all channels. `X-SAP-Master-System` overrides the system ID returned by the same probe; unknown master systems are omitted. The public ADT helper runs after a successful SAP connect using that same connection, once per authenticated session. A process-local LRU cache (1000 entries) includes unavailable answers and is keyed by destination or direct URL, SAP client, and authenticated principal. Principal-propagation entries expire at JWT `exp`; other entries default to eight hours, configurable through `SYSTEM_IDENTITY_CACHE_TTL_MS`. Transient errors are not cached. Control requests do not query SAP. Explicit responsible headers take precedence over cached identity. On-premise lookup failures fall back to headers; cloud failures retain retryable failure behavior. Creates without a responsible are refused before mutation.

### System type

**TL;DR:** the hub never guesses whether a system is on-premise or ABAP Cloud. It is declared, else `onprem`.

The kind is the first of:

1. the `X-SAP-System-Type` request header;
2. the destination's `SAP_SYSTEM_TYPE` property — a BTP destination's additional property, or a field of a Cloud SDK `destinations` entry (see [LOCAL_RUN.md](../development/LOCAL_RUN.md));
3. `onprem`.

Values: `onprem`, `cloud`, `legacy` (an older on-premise system). Case-insensitive.

- **An unknown value is refused**, never defaulted: `400` with `INVALID_SYSTEM_TYPE` on `/mcp/stream/http` and `/v1/*`, a tool error on `execute_step`. An unknown destination property fails that destination's resolution (`502`, naming the destination and the property).
- **Nothing else decides it** — not the destination's `ProxyType`, not the authentication, not `X-SAP-URL`.

What the kind changes:

- **Raw MCP route:** which tools are listed (on-premise-only tools such as `CreateProgram`), — for a direct `X-SAP-URL` connection — the connector: `cloud` → `AdtCloudConnector`, otherwise `AdtOnPremConnector`.
- **Agent channels** (`/v1/*`, `execute_step`): the value is checked and logged. Responsible resolution follows the same order on every channel.

The SAP client follows the same precedence: `X-SAP-Client` overrides the destination's `sap-client`.

**Example (standard destination):**

```bash
curl -H "Authorization: Bearer <token>" \
     -H "X-SAP-Destination: SAP_PROD_DEST" \
     https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http
```

**Example (NoAuthentication destination with credential headers):**

```bash
curl -X POST \
     -H "Authorization: Bearer <token>" \
     -H "X-SAP-Destination: SAP_NO_AUTH_DEST" \
     -H "X-SAP-Login: MY_USER" \
     -H "X-SAP-Password: MY_PASS" \
     -H "Content-Type: application/json" \
     https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http
```

### Direct Mode

**Headers:**

- `X-SAP-URL: <sap-url>` (required)
- `X-SAP-Client: <client-number>` (required)
- `X-SAP-Auth-Type: jwt|basic` (required)
- `X-SAP-JWT-Token: <token>` (for JWT)
- OR `X-SAP-Login: <username>` and `X-SAP-Password: <password>` (for Basic)
- `X-SAP-System-Type: onprem|cloud|legacy` (optional, default `onprem`) — picks the connector. A direct connection to ABAP Cloud must send `cloud`.

**Description:** Direct connection to SAP system without Destination service. The session is logged off when the request ends — after any open LOCK..UNLOCK chain has finished, also when the client disconnects.

**Use Cases:**

- Development
- Testing
- Local deployments

**Example:**

```bash
curl -H "Authorization: Basic YWxpY2U6" \
     -H "X-SAP-URL: https://sap.example.com" \
     -H "X-SAP-Client: 200" \
     -H "X-SAP-System-Type: cloud" \
     -H "X-SAP-Auth-Type: jwt" \
     -H "X-SAP-JWT-Token: <sap-jwt-token>" \
     http://localhost:4004/mcp/stream/http
```

### On-Premise Connectivity

When using on-premise destinations, additional headers may be required:

- `X-SAP-Connectivity-Mode: onprem` - Enable Connectivity proxy
- `X-SAP-Connectivity-Location-ID: <location-id>` - Cloud Connector location ID (optional)

**Note:** These are typically handled automatically by the Destination service.

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {
      "field": "additional error details"
    }
  }
}
```

### Common Error Codes

| Code                  | Status | Description                       |
| --------------------- | ------ | --------------------------------- |
| `UNAUTHORIZED`        | 401    | Missing or invalid authentication |
| `FORBIDDEN`           | 403    | Insufficient permissions          |
| `NOT_FOUND`           | 404    | Resource not found                |
| `BAD_REQUEST`         | 400    | Invalid request parameters        |
| `INVALID_SYSTEM_TYPE` | 400    | `X-SAP-System-Type` is not `onprem`, `cloud` or `legacy` |
| `INTERNAL_ERROR`      | 500    | Internal server error             |
| `BAD_GATEWAY`         | 502    | MCP server connection failed      |
| `SERVICE_UNAVAILABLE` | 503    | Service temporarily unavailable   |
| `TIMEOUT`             | 504    | Request timeout                   |

### Example Error Response

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "details": {
      "reason": "Missing Authorization header"
    }
  }
}
```

---

## Rate Limiting

**Inbound — the gatekeeper.** With `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` set, every
pipeline-starting channel counts against one door. A caller that cannot start
at once waits in a bounded queue; once admitted it is carried to the end — only
a shutdown ends it. When the queue is full the caller is refused, with the reason
and **without** a `Retry-After`: how long the sessions ahead will run is not
something the service measures.

A caller that goes away while it waits leaves the queue and is never admitted
later. On `execute_step` that is the MCP transport closing — a planner whose own
timeout fired — so a step it retries is not also run for nobody.

| Reason | Meaning | `/v1/chat/completions` | `/v1/messages` | `execute_step` |
|---|---|---|---|---|
| `session_busy` | this session is still running a request | `503`, `error.code: gatekeeper_session_busy` | `529` `overloaded_error` | text prefixed `gatekeeper_session_busy:` |
| `capacity` | every slot is taken | `503`, `error.code: gatekeeper_capacity` | `529` `overloaded_error` | text prefixed `gatekeeper_capacity:` |
| `retention` | no room to keep another session | `503`, `error.code: gatekeeper_retention` | `529` `overloaded_error` | text prefixed `gatekeeper_retention:` |

A client disconnect does not stop a running session: SAP may be halfway through
a write, and cutting it leaves objects locked. The session finishes and its
output is discarded.

**Outbound (the LLM provider)** — handled since v6.35, by the provider itself
(`@mcp-abap-adt/llm-agent` 23.0.0). A `429` from SAP AI Core, OpenAI or
Anthropic is answered where the HTTP response is still intact: backoff with
jitter, `Retry-After` honoured when the server sends one, and one shared pause
per quota so concurrent callers do not each rediscover the same closed limit.

The wait budget is **20 seconds** here, not the library's sixty. A budget that
expires when the caller does never gets to deliver its answer: our chat clients
give up around a minute, so the policy must give up well before that and say
when to come back. Override with `LLM_AGENT_THROTTLE_MAX_WAIT_MS`; the value in
force is logged at startup, since it shows itself only under load.

With a door configured this budget is not applied: an admitted session waits
out exactly the interval the server named, and a `429` that names none fails it.

This service therefore does **not** retry a rate limit of its own. Another
request into a quota the server has just said is closed only earns another
penalty and lengthens the window. When the provider's policy is spent, the
caller is told, and told when to come back — on **every** channel, in the shape
that channel speaks:

| Channel | What arrives |
|---|---|
| `/v1/chat/completions` | the message as the response content, streaming or not |
| `/v1/messages` non-streaming | HTTP `529` with `Retry-After`, and Anthropic's `overloaded_error` envelope — the pairing their own API uses |
| `/v1/messages` streaming | an SSE `error` event carrying the same envelope |
| `execute_step` (MCP) | the message as the step's `ERROR on destination …` text |

```
The AI service is rate-limited right now. Please try again in about 42 seconds.
```

The status is a 5xx, not `429`. A `429` says **this caller** sent too many
requests, and that is not what happened twice over: the caller does not set the
rate, and the traffic is not one-to-one — a single chat request fans out into as
many LLM calls as the tool loop needs, so one consumer request says nothing
about how much upstream quota it spends. What did happen is that the service is
temporarily unable to answer and knows when it will be able to.

Which 5xx follows the channel's dialect: `/v1/messages` answers `529`, the status
Anthropic pairs with `overloaded_error`, so a client written against their API
needs no special case from us.

The header carries whole seconds, rounded up. The same number is in the message
text for a human to read; a client retrying on its own reads the header.

The number is the server's own `Retry-After`, carried on the error rather than
guessed at.

---

### Long sessions

`/v1/chat/completions` and `/v1/messages` serve requests in a long session only,
unless `LLM_AGENT_PLAIN_API=true` (see [CONFIG_USAGE](../llm-agent/CONFIG_USAGE.md#long-sessions)).
A long session holds one ABAP connection between requests (one stateful ADT
context: debugger, locks), its chat history, its session collections and its
destination, under a server-issued key. Its TTL counts from the last request.

| Call | Answer |
|---|---|
| `POST /v1/session`, body `{ "destination"?: string }` | `201 { session, ttlSeconds, destination }`; the key also comes back in the `clh_session` cookie |
| any `/v1` request with `x-clh-session: <key>` | served in that session; the header wins over the cookie |
| `DELETE /v1/session` (or `POST /v1/session/close`) with the key | `204` once the session is closed: ABAP session, history, session collections and record are gone |

Requests of one session run one after another; a request behind a full queue is
refused. Refusals carry the code in `error.code`, in the OpenAI and the
Anthropic envelope alike:

| Code | Status | When |
|---|---|---|
| `SESSION_REQUIRED` | 400 | no key, plain mode off |
| `SESSION_NOT_FOUND` | 404 | the header names no open session (closed, expired, never opened, another user's); an unknown cookie is ignored |
| `SESSION_LIMIT` | 429 | an open (or a revival) beyond `LLM_AGENT_MAX_SESSIONS` / `LLM_AGENT_MAX_SESSIONS_PER_USER` |
| `SESSION_BUSY` | 429 | the session's queue (`LLM_AGENT_SESSION_QUEUE`) is full |
| `SESSION_STORE_UNAVAILABLE` | 503, `Retry-After: 5` | a revival asked for before the hub's providers are ready |
| `SAP_CREDENTIALS_REQUIRED` | 401 | the session was opened with SAP credentials and this request carries none |
| `SESSION_CREDENTIAL_MISMATCH` | 403 | another SAP login (or client) than the session was opened with |

The two credential refusals use the shape of every SAP credential failure:
`{ error: { type: <code>, message, destination } }`, the code in `error.type`.

**Notices.** `x-clh-session-notice` on a response:

- `revived`: the hub restarted and gave the session back from its record
  (history window, session collections, destination). Its ABAP session is new:
  debugger state and locks are lost. The old ABAP session is left to SAP's own
  timeout.
- `abap_session_renewed`: a new ABAP session replaced the held one (a changed
  JWT, a destination switch); debugger state and locks are lost.

**Destination switch.** A request naming another destination closes the old ABAP
session and opens a new one; the chat history and session collections stay.

**Agent MCP.** On `/mcp/agent/stream/http` the same session is reached through
tools: `session_open({ destination? })` returns `{ session, ttlSeconds,
destination }`, `execute_step({ session, task, destination? })` runs in it (a
`destination` other than the session's is refused), and
`session_close({ session })` closes it. Errors come back as tool errors with the
codes above.

The external agent endpoint additionally supports text knowledge writes. These five
strict-object tools accept an optional nonempty `session` argument. A live,
caller-owned session is required even for user collections. Key precedence is
`session`, `x-clh-session`, then the `clh_session` cookie; obtain the key with
`session_open`. Transport `mcp-session-id` and legacy `x-session-id` are not keys.
UTF-8 JSON-serialized arguments, including attributes and session, must fit in
10 MiB (10,485,760 bytes). No file upload, chunking, or URL fetching occurs.

| Tool | Required arguments | Optional attributes | Success fields besides `result` |
|---|---|---|---|
| `collection_create` | `name: string`, `scope: "user" \| "session"` | `session` | `collection`, normalized `name`, `scope`, `created: boolean` |
| `collection_delete` | `collection: string` | `session` | `collection`, `deleted: true` |
| `record_add` | `collection: string`, `text: string` | `title: string`, `source: string`, `session` | `collection`, `record`, `created: true` |
| `record_update` | `collection: string`, `record: string`, `text: string` | `title: string`, `source: string`, `session` | `collection`, `record`, `updated: true` |
| `record_delete` | `collection: string`, `record: string` | `session` | `collection`, `record`, `deleted: true` |

Required strings are nonempty; text is preserved verbatim. Empty optional title
and source strings are allowed. Source is attribution only (no URL fetch).
Create normalizes the name as REST does and returns a physical collection ID.
Repeated create returns `created: false` and the existing knowledge collection.
Add generates a UUID. Update replaces the full text, retains omitted title/source
and all other stored metadata and creation time, and reads the authoritative
backend record first. Delete removes exactly one document, including one old
upload chunk. No record write implicitly creates a collection.

All five reject visible agents collections with `TOOL_FORBIDDEN`, including
normalized-name collisions on create. Foreign user and other-session targets
remain 404, including for admins. Existing global mutations require `MCP_Admin`
only where the existing REST resolver exposes them; global creation and new
global knowledge lookup are unavailable. These tools are excluded from internal
planner, executor, checker, dispatcher and dialogue tool catalogues and retrieval;
forged internal calls fail before forwarding.

Schema violations (missing fields, wrong types, invalid scope, extra fields, or empty required strings) are rejected by the MCP SDK before the callback as text errors with `isError: true`; they are not measured. Semantic errors, including the 10 MiB argument limit and reserved logical names, return structured errors with `structuredContent.result` from the measured callback.

Every write success or semantic error has matching text and `structuredContent.result`:

```json
{
  "content": [{ "type": "text", "text": "Record added." }],
  "structuredContent": {
    "result": "Record added.",
    "collection": "notes__u_<owner-key>",
    "record": "<generated-uuid>",
    "created": true
  }
}
```

For example, call `collection_create({ name: "notes", scope: "user", session })`,
then `record_add({ collection: <returned collection>, text: "A useful fact", session })`.
Use the returned exact `record` ID for replacement or deletion.
Semantic errors set `isError: true` and carry
`structuredContent: { result, error: { code, message, status } }` without echoing
record text. Codes include `INVALID_ARGUMENT` (400), `PAYLOAD_TOO_LARGE` (413),
`UNAUTHENTICATED` (401), `FORBIDDEN`/`TOOL_FORBIDDEN` (403),
`COLLECTION_NOT_FOUND`/`RECORD_NOT_FOUND` (404), `EMBEDDING_FAILED` and
`BACKEND_ERROR` (operation fallback). Backend RAG codes and backend statuses
(409/502/503) are preserved. Session failures retain `SESSION_REQUIRED`,
`SESSION_NOT_FOUND`, `SESSION_LIMIT`, `SESSION_STORE_UNAVAILABLE`,
`session_closed` (410) and `gatekeeper_retention` (503).

The agent MCP also exposes RAG tools for clients that manage their own LLM
context. Each takes an optional `session` key from `session_open`; alternatively
send `x-clh-session`. A session is required, and calls hold its queue and RAG
lease. Unknown, closed, or other-user sessions return tool errors. Collections
use the same id/name resolver and ownership checks as the REST API.

| Tool | Arguments and result |
|---|---|
| `rag_search` | `{ query, collections?, k? }`; returns `{ hits: [{ collection, id, title?, text, score? }], unavailable?: [{ collection, error }] }`. Searches only collections enabled for the session; `collections` only narrows that set (an empty list searches none). `k` defaults to 8, maximum 20 across collections. Unavailable collections are skipped; bounded failure notes share the 24,000-character JSON output cap with hits, with `[truncated]` on cut text. |
| `rag_read` | `{ collection, id, offset?, limit? }`; returns `{ id, offset, total, next?, text, attributes }`. Character offsets start at zero; limit defaults to 8,000, maximum 32,000. `next` is absent at the end. |
| `collections_list` | `{}`; returns `{ collections: [{ id, name, scope, enabled, defaultEnabled, documents }] }`, including effective session enablement. |
| `collection_set_enabled` | `{ collection, enabled }`; sets a persisted session override, leaving the collection default and other sessions unchanged. |
| `collection_records` | `{ collection, offset?, limit? }`; returns `{ total, records: [{ id, title?, source?, attributes: { enabled } }] }`. Record offset defaults to zero, limit to 50, maximum 200. |
| `record_set_enabled` | `{ collection, id?, source?, uploadId?, enabled }`; supply exactly one of `id` or `source`. Source changes apply to all chunks of that upload; `uploadId` defaults to the legacy empty upload id. Requires the same write permission as REST. |

Disabled records never appear in search. Reads of a disabled record or disabled
collection return only the record id, safe enablement attributes, and a reason;
record lists omit their titles, sources, and text. All read/list record attributes use the same normalized `{ enabled: boolean }` shape; internal metadata is excluded. Search hit ids can be passed
directly to `rag_read` and `record_set_enabled`. Invalid paging arguments return
tool errors.

### Plain sessions (cookie)

This applies with `LLM_AGENT_PLAIN_API=true`, to requests that carry no
long-session key. The service issues the session in an `HttpOnly` cookie,
`clh_session`, on the first `/v1` response that has none, and keys every session by that value
**together with the authenticated user**. Request headers do not name a
session: `x-session-id` and `mcp-session-id` are not read.

**Migrating from `x-session-id`.** A client that wants a session across
requests keeps the cookie and sends it back — `curl -c jar -b jar`. A
`/v1/rag/collections` request with `scope: 'session'` that still sends
`x-session-id` is answered `400`, naming the cookie. A client that keeps no
cookies gets a fresh session per request; use `scope: 'user'` instead, with its
different lifetime and visibility.

**Ending a session.** `DELETE /v1/session` answers `204` at once. The session is
unreachable from that moment; its history and collections are removed once
whatever is running against it has stopped — a RAG upload is
cancelled and then waited for, a running pipeline is waited for. A request
against a session being removed is answered `410` on every channel that has a
session — the shape differs, since only the OpenAI and RAG envelopes carry a
`code` field:

| Channel | Shape |
|---|---|
| `/v1/chat/completions` | `{ error: { message, type: 'invalid_request_error', code: 'session_closed' } }` |
| `/v1/messages` | `{ type: 'error', error: { type: 'invalid_request_error', message } }` — no `code` field |
| `/v1/rag/*` | `{ error: { message, code: 'session_closed' } }` — no `type` field |

`execute_step` has no such path: it issues no cookie, so there is no session for
it to close. The next request carrying the old cookie is given a new session.

**Retention.** With `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` set, creating a
session-scoped collection when every place is taken by something running is
answered `503` with `error.code: gatekeeper_retention`. An idle session is
evicted instead when one exists — silently, so its next question arrives
without the earlier context.

Eviction takes sessions no caller ever came back to first — a client that keeps
no cookie is given one per request — and only then the least recently used
session a caller did present.

### A closed destination

When an SAP destination has been closed after an outage
(`srv/agent-manager.ts` — `closeDestination` / `isDestinationClosed` /
`retryAfterForDestination`), each pipeline-starting channel refuses **before**
attempting a connection or resolving an agent for it. The system that is down is
not contacted again, and the caller is not told its credentials failed:

| Channel | Status | Shape |
|---|---|---|
| `/v1/chat/completions` | `503` | `{ error: { type: 'overloaded_error', message } }`, `Retry-After` header when known |
| `/v1/messages` | `503` | `{ type: 'error', error: { type: 'overloaded_error', message } }`, `Retry-After` header when known |
| `execute_step` | — (text result, `isError: true`) | `<message>` (a `Try again in about N seconds.` suffix when the wait is known) |

Neither JSON body carries an `error.code` here — this is not one of the door's
three `gatekeeper_*` reasons above, and the `/v1/messages` status is `503`, not
the `529` the door and the throttle path use. `Retry-After`, when present, is
**when the next background probe of that destination is due** — not an
estimate of when SAP itself will be reachable again, which the service cannot
know. This is a different fact from the door's own refusals (`session_busy` /
`capacity` / `retention`), which never carry a `Retry-After`: those measure
sessions ahead in a queue, which the service does not time.

### An unanswered write

A request can fail while a write tool call was sent and no answer ever came
back — the connection dropped mid-flight, for instance
(`srv/lib/recording-mcp-client.ts`, `RecordingMcpClient.unanswered`). When that
happens the failure text names the tool(s) and is prefixed `UNVERIFIED_WRITE:`;
it says the write was sent and **not retried**, that it may or may not have
been applied, and that the caller must read the object back to find out — the
service never repeats a write it cannot confirm.

| Channel | Where it appears |
|---|---|
| `/v1/chat/completions` | the response `message.content`, HTTP `200` (same shape as a normal completion) |
| `/v1/messages` non-streaming | the response body via `anthropicUnverifiedWrite`, status `500` alone or the throttle status when a throttle also applies |
| `/v1/messages` streaming | an SSE `event: error` carrying the same envelope |
| `execute_step` | the step's `ERROR on destination "…": UNVERIFIED_WRITE: …` text |

The text and the lookup are built in `srv/lib/throttle-surfacing.ts`
(`unverifiedWriteText`, `unverifiedWriteFor`, `anthropicUnverifiedWrite`).

### `Health` carries the gatekeeper snapshot

`GET /odata/v4/mcp-proxy/Health()` gains a `gatekeeper` field: a JSON *string*
(counts only, per process — not per session) with four scopes
(`srv/lib/gatekeeper-metrics.ts`):

- **`door`** — `{ configured: false }` when `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`
  is unset; otherwise `srv/lib/door.ts`'s `DoorSnapshot`: `live`, `capacity`,
  `queued`, `queueLength`, `highWater`, `refusals` (by reason), `left`.
- **`retention`** — `srv/lib/session-retention.ts`'s `RetentionSnapshot`:
  `retained`, `cap`, `evictions`, `closing`, `cleanupFailed` — removals that did
  not complete, since start: a collection whose data its RAG backend did not
  clear, or a session store that threw. The collection or session was removed
  regardless, so nothing can reach it; nothing is retried.
- **`destinations`** — one entry per known destination: `name`, `closed`,
  `refusals`.
- **`throttling`** — `events`, `gaveUp`, `noInterval`, `byQuota` (per quota
  key).

---

## Timeouts

- **Stream-HTTP:** 2 minutes (120 seconds)
- **Health Check:** 5 seconds
- **Probe Destination:** 30 seconds
- **ADT request via a destination** (`CloudSdkAbapConnection`): **none**, whatever `timeout`
  the ADT client passes. A long request means a lot of data or a loaded system; the consumer
  that wants a bound closes the connection itself. Session teardown (`closeSession`) never
  cuts a lock→modify→unlock chain: it waits for the critical section to end.

---

## MCP Protocol

Cloud LLM Hub implements the Model Context Protocol (MCP) specification. All MCP requests and responses follow the JSON-RPC 2.0 format.

### Supported MCP Methods

- `tools/list` - List available MCP tools
- `tools/call` - Call a specific MCP tool
- `initialize` - Initialize MCP session
- `ping` - Health check

### MCP Tool Examples

**Get Object List:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "GetObjectList",
    "arguments": {
      "objectType": "CLAS",
      "package": "Z_MY_PACKAGE"
    }
  }
}
```

**Get Object Details:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "GetObjectDetails",
    "arguments": {
      "objectName": "Z_MY_CLASS"
    }
  }
}
```

For the full list of available tools, see the ABAP ADT MCP server documentation for `@mcp-abap-adt/lib`.

---

## Additional Resources

- [MCP Header Matrix](MCP_HEADER_MATRIX.md) - Header configuration reference

---

**Last Updated:** 2026-04-08
**API Version:** 2.3

### Dialogue session binding and delivery

The first dialogue chat creates the handle and binds the effective destination to
its long session. Opening `/v1/session/events` first sends an empty tasks snapshot
and heartbeats, then attaches automatically when chat creates the handle. An ack
before handle creation returns 204 without creating one.

Both chat APIs reject destination changes with 409 `DIALOGUE_DESTINATION_FIXED`
and SAP principal/client changes with 409 `DIALOGUE_PRINCIPAL_FIXED`, using
`{ "error": { "type": "conflict", "code": "...", "message": "..." } }`.
The first credential refresh binds basic login plus client or token subject/user
plus client. New secrets for that principal retire old connections. Removing
credentials retains the binding but leaves background work without credentials
until that principal supplies them again.

Each events subscriber has its own last emitted message cursor. Pending messages
are emitted in outbox order even when persistence fails; persistence retries on
the serialized save path. Acknowledgements remove the prefix through a known ID.
Reconnects can pass `Last-Event-ID` to skip the rendered prefix.

### Session collection search toggle

`PATCH /v1/rag/collections/:id/enabled` with `{ "enabled": false }` and the current session header (`x-clh-session`, or the session cookie) changes only that user's session. `GET /v1/rag/collections` returns `enabled` (effective session state) and `defaultEnabled`. Use `{ "enabled": false, "scope": "default" }` to edit the default with the existing owner/admin permissions. Without a session, PATCH and GET retain default behavior.

Session overrides take precedence over collection defaults. They are deleted with session state. Long sessions persist overrides in their session record (SQLite/HANA/PG as configured) and restore them with the destination and history after restart; plain sessions keep overrides in memory, like their destination state.

Request retrieval uses enabled collections; `rag_collections` and `X-Rag-Collections` only narrow that set, including an explicit empty list. A request explicitly selecting its session `uploads` collection can use attached files for that request. Planner knowledge checks enablement on every search, so the next turn observes a toggle. Tool selection and built-in skills use separate tool/skill stores rather than these user collections. Executor history remains session memory. Explicit RAG tools are unchanged: `rag_list` can read a disabled collection when the caller has read access; add/correct/deprecate retain their existing permissions.


### Record enable/disable

A collection record is enabled unless its JSON metadata has `enabled: false`.
`GET /v1/rag/collections/:id/documents` and `GET /v1/rag/collections/:id/documents/:did`
include the derived boolean `enabled` on each record, including old records without a flag.
Disabled records remain listed, readable, downloadable, editable, and re-enableable.
The flag is global collection content; it is independent of session collection preferences.
A record is retrieved only when both the collection is enabled for that session and the record is enabled.

- `PATCH /v1/rag/collections/:id/documents/:did/enabled` with `{ "enabled": false }`
  changes one record and returns it with its enabled state. A missing record returns 404.
- `PATCH /v1/rag/collections/:id/documents/enabled` with
  `{ "enabled": false, "source": "manual.txt", "uploadId": "<upload id>" }`
  changes every chunk of exactly that upload, in one request, and returns `{ "updated": 12 }`.
  Omit `uploadId` only for legacy uploads without that field. Matching uses the same
  source + upload ID grouping as the document panel; another upload of the same name
  is unaffected. No matching chunks returns 404. This operation is sequential, not
  transactional: if a backend write fails, earlier chunks may already have changed;
  reload the state and retry the request.

Both endpoints require collection write permission (owner or admin under existing rules);
read-only access to a collection does not grant permission to change records, even with
an active session. `enabled` must be a JSON boolean; invalid input returns 400.
The UI displays enabled, disabled, or mixed source state; a mixed source's Enable all
control enables all chunks. Source state includes every page of records.

The dedicated metadata boolean round-trips through in-memory, vector, Qdrant, HANA,
and PostgreSQL stores using their existing metadata payloads. Existing tags are preserved,
including `deprecated` and `superseded`, which still exclude a record from retrieval.
The installed `IRagBackendWriter` API exposes no record metadata-only update method on
these backends, so toggles re-upsert the same text and ID through that API (vector
backends may re-embed). A failed write does not publish a new flag in the registry.

The shared collection query wrapper excludes disabled records for ordinary agent
collection retrieval (`getRagStores`), collection query/REST search (`getRagStore`),
and planner knowledge (`RagPlannerKnowledge` over `getRagStore`). It grows the candidate
window until it finds up to k eligible records or exhausts the backend results.
`rag_list` reports `enabled` for summaries and individual reads. `rag_correct` preserves
the disabled flag while updating text in place. No additional LLM tools are introduced.


### Agent configuration administration and session selection

`POST /v1/rag/collections` accepts `{ "id": "my-agents", "displayName": "My agents", "scope": "user", "copyFrom": "agents" }`.
`copyFrom` must equal the configured `LLM_AGENT_PROFILES_COLLECTION` identity.
The response is 201 with the new collection metadata and exact physical `id`.
The complete current global record set is validated and copied, including disabled
flags and prompt bodies. A failed copy never publishes a selectable partial set.
Copies are independent; later global edits and startup seeding do not update them.
Collection responses include `collectionKind` (`agents` or `knowledge`, with absent
legacy values treated as knowledge).

Agents record creation uses `POST /v1/rag/collections/:id/documents` with
`{ id, text, metadata }`. `id`, `metadata.canonicalKey` and `metadata.name` must
match exactly. An existing canonical id returns 409. Replace a record explicitly
with `PUT /v1/rag/collections/:id/documents/:did`; text may be empty. Metadata uses
the strict profile, worker-base or planner schema in the agent profiles design.
Unknown fields, malformed tool policies, reserved-name violations and mismatched
ids return 400. Individual record enablement and deletion use the existing record
routes. Generic chunked uploads, bulk imports, source toggles and collection
context toggles are rejected for agents collections. Disabled agent reads return
only id, enabled=false and reason, without body or description.

Global agents writes require `MCP_Admin`. User copies require their authenticated
owner; administrators cannot write another user's copy. Collection identity,
owner, scope and kind cannot be changed through metadata edits. All MCP/LLM
collection writes are denied for agents, including owners and administrators.
Copy creation and record edits are REST-only.

`POST /v1/session` accepts optional `agentsCollectionId` alongside `destination`.
Its response includes `{ session, ttlSeconds, destination, agentsCollectionId }`.
A new session defaults to the configured global identity. With an existing
session in `x-clh-session` or its cookie, the same route updates its selection;
omitting the field preserves the stored choice.

MCP `session_open({ destination?, agentsCollectionId?, session? })` returns
`{ session, ttlSeconds, destination, agentsCollectionId }`. Supply `session` to
configure an existing owned session; omit it to open one. Selection changes only
session configuration and grant no collection-write authority.

Execution inputs (`execute_step`, REST chat and messages) ignore
`agentsCollectionId`. To change the selection, call `session_open` or
`POST /v1/session` again for the same session.

Only the exact configured global agents identity or the caller's own agents
copy is eligible. Foreign copies are rejected even for admins. Missing, deleted,
pending-copy and wrong-kind ids are rejected without changing the existing
selection. REST returns 400; MCP returns an error result. There is no fallback
from an explicit invalid choice. The selection persists in the session record
and restores after restart; legacy sessions default to the configured global.
New profile reads and queued task starts use the current choice; running workers
keep their snapshots. Agents collections never participate in knowledge context.
