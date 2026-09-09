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

There are **two levels**, and the line between them is *effect*: does the tool
change anything in the system?

| Level | What it reaches | Tools your role allows |
|-------|-----------------|---------|
| **Reader** | everything that changes nothing — reading objects and source, search, and system diagnostics (structure, where-used, dumps, profiler data, `GetSqlQuery`) | up to **64** |
| **Developer** | Reader, plus the high-level and compact tools that change things — create / update / delete / activate, and running ABAP | up to **247** |

Of the 363 tools in total, the remaining **116** are the low-level API
(`*Low`) and are reachable by **nobody** — see the last note below.

**"Up to", because your role is not the only filter.** These are the counts your
role permits. The server then drops any tool that does not apply to the system
behind your destination — each tool declares an `available_in`, and an
on-premise destination and an ABAP Cloud one therefore expose different sets.
So `tools/list` returns *at most* these numbers, and the exact figure depends on
which destination you connect to.

The four XSUAA roles map onto those two, so nothing has to be reassigned:

| Role Collection      | Roles Included                                  | Level |
|----------------------|-------------------------------------------------|--------------|
| MCP Reader Access    | MCP_Reader                                      | Reader |
| MCP Analyst Access   | MCP_Reader + MCP_Analyst                        | Reader |
| MCP Developer Access | MCP_Reader + MCP_Analyst + MCP_Developer         | Developer |
| MCP Full Access      | MCP_Reader + MCP_Analyst + MCP_Developer + MCP_Full | Developer |

For new assignments, use **MCP Reader Access** or **MCP Developer Access**. The
other two are kept only so existing users keep working.

Two consequences worth knowing:

- **Running ABAP is a Developer action.** `RuntimeRunClass` and
  `RuntimeRunProgram` sit in the upstream `system` group with the diagnostics,
  but executing arbitrary code can change anything, so they are grouped with
  the write tools.
- **The low-level API (`*Low`) is granted to nobody.** 87 of its 116 tools
  create, update, delete or lock; nothing needs them today.

### The role decides what may RUN, not just what is offered

Your roles are checked twice, and the second check is the one that matters:

1. **Retrieval** — tool search only returns tools your roles cover, so the model is
   normally not even aware of the rest.
2. **Execution** — every tool call is authorized before it runs.

The second exists because the first cannot be complete: if you name a tool in your
prompt, the model will ask for it by name whether or not search offered it. Without
role checks at execution, a read-only caller could reach a create tool that way.

So a `MCP_Reader` asking for `CreateDomain` explicitly gets:

```
Tool "CreateDomain" was not executed: it belongs to the "high" group and your roles
grant only [readonly, search, system]. Asking for it by name does not grant it — a
different MCP role is required.
```

This is not a retry-able condition. Get the role assigned, or use a tool your role covers.

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

The transport is **stateless** (`sessionIdGenerator: undefined`, `srv/mcp-manager.ts`): no `Mcp-Session-Id` is returned and none is needed. Every request stands alone and carries its own `x-sap-*` headers.

### Step 2: List Available Tools

```bash
curl -X POST "$BASE_URL/mcp/stream/http" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: S4HANA_DEV" \
  -d '{"jsonrpc": "2.0", "id": "2", "method": "tools/list"}'
```

Which tools come back depends on two filters: your role (a Reader is allowed up
to 64, a Developer up to 247) and the destination's system type, which drops
tools that do not apply to it. The list is therefore never longer than your
role's count, and usually shorter.

### Step 3: Call a Tool

```bash
curl -X POST "$BASE_URL/mcp/stream/http" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-SAP-Destination: S4HANA_DEV" \
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
curl "$BASE_URL/odata/v4/mcp-proxy/Health()" -H "Authorization: Bearer $JWT"

# Probe destination connectivity
curl "$BASE_URL/odata/v4/mcp-proxy/ProbeDestination(destination='S4HANA_DEV')" \
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
