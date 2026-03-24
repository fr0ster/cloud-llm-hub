# Authentication on Custom Express Routes in SAP CAP

## Problem

Custom Express routes registered via `cds.on('bootstrap', app => { app.post('/custom', ...) })`
do **not** go through CAP's middleware chain automatically. This means:

- `cds.context` is not created (no async local storage context)
- `cds.context.user` is not populated
- JWT tokens are not validated
- Role checks (`user.is('Role')`) don't work

This affects all non-OData endpoints: `/mcp/stream/http`, `/v1/chat/completions`, etc.

**References:**
- [CAP Middlewares API](https://cap.cloud.sap/docs/node.js/cds-serve#cds-middlewares)
- [CAP Authentication](https://cap.cloud.sap/docs/node.js/authentication)
- [CAP Bootstrapping Servers](https://cap.cloud.sap/docs/node.js/cds-server)

## Solution

Reuse CAP's built-in middleware from `cds.middlewares.before`:

```typescript
cds.on('bootstrap', (app: Application) => {
  // cds.middlewares.before = [context, trace, auth, ctx_model]
  // - context: creates cds.context via async local storage
  // - auth: validates credentials (mocked Basic or XSUAA JWT) and sets cds.context.user
  const [context, , auth] = cds.middlewares.before;

  app.use('/mcp', context, auth, (req, res, next) => {
    if (!cds.context?.user || cds.context.user.is('anonymous')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.post('/mcp/stream/http', async (req, res) => {
    // cds.context.user is now available
    const user = cds.context.user;
    console.log(user.id);            // e.g. "alice" or "john@example.com"
    console.log(user.is('MCP_Full')); // true/false based on XSUAA scopes
  });
});
```

## How It Works

### Middleware Chain

CAP stores its middleware stack in `cds.middlewares.before` as an array of Express handlers:

| Index | Name      | Purpose                                          |
|-------|-----------|--------------------------------------------------|
| 0     | context   | Creates `cds.context` via `EventContext` + async local storage |
| 1     | trace     | Request tracing (correlation IDs)                |
| 2     | auth      | Validates credentials, creates `cds.User`, sets `cds.context.user` |
| 3     | ctx_model | Binds CDS model to context (OData only)          |

We apply `context` and `auth` — these two are sufficient for custom routes.

### Development (Mocked Auth)

Auth middleware reads Basic header, looks up user in `cds.env.requires.auth.users`
(from `package.json` cds config), and creates a `cds.User` with configured roles.

```json
{
  "cds": {
    "requires": {
      "auth": {
        "[development]": {
          "kind": "mocked",
          "users": {
            "alice": { "roles": ["MCP_Full", "MCP_Developer"] }
          }
        }
      }
    }
  }
}
```

### Production (XSUAA JWT)

Auth middleware uses `@sap/xssec` to:
1. Validate JWT signature against XSUAA public keys
2. Extract scopes (e.g., `xsappname.MCP_Full`) and map them to roles (`MCP_Full`)
3. Extract tenant ID for multi-tenancy
4. Create `cds.User` with proper `is()` method for role checks

**References:**
- [XSUAA JWT Token Flow](https://help.sap.com/docs/btp/sap-business-technology-platform/security)
- [@sap/xssec npm package](https://www.npmjs.com/package/@sap/xssec)

### Service-to-Service Authentication (Basic with client credentials)

For machine-to-machine communication, services can authenticate using XSUAA `client_id` and
`client_secret` via HTTP Basic auth. The `wrappedAuth` middleware in `server.ts` transparently
converts this to a Bearer JWT before passing to CAP auth:

1. Client sends `Authorization: Basic base64(clientId:clientSecret)`
2. Middleware detects XSUAA client ID (`sb-*` prefix)
3. Exchanges credentials for JWT via XSUAA `/oauth/token` endpoint (client_credentials grant)
4. Caches token in-memory (with 5 min margin before expiry)
5. Replaces `Authorization` header with `Bearer <jwt>` and passes to CAP auth

```bash
# Service-to-service call with Basic auth (clientid:secret)
curl -X POST https://<srv-url>/mcp/stream/http \
  -u "sb-cloud-llm-hub-xxx!t123:client-secret-here" \
  -H "Content-Type: application/json" \
  -H "x-sap-destination: S4HANA_DEV" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
```

**Important**: The JWT token from client_credentials grant contains scopes from
`authorities` in `xs-security.json`, not user role collections. The `MCP_Reader`
scope is granted by default.

#### CDS Service Path Conflict

Custom Express routes on `/mcp/stream/http` must not conflict with CDS service paths.
`McpProxyService` uses `@path: 'mcp-proxy'` (not `'mcp'`) to avoid intercepting
requests to `/mcp/stream/http` through CAP's per-service auth middleware.

## Previous Approach (Removed)

Previously, we manually parsed the Authorization header and created `cds.User` objects
in a custom middleware. This had critical limitations:

- **Bearer/JWT tokens were not validated** — the middleware only handled Basic auth
  and assumed app router would set `req.user` for JWT, which is incorrect
- **`cds.context` was not created** — downstream code using `cds.context.user` got undefined
- **Duplicated logic** — same auth code was copy-pasted for `/mcp` and `/v1` routes
- **No XSUAA scope-to-role mapping** — JWT scopes were not extracted into CAP roles

## Accessing User in Handlers

After applying CAP middleware, use `cds.context.user` (not `req.user`):

```typescript
// Correct: use cds.context
const user = cds.context?.user;
const isAdmin = user?.is('MCP_Full');
const userId = user?.id;

// Incorrect: req.user may not be populated for custom routes
// const user = req.user; // Don't use this
```

## Role Checking for MCP Tools

MCP tool exposition is resolved based on user roles in `mcp-manager.ts`:

```typescript
const user = cds.context?.user;
const allMcpRoles = ['MCP_Reader', 'MCP_Analyst', 'MCP_Developer', 'MCP_Full'];
const userRoles = allMcpRoles.filter(role => user?.is?.(role) ?? false);
const exposition = resolveExposition(userRoles);
```

Roles are defined in `xs-security.json` as scopes and role templates.
Users must be assigned appropriate Role Collections in BTP Cockpit.
