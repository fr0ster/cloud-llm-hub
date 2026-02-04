# HTTP Request Files for Testing

This directory contains HTTP request files for testing Cloud LLM Hub endpoints using the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension for VS Code.

## Directory Structure

```
test/requests/
├── templates/          # Template files (saved in Git)
│   ├── local-template.http
│   └── cloud-template.http
├── scratch/            # Temporary test files (NOT saved in Git)
│   └── (your test files here)
├── local.http          # Ready-to-use local requests
├── cloud.http          # Ready-to-use cloud requests
└── README.md           # This file
```

## Files

### Templates (Saved in Git)

- **`templates/local-template.http`** - Template for local development
- **`templates/cloud-template.http`** - Template for cloud (BTP) deployment

### Ready-to-Use Files

- **`local.http`** - Requests for local development (`http://localhost:4004`)
- **`cloud.http`** - Requests for cloud (BTP) deployment

### Scratch Directory (NOT Saved in Git)

- **`scratch/`** - Copy templates here for testing. Files in this directory are ignored by Git.

## Setup

### VS Code REST Client Extension

1. Install the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension in VS Code
2. Open one of the `.http` files
3. Click "Send Request" above each request, or use `Ctrl+Alt+R` (Windows/Linux) / `Cmd+Alt+R` (Mac)

### Variables

Both files use variables at the top that you can customize:

**Local (`local.http`):**
- `@baseUrl` - Default: `http://localhost:4004`
- `@authBasic` - Basic auth for alice (default user)
- `@destination` - SAP destination name
- `@message` - Test message for agent chat

**Cloud (`cloud.http`):**
- `@baseUrl` - Your BTP app URL
- `@authBearer` - JWT token (get from XSUAA)
- `@appName` - Your app name
- `@region` - BTP region (e.g., `eu10`, `us10`)
- `@destination` - SAP destination name
- `@jwtToken` - XSUAA JWT token

## Usage

### Option 1: Use Ready-to-Use Files

**Local Testing:**

1. Start your local CAP server:
   ```bash
   cds watch --profile development
   ```

2. Open `test/requests/local.http` in VS Code

3. Click "Send Request" on any request

**Cloud Testing:**

1. Deploy your app to BTP:
   ```bash
   cf deploy gen/mta_archives/cloud-llm-hub_*.mtar
   ```

2. Get your app URL:
   ```bash
   cf apps | grep cloud-llm-hub-srv
   ```

3. Get XSUAA token (see "Get XSUAA Token" requests in `cloud.http`)

4. Update variables in `cloud.http`:
   - `@appName` - Your app name
   - `@region` - Your region
   - `@jwtToken` - Token from step 3

5. Open `test/requests/cloud.http` in VS Code

6. Click "Send Request" on any request

### Option 2: Use Templates (Recommended for Testing)

**For temporary testing without saving to Git:**

1. Copy a template to scratch directory:
   ```bash
   cp test/requests/templates/local-template.http test/requests/scratch/my-test.http
   ```

2. Modify variables and requests in `scratch/my-test.http` as needed

3. Test your requests using VS Code REST Client

4. Files in `scratch/` are ignored by Git - they won't be committed

**Benefits:**
- Templates remain unchanged (saved in Git)
- Your test files won't clutter Git history
- Easy to create multiple test variations

## Available Endpoints

### MCP Proxy Service (OData V4)

- `GET /odata/v4/mcp/Health()` - Health check
- `GET /odata/v4/mcp/ProbeDestination?destination=NAME` - Test destination

### Agent Service (OData V4)

- `GET /odata/v4/agent/Health()` - Agent health check
- `POST /odata/v4/agent/Chat` - Send message to LLM
- `GET /odata/v4/agent/GetHistory()` - Get conversation history
- `POST /odata/v4/agent/ClearHistory` - Clear history

### MCP Streaming (Express)

- `GET /mcp/stream/sse` - Server-Sent Events transport
- `POST /mcp/stream/http` - NDJSON streaming transport

### Auth Service (OData V4)

- `GET /odata/v4/auth/CheckAuth()` - Check authentication
- `GET /odata/v4/auth/CheckRoles?required=["MCP_Connector"]` - Check roles

## Authentication

### Local Development

Uses Basic Authentication with mocked users from `package.json`:
- **alice** - Has `MCP_Connector` and `MCP_Admin` roles
- **bob** - Has `MCP_Connector` role only

Basic auth header: `Basic YWxpY2U6` (alice) or `Basic Ym9iOg==` (bob)

### Cloud (BTP)

Uses Bearer token authentication with XSUAA:
1. Get token from XSUAA (see "Get XSUAA Token" requests)
2. Use token in `Authorization: Bearer <token>` header

## Examples

### Test MCP Health (Local)

```http
GET http://localhost:4004/odata/v4/mcp/Health()
Authorization: Basic YWxpY2U6
Accept: application/json
```

### Test Agent Chat (Cloud)

```http
POST https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com/odata/v4/agent/Chat
Authorization: Bearer <your-jwt-token>
Content-Type: application/json

{
  "message": "Hello! Can you introduce yourself?"
}
```

### Test MCP Stream HTTP (Local)

```http
POST http://localhost:4004/mcp/stream/http
Authorization: Basic YWxpY2U6
Content-Type: application/json
X-SAP-Destination: SAP_DEV_DEST
X-MCP-Timeout: 60000

{"jsonrpc":"2.0","id":"1","method":"tools/list"}
```

## Troubleshooting

### 401 Unauthorized

- **Local**: Check if `cds watch` is running and user exists in `package.json`
- **Cloud**: Verify JWT token is valid and not expired

### 403 Forbidden

- Check if user/token has required scope: `MCP_Connector`
- For admin operations, check for `MCP_Admin` scope

### 404 Not Found

- Verify endpoint path is correct (OData functions need `()`)
- Check if service is deployed and running

### Connection Refused (Local)

- Ensure `cds watch` is running on port 4004
- Check if port is not blocked by firewall

### Destination Not Found (Cloud)

- Verify destination is configured in BTP Destination service
- Check destination name matches exactly (case-sensitive)

## Related Documentation

- [API Reference](../../docs/architecture/API_REFERENCE.md)
- [CAP Endpoints](../../docs/architecture/CAP_ENDPOINTS.md)
- [Hybrid Debugging Setup](../../docs/development/HYBRID_DEBUG_SETUP.md)
- [Testing Guide](../../docs/contributors/TESTING.md)

