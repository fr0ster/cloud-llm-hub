
# Technical Specification: MCP Proxy over SSE and Stream-HTTP with BTP Authorization (XSUAA/CAP)

**Version:** 1.0  
**Date:** 2025-10-29  
**Owner:** Oleksii Kyslytsia (project *Programming*)

---

## 1. Purpose

Build a secure **proxy layer** for MCP (Model Command Protocol) that:
- operates over **SSE** (Server-Sent Events) and **stream-http**;
- performs **authentication and authorization via SAP BTP XSUAA** with roles/scopes declared in **xs-security.json** (CAP);
- **delegates** the actual MCP logic to the **`mcp-abap-adt`** submodule (existing implementation without authorization);
- maintains stable streaming connections (heartbeat, reconnection hints, backpressure, timeouts);
- provides **single entry points** for CLI clients (e.g., Cline) and service integrations.

> NB: For **SSE/stream-http** avoid routing through SAP App Router for the streaming endpoints (historical issues with `text/event-stream`). The App Router can remain in front of UI or regular REST routes.

---

## 2. Scope of Work

1. **CAP service “mcp-proxy”** inside `srv/`, validating XSUAA tokens and roles and forwarding streams to `mcp-abap-adt`:
  - `/mcp/stream/sse` — SSE proxy;
  - `/mcp/stream/http` — stream-http proxy (chunked/NDJSON/line-delimited).

2. **Authorization (XSUAA):**
  - declare scopes/roles in `xs-security.json`;
  - bind an xsuaa instance to the backend;
  - enforce scope checks inside proxy handlers.

3. **Dev/Prod modes:**
  - **Dev**: mock/basic (user *alice*) or service JWT; activated via `--profile dev`;
  - **Prod**: only XSUAA JWT (client-credentials or end-user).

4. **Integration with `mcp-abap-adt`:**
  - add as a Git submodule in `external/mcp-abap-adt`;
  - proxy connects to its local/remote endpoint.

5. **Defensive programming:**
  - timeouts, periodic heartbeat (`: ping`), event size limits, reconnection control;
  - ensure compression and buffering are disabled on streaming routes.

6. **Documentation and examples:**
  - `README` with curl/Cline usage examples;
  - `cline.json` samples for SSE/stream-http;
  - templates for `xs-security.json`, `package.json (cds)`, `default-env.json`.

---

## 3. Architecture

```mermaid
flowchart LR
  C[Cline/CLI\n(service token)] -- SSE/stream-http --> P[CAP srv: mcp-proxy\n(cds.auth/xssec)]
  P -- authZ check --> Auth[XSUAA\n(scopes/roles)]
  P -- forward (stream) --> M[mcp-abap-adt\n(submodule/service)]
  M -- responses (stream) --> P -- pipe --> C
```

### 3.1 Components
- **mcp-proxy (CAP)** — Express layer inside `cds.on('bootstrap', app => ...)` with custom routes and mandatory `cds.auth()` **or** a custom `authShim`.
- **authShim** — lightweight middleware that understands **Basic (dev)** and **Bearer (JWT/XSUAA)** and maps scopes to CAP roles.
- **mcp-abap-adt** — actual MCP implementation without authorization; accepts loopback connections from the proxy.
- **(Optional)** `nginx` sidecar if a DMZ/edge layer is required; for SSE ensure `proxy_buffering off`.

---

## 4. Protocols and Requirements

### 4.1 SSE
- Response: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- First line: `retry: 15000` (hint for client auto-reconnect).
- Heartbeat: comment lines `: ping` every 10–30 seconds.
- Disable compression/buffering for `/mcp/stream/sse`.

### 4.2 Stream-HTTP
- Formats: `application/x-ndjson` or `text/plain` (line-delimited JSON).
- Backpressure: monitor `res.write()`/flush behavior; apply managed timeouts.

### 4.3 Security
- Authorization is **mandatory**: return `401/403` if token/scopes are missing.
- Log only metadata (no secrets); mask sensitive headers.
- Limits: event size (for example 1 MB) and overall rate limit per user/IP.

---

## 5. Roles and Authorization

### 5.1 Scopes (xs-security.json)
```json
{
  "xsappname": "mcp-proxy",
  "scopes": [
    { "name": "$XSAPPNAME.MCP_Connect", "description": "Connect to MCP streams" },
    { "name": "$XSAPPNAME.MCP_Read",    "description": "Read stream data" },
    { "name": "$XSAPPNAME.MCP_Admin",   "description": "Admin operations" }
  ],
  "roles": [
    { "name": "MCP_Connector", "description": "Connect & read", "scope-references": [ "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]},
    { "name": "MCP_Admin",     "description": "Admin",          "scope-references": [ "$XSAPPNAME.MCP_Admin", "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]}
  ]
}
```

