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
- `503 Service Unavailable` - SmartAgent is initializing (MCP connect + tool vectorization)

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

**Description:** MCP Streamable HTTP. **One JSON-RPC message per HTTP request** — `srv/server.ts` reads the whole body and runs a single `JSON.parse`, so a body holding several objects is a parse error. The transport is stateless (`sessionIdGenerator: undefined`), so each request stands alone. Responses stream back as SSE when the tool emits progress.

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

**Responsible person and master system:** ABAP objects are created with a responsible person and a master system, set per request and seen only by that request's run.

- `X-SAP-Responsible` (optional) - SAP user ID named as responsible; defaults to `X-SAP-Login`. Uppercased.
- `X-SAP-Master-System` (optional) - master system (system ID) of created objects. Uppercased.

`/v1/chat/completions`, `/v1/messages` and `execute_step` read both headers and scope the values to the run. On an ABAP Cloud destination a missing responsible person or master system is filled from the system itself when a tool runs (`@mcp-abap-adt/lib` 10.2.0); on-premise a missing one stays unset.

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

**Description:** Direct connection to SAP system without Destination service.

**Use Cases:**

- Development
- Testing
- Local deployments

**Example:**

```bash
curl -H "Authorization: Basic YWxpY2U6" \
     -H "X-SAP-URL: https://sap.example.com" \
     -H "X-SAP-Client: 200" \
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

### Sessions

The service issues the session in an `HttpOnly` cookie, `clh_session`, on the
first `/v1` response that has none, and keys every session by that value
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
