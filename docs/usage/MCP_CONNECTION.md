# MCP Stream-HTTP Connection

Cloud LLM Hub provides an MCP (Model Context Protocol) proxy at `/mcp/stream/http`
that connects AI assistants to SAP ABAP systems via BTP Destinations.

## Endpoint

| Method | Path               | Description                     |
|--------|--------------------|---------------------------------|
| POST   | `/mcp/stream/http` | MCP Stream-HTTP (JSON-RPC 2.0)  |

**Protocol:** [MCP Specification](https://modelcontextprotocol.io/specification)
**Transport:** StreamableHTTP (request-response with SSE streaming)

## Authentication

Requires an XSUAA JWT token with MCP role scopes.

```bash
# Obtain token (see docs/usage/OPENAI_AGENT.md for details)
npm run get:key && npm run get:token
```

Required roles (assign via BTP Cockpit -> Security -> Role Collections):

| Role Collection      | Roles Included                                  | Access Level |
|----------------------|-------------------------------------------------|--------------|
| MCP Reader Access    | MCP_Reader                                      | Read-only    |
| MCP Analyst Access   | MCP_Reader + MCP_Analyst                        | Read + analyze |
| MCP Developer Access | MCP_Reader + MCP_Analyst + MCP_Developer         | Read + write (compact) |
| MCP Full Access      | MCP_Reader + MCP_Analyst + MCP_Developer + MCP_Full | Full access  |

**References:**
- [SAP BTP Role Collections](https://help.sap.com/docs/btp/sap-business-technology-platform/role-collections-and-roles)
- [xs-security.json Configuration](https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax)

## Required Headers

| Header              | Required | Description                              |
|---------------------|----------|------------------------------------------|
| `Authorization`     | Yes      | `Bearer <XSUAA_JWT_TOKEN>`              |
| `Content-Type`      | Yes      | `application/json`                       |
| `Accept`            | Yes      | `application/json, text/event-stream`    |
| `X-SAP-Destination` | Yes      | BTP Destination name (e.g. `S4HANA_DEV`) |
| `Mcp-Session-Id`    | After init | Session ID returned by initialize      |

## Connection Flow

### Step 1: Initialize

```bash
curl -X POST "$BASE_URL/mcp/stream/http" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: S4HANA_DEV" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    }
  }'
```

Response includes `Mcp-Session-Id` header — use it in subsequent requests.

### Step 2: List Available Tools

```bash
curl -X POST "$BASE_URL/mcp/stream/http" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: S4HANA_DEV" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "id": "2", "method": "tools/list"}'
```

Available tools depend on the user's MCP roles (Reader/Analyst/Developer/Full).

### Step 3: Call a Tool

```bash
curl -X POST "$BASE_URL/mcp/stream/http" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: S4HANA_DEV" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": "3",
    "method": "tools/call",
    "params": {
      "name": "search_objects",
      "arguments": {
        "query": "ZCL_*",
        "type": "CLAS"
      }
    }
  }'
```

## Connecting AI Assistants

### Cline (VS Code)

Use the connection setup tool:

```bash
npm run update:cline
```

Or configure manually in `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "url": "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
      "headers": {
        "Authorization": "Bearer <XSUAA_JWT_TOKEN>",
        "X-SAP-Destination": "S4HANA_DEV"
      }
    }
  }
}
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sap-abap": {
      "url": "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
      "headers": {
        "Authorization": "Bearer <XSUAA_JWT_TOKEN>",
        "X-SAP-Destination": "S4HANA_DEV"
      }
    }
  }
}
```

### Custom Client (TypeScript)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http'),
  {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${XSUAA_JWT_TOKEN}`,
        'X-SAP-Destination': 'S4HANA_DEV',
      },
    },
  }
);

const client = new Client({ name: 'my-client', version: '1.0.0' }, {});
await client.connect(transport);

const tools = await client.listTools();
console.log(`Available tools: ${tools.tools.length}`);

const result = await client.callTool({
  name: 'search_objects',
  arguments: { query: 'ZCL_*', type: 'CLAS' },
});
console.log(result);
```

**Reference:** [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

## OData Health & Diagnostics

In addition to MCP, CAP OData services provide health checks:

```bash
# Auth check
curl "$BASE_URL/odata/v4/auth/CheckAuth()" -H "Authorization: Bearer $JWT"

# MCP health
curl "$BASE_URL/odata/v4/mcp/Health()" -H "Authorization: Bearer $JWT"

# Probe destination connectivity
curl "$BASE_URL/odata/v4/mcp/ProbeDestination(destination='S4HANA_DEV')" \
  -H "Authorization: Bearer $JWT"

# Agent health
curl "$BASE_URL/odata/v4/agent/Health()" -H "Authorization: Bearer $JWT"
```

## Smoke Testing

```bash
bash test/smoke/test-cloud-endpoints.sh
```

See `.env.example` for token setup instructions.

## Related Documentation

- [OpenAI-Compatible Agent](OPENAI_AGENT.md) - Connect via OpenAI API
- [CAP Express Auth](../development/CAP_EXPRESS_AUTH.md) - How auth works on custom routes
- [MCP Proxy Usage](MCP_PROXY_USAGE.md) - Legacy MCP proxy documentation
