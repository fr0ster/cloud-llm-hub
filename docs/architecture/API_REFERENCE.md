# API Reference

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

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

**Endpoint:** `GET /odata/v4/mcp/Health()`

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
     http://localhost:4004/odata/v4/mcp/Health\(\)
```

---

### 2. Probe Destination

**Endpoint:** `GET /odata/v4/mcp/ProbeDestination?destination={name}`

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
     "http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=SAP_DEV_DEST"
```

---

### 3. SSE Stream (disabled)

**Endpoint:** `GET /mcp/stream/sse`

**Description:** SSE transport is currently disabled. Requests return `404`.

---

### 4. Stream-HTTP

**Endpoint:** `POST /mcp/stream/http`

**Description:** Bidirectional NDJSON streaming for MCP communication.

**Authentication:** Required

**Headers:**

- `Authorization` (required) - Basic or Bearer token
- `Content-Type: application/x-ndjson` (required)
- `Mcp-Session-Id` (optional) - Session ID for follow-up requests
- `X-SAP-Destination` (optional) - Destination name for destination mode
- `X-SAP-URL` (optional) - Direct SAP URL for direct mode
- `X-SAP-Client` (optional) - SAP client number
- `X-SAP-Auth-Type` (optional) - `jwt` or `basic`
- `X-SAP-Auth-Token` (optional) - SAP JWT token (for direct mode)

**Request Body:**

- Content-Type: `application/x-ndjson`
- Format: Newline-delimited JSON
- Each line is a complete JSON-RPC 2.0 request

**Response:**

- Content-Type: `application/x-ndjson`
- Format: Newline-delimited JSON
- Each line is a complete JSON-RPC 2.0 response

**Status Codes:**

- `200 OK` - Stream started successfully
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - Insufficient permissions
- `502 Bad Gateway` - MCP server connection failed

**Example:**

```bash
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     -H "X-SAP-Destination: SAP_DEV_DEST" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"GetObjectList","arguments":{"objectType":"CLAS"}}}
EOF
```

**Response Format:**

```
{"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
{"jsonrpc":"2.0","id":2,"result":{"objects":[...]}}
```

**Session Management:**

- First request: Omit `Mcp-Session-Id` header
- Response includes: `Mcp-Session-Id: <session-id>` header
- Subsequent requests: Include `Mcp-Session-Id: <session-id>` header
- To reset: Omit `Mcp-Session-Id` header or restart proxy

---

## SAP Connection Headers

### Destination Mode (Recommended)

**Header:** `X-SAP-Destination: <destination-name>`

**Description:** Use SAP BTP Destination service for connection configuration.

**Benefits:**

- Centralized configuration
- Automatic authentication handling
- Cloud Connector support
- No credentials in requests

**Example:**

```bash
curl -H "Authorization: Bearer <token>" \
     -H "X-SAP-Destination: SAP_PROD_DEST" \
     https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http
```

### Direct Mode

**Headers:**

- `X-SAP-URL: <sap-url>` (required)
- `X-SAP-Client: <client-number>` (required)
- `X-SAP-Auth-Type: jwt|basic` (required)
- `X-SAP-Auth-Token: <token>` (for JWT)
- OR `X-SAP-Username: <username>` and `X-SAP-Password: <password>` (for Basic)

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
     -H "X-SAP-Auth-Token: <sap-jwt-token>" \
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

Currently, no rate limiting is enforced. Consider implementing:

- **Per-user limits:** 1000 requests/minute
- **Per-IP limits:** 100 requests/minute
- **Connection limits:** 10 concurrent connections per user

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

For the full list of available tools, see the ABAP ADT MCP server documentation for `@mcp-abap-adt/core`.

---

## Additional Resources

- [MCP Proxy Usage Guide](MCP_PROXY_USAGE.md) - Detailed usage examples
- [MCP Header Matrix](MCP_HEADER_MATRIX.md) - Header configuration reference
- [MCP Config Update How-To](MCP_CONFIG_UPDATE_HOWTO.md) - Configuration automation

---

**Last Updated:** 2025-11-05  
**API Version:** 1.0
