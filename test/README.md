# Cloud LLM Hub Tests

## ABAP Connection Test

Test ABAP connectivity through cloud-llm-hub MCP proxy by calling GetTable for T000.

This test validates:

- cloud-llm-hub `/mcp/stream/http` endpoint works
- JWT authentication with UAA credentials flows correctly
- GetTable tool successfully reads from ABAP
- Auto-refresh triggers when JWT token expires

### Prerequisites

1. **Cloud-llm-hub server running**:

   ```bash
   npx cds serve --with-mocks --in-memory
   # or
   npx cds watch
   ```

   Server should be listening on `http://localhost:4004`

2. **Valid SAP credentials in `.env` file** (project root):
   ```bash
   # .env file should contain:
   SAP_URL=https://your-system.abap.us10.hana.ondemand.com
   SAP_JWT_TOKEN=eyJ0eXAiOiJKV1QiLCJ...
   SAP_REFRESH_TOKEN=your-refresh-token
   SAP_UAA_URL=https://your-subdomain.authentication.us10.hana.ondemand.com
   SAP_UAA_CLIENT_ID=your-client-id
   SAP_UAA_CLIENT_SECRET=your-client-secret
   ```

### Running the Test

```bash
# Simply run (will use credentials from .env)
node test/abap-connection.test.js

# Override with environment variables (optional)
SAP_URL="https://..." node test/abap-connection.test.js
```

### Test Coverage

The test validates cloud-llm-hub proxy functionality:

1. **MCP Initialize** - Verify MCP protocol handshake through cloud-llm-hub
2. **GetTable T000** - Verify ABAP connection works, reads table data, auto-refresh triggers if needed

### Environment Variables

The test reads credentials from `.env` file in project root.

**Required in `.env`:**

- `SAP_URL` - ABAP system URL

**Authentication (JWT):**

- `SAP_JWT_TOKEN` - JWT access token
- `SAP_REFRESH_TOKEN` - OAuth2 refresh token (for auto-refresh)
- `SAP_UAA_URL` - UAA server URL
- `SAP_UAA_CLIENT_ID` - UAA client ID
- `SAP_UAA_CLIENT_SECRET` - UAA client secret

**Optional:**

- `SAP_CLIENT` - SAP client number (e.g., "100")
- `TEST_HOST` - cloud-llm-hub host (default: localhost)
- `TEST_PORT` - cloud-llm-hub port (default: 4004)
- `AUTH_HEADER` - Basic auth for cloud-llm-hub (default: Basic YWxpOmFsaQ== for dev)

You can override any value using environment variables:

```bash
SAP_URL="https://other-system..." node test/abap-connection.test.js
```

### Getting Fresh Tokens

If refresh token expired, authenticate via standalone mcp-abap-adt to update `.env`:

```bash
cd submodules/mcp-abap-adt
npm start
# Browser will open for OAuth2 authentication
# Tokens will be saved to TRIAL.env (or similar)

# Copy updated tokens to cloud-llm-hub/.env
cp TRIAL.env ../../.env
# or manually update ../../.env with new tokens
```

### Example Output

```
============================================================
cloud-llm-hub ABAP Connection Test - GetTable T000
============================================================

ℹ Loaded credentials from /home/user/cloud-llm-hub/.env

ℹ Configuration {
  "server": "localhost:4004/mcp/stream/http",
  "sapUrl": "https://xxx.abap.us10.hana.ondemand.com",
  "hasJwtToken": true,
  "jwtTokenLength": 1234,
  "hasRefreshToken": true,
  "hasUaaCredentials": true,
  "client": "(not specified)"
}

ℹ Test 1: Initialize MCP session
✓ Initialize successful {
  "protocolVersion": "2024-11-05",
  "serverName": "mcp-abap-adt-server",
  "serverVersion": "1.1.17"
}

ℹ Test 2: GetTable for T000 (tests ABAP connection + auto-refresh)
✓ GetTable successful {
  "contentType": "text",
  "hasText": true,
  "textLength": 1523,
  "textPreview": "Table T000 - Clients...\n..."
}

============================================================
✓ All 2 tests passed!
============================================================
```

### Troubleshooting

**Error: "401"**

- JWT token expired and auto-refresh failed
- Run mcp-abap-adt standalone to get fresh tokens
- Check cloud-llm-hub logs for refresh errors

**Error: "Refresh token has expired"**

- Re-authenticate via mcp-abap-adt standalone (browser OAuth flow)
- Copy new tokens to .env file

**Error: "Connection refused"**

- Make sure cloud-llm-hub server is running: `npx cds serve`
- Check port (default 4004): `lsof -i :4004`

**Error: "SAP_URL not set"**

- Make sure .env file exists in project root
- Check .env file has SAP_URL variable