### 5.2 Code Enforcement
```js
const need = (u, scopes) => scopes.every(s => u.is(s))

// example:
if (!need(req.user, ['MCP_Connect'])) return res.sendStatus(403)
```

### 5.3 Dev Profile (mock)
```json
{
  "cds": {
    "profiles": {
      "dev": {
        "requires": {
          "auth": {
            "kind": "mock",
            "users": {
              "alice": { "roles": ["MCP_Connector", "MCP_Admin"] },
              "bob":   { "roles": ["MCP_Connector"] }
            }
          }
        }
      }
    }
  }
}
```

---

## 6. Proxy Endpoints

### 6.1 SSE: `GET /mcp/stream/sse`
**Request:**  
- Headers:  
  - `Authorization: Bearer <JWT>` (Prod) **or** `Authorization: Basic <base64>` (Dev)
  - `Accept: text/event-stream`  
- Parameters: `?target=local|url` (optional) — where to forward MCP traffic.

**Response:**  
- `200` + stream with `event:`/`data:` pairs;  
- `401/403` if authorization fails;  
- `5xx` on upstream failures.

**Flow:**  
1. `authShim` sets `req.user` (`cds.User`) with roles.  
2. Verify `MCP_Connect`.  
3. Apply streaming headers, send `retry`, and start heartbeats.  
4. Open upstream stream to `mcp-abap-adt` (local/URL).  
5. Forward events **without buffering/compression**.  
6. On disconnect, close both sides and allow the client to reconnect.  

### 6.2 Stream-HTTP: `POST /mcp/stream/http`
**Request:**  
- Headers: `Authorization: ...`, `Content-Type: application/x-ndjson`  
- Body: stream of MCP commands/requests.

**Response:**  
- `200` + stream of responses (NDJSON) or `text/plain` line-delimited.  

---

## 7. Connecting `mcp-abap-adt`

- Add the git submodule:  
  ```bash
  git submodule add <repo_url> external/mcp-abap-adt
  ```
- Run it as an **internal service** (local port such as `127.0.0.1:7070`).  
- Configure in `package.json`:
  ```json
  {
    "cds": {
      "requires": {
        "mcpTarget": {
          "kind": "rest",
          "credentials": { "url": "http://127.0.0.1:7070" }
        }
      }
    }
  }
  ```

---

## 8. Implementation Details

### 8.1 Auth shim (universal)
```js
const xsenv = require('@sap/xsenv')
const xssec = require('@sap/xssec')
let xsuaa
try { xsuaa = xsenv.getServices({ uaa: { tag: 'xsuaa' } }).uaa } catch {}

async function authShim(req, res, next) {
  const hdr = req.headers.authorization || ''
  try {
    if (hdr.startsWith('Basic ')) {
      const [user] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':')
      const roles = user === 'alice' ? ['MCP_Connector', 'MCP_Admin'] : ['MCP_Connector']
      req.user = new cds.User({ id: user || 'anonymous', roles })
      return next()
    }
    if (hdr.startsWith('Bearer ')) {
      if (!xsuaa) throw new Error('No XSUAA binding')
      await new Promise((resolve, reject) =>
        xssec.createSecurityContext(hdr.slice(7), xsuaa, (e, sc) => e ? reject(e) : resolve(req._sc = sc)))
      const xsapp = xsuaa.xsappname
      const scopes = new Set(req._sc.getScopes() || [])
      const roles = []
      if (scopes.has(`${xsapp}.MCP_Connect`)) roles.push('MCP_Connector')
      if (scopes.has(`${xsapp}.MCP_Admin`)) roles.push('MCP_Admin')
      req.user = new cds.User({ id: req._sc.getLogonName(), roles })
      return next()
    }
    return res.status(401).send('Unauthorized')
  } catch (e) {
    return res.status(401).send('Unauthorized: ' + e.message)
  }
}
```

