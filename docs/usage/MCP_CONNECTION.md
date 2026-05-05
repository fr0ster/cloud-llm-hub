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

## Local Proxy (`npm run proxy`)

For local development against a deployed `cloud-llm-hub-srv`, the repo ships a wrapper around `mcp-abap-adt-proxy` that handles CF authentication, app-route resolution, and service-key refresh in one command.

### Quick start

```bash
npm install                        # ships @mcp-abap-adt/proxy as a devDependency
cf login --sso
cf target -o <your-org> -s <space>
npm run proxy S4HANA_DEV           # destination is positional; defaults to server-side default
```

The proxy listens on `http://localhost:3001/mcp/stream/http` and forwards every request to the live `cloud-llm-hub-srv` route in the targeted CF subaccount. On first launch it triggers an interactive OAuth flow in your default browser; subsequent calls reuse the cached session until it expires (≈24h).

### What the script does on each launch

1. **Validates CF auth.** Fails fast with a clear error if you're not logged in, no org/space targeted, or the OAuth token has expired (`cf target` cached values mask this — the script probes with `cf orgs`).
2. **Resolves the app route** via `cf app cloud-llm-hub-srv`. If the app isn't deployed in the targeted space (wrong subaccount), it errors out instead of producing a proxy bound to an empty URL.
3. **Refreshes the service key** by pulling `cf service-key cloud-llm-hub-auth mcp` and writing it to `~/.config/mcp-abap-adt/service-keys/mcp.json`. If the cached key was for a different subaccount, the corresponding session file is wiped so the next request triggers a fresh auth flow against the right tenant. Without this step, switching CF target between subaccounts produces `WrongAudienceError` 500s on every request.

Confirmation lines look like:

```
✓ CF target:  <ORG> / <SPACE>
✓ App route:  <subaccount>-cloud-llm-hub-srv.cfapps.<landscape>
✓ Service key: cloud-llm-hub-auth/mcp (<identityzone>)
```

### Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `APP` | `cloud-llm-hub-srv` | CF app to proxy to |
| `BTP` | `mcp` | Cache filename under `~/.config/mcp-abap-adt/service-keys/` |
| `CONSUMER` | `cloud-llm-hub-auth` | xsuaa instance for the OAuth flow. Must support `authorization_code` grant + have `redirect-uris: ["http://localhost:*/**"]`. The `*-consumer` xsuaa instances (analyst/developer) are `client_credentials`-only and won't drive a browser flow. |
| `CONSUMER_KEY` | `mcp` | Service-key on `$CONSUMER` |
| `PORT` | `3001` | Local HTTP port |

Override only when running against a non-standard topology (e.g. a fork with different module names).

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ERROR: not logged into Cloud Foundry` | No CF token | `cf login --sso` |
| `ERROR: CF auth token expired or invalid` | Stale token | `cf login --sso` to refresh |
| `ERROR: app 'cloud-llm-hub-srv' not found in '<org>' / '<space>'` | Wrong CF target | `cf target -o … -s …` |
| Proxy returns 502 with `WrongAudienceError` | Cached service-key from a previous subaccount | Re-run `npm run proxy` — the script auto-refreshes the key (since v6.5.3). For older versions, manually delete `~/.config/mcp-abap-adt/service-keys/mcp.json`. |
| `Authorization Request Error` in the browser | `$CONSUMER` xsuaa rejects the redirect URI (e.g. you switched it to a `*-consumer` instance) | Reset `CONSUMER` to default (`cloud-llm-hub-auth`) — that's the only xsuaa configured for the browser OAuth flow. |

## Smoke Testing

```bash
bash test/smoke/test-cloud-endpoints.sh
```

See `.env.example` for token setup instructions.

## Related Documentation

- [OpenAI-Compatible Agent](OPENAI_AGENT.md) - Connect via OpenAI API
- [CAP Express Auth](../development/CAP_EXPRESS_AUTH.md) - How auth works on custom routes
- [MCP Proxy Usage](MCP_PROXY_USAGE.md) - Legacy MCP proxy documentation