### 8.2 SSE proxy (outline)
```js
cds.on('bootstrap', (app) => {
  app.get('/mcp/stream/sse', authShim, async (req, res) => {
    const u = req.user
    if (!u || !u.is('MCP_Connector')) return res.sendStatus(403)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 15000\n\n')
    const hb = setInterval(() => res.write(': ping\n\n'), 15000)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/sse', { headers: { Accept: 'text/event-stream' } })
    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end',  () => { clearInterval(hb); res.end() })
    req.on('close', () => { upstream.body?.destroy?.(); clearInterval(hb); res.end() })
  })
})
```

### 8.3 Stream-HTTP proxy (outline)
```js
cds.on('bootstrap', (app) => {
  app.post('/mcp/stream/http', authShim, async (req, res) => {
    const u = req.user
    if (!u || !u.is('MCP_Connector')) return res.sendStatus(403)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/stream', { method: 'POST', body: req })
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/x-ndjson')
    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end', () => res.end())
    req.on('close', () => upstream.body?.destroy?.())
  })
})
```

---

## 9. Environment Configuration

### 9.1 `package.json`
```json
{
  "name": "mcp-proxy",
  "dependencies": {
    "@sap/cds": "^7",
    "@sap/xssec": "^3",
    "@sap/xsenv": "^3",
    "node-fetch": "^3"
  },
  "cds": {
    "requires": {
      "auth": { "kind": "xsuaa" },
      "mcpTarget": {
        "kind": "rest",
        "credentials": { "url": "http://127.0.0.1:7070" }
      }
    },
    "profiles": {
      "dev": {
        "requires": {
          "auth": {
            "kind": "mock",
            "users": {
              "alice": { "roles": ["MCP_Connector","MCP_Admin"] },
              "bob":   { "roles": ["MCP_Connector"] }
            }
          }
        }
      }
    }
  }
}
```

### 9.2 `xs-security.json` (skeleton)
(see §5.1)

### 9.3 `default-env.json` (local template)
```json
{
  "VCAP_SERVICES": {
    "xsuaa": [
      {
        "name": "mcp-xsuaa",
        "label": "xsuaa",
        "credentials": {
          "xsappname": "mcp-proxy",
          "url": "https://<xsuaa-domain>",
          "clientid": "<id>",
          "clientsecret": "<secret>"
        }
      }
    ]
  }
}
```

---

## 10. Run Modes

### Dev
```bash
cds watch --profile dev
# Cline:
# Authorization: Basic YWxpY2U6  (alice:)
```

### Prod
- Bind xsuaa to the service (CF bind).  
- Clients use `Authorization: Bearer <JWT>` (service token or on-behalf-of).  
- Run the MCP target (`mcp-abap-adt`) as a separate process/container.

---

## 11. Cline Examples

**SSE (`cline.json`):**
```json
{
  "type": "sse",
  "endpoint": "https://<srv-domain>/mcp/stream/sse",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}"
  },
  "timeoutMs": 0
}
```

**stream-http (`cline.json`):**
```json
{
  "type": "stream-http",
  "endpoint": "https://<srv-domain>/mcp/stream/http",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}",
    "Content-Type": "application/x-ndjson"
  }
}
```

---

## 12. Non-Functional Requirements

- **Stream reliability:** heartbeat, reconnection instructions, timeouts 60–120 seconds, no compression.
- **Performance:** ≥ 500 events/second, p95 latency ≤ 200 ms against a local target.
- **Security:** event size limits, rate limiting, no sensitive logging, JWT validation.
- **Observability:** structured logs (JSON), request correlation, metrics (ops/sec, bytes, open streams).

---

## 13. Acceptance Criteria

1. User with role **MCP_Connector** can establish SSE/stream-http connections and receives events from `mcp-abap-adt`.
2. User **without the role** receives `403`.
3. Dev mode: *alice* via Basic gets access; *bob* only reads; anonymous user gets `401`.
4. Streams are not buffered or compressed; heartbeat and reconnection flows work.
5. Load of 500 events/second does not produce memory leaks or crashes.
6. Documentation with Cline/`curl` examples exists.

---

## 14. Open Questions / Risks

- Do we need **on-behalf-of** support (end-user) in addition to service tokens?  
- Should we add **resource-level RBAC** in MCP (namespace/project level)?  
- Interaction with the App Router for non-stream routes (UI) remains out of scope for this specification.

---

## 15. Next Steps

1. Add the `mcp-abap-adt` submodule and expose a test endpoint.  
2. Implement `authShim` and both stream proxies.  
3. Provide `xs-security.json` and the dev mock profile.  
4. Write smoke tests (`curl`/Cline).  
5. Run load tests and inspect metrics/logs.
