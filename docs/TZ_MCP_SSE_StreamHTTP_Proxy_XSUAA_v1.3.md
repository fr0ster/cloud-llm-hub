
# Technical Specification: MCP Proxy over SSE and Stream-HTTP with BTP Authorization (XSUAA/CAP)

**Version:** 1.3  
**Date:** 2025-10-29  
**Owner:** Oleksii Kyslytsia (project *Programming*)

---

## 1. Purpose

Implement a secure **CAP proxy** for MCP (Model Command Protocol) that operates through **SSE (Server-Sent Events)** and **Stream-HTTP** protocols with authentication and authorization handled by **SAP BTP XSUAA**, provisioned via `cds add xsuaa`.  
The actual MCP implementation lives in the **`mcp-abap-adt`** submodule (which has no built-in authorization). The CAP proxy acts as the gateway that enforces authorization, role checks, and reliable stream forwarding.

---

## 2. Goals

1. Protect every MCP entry point via XSUAA.  
2. Allow stream access only for users with the appropriate roles.  
3. Support two protocols: **SSE** (Server-Sent Events) and **Stream-HTTP** (NDJSON).  
4. Provide universal authorization middleware for SSE because CDS does not handle SSE authentication automatically.  
5. Implement Dev/Prod profiles: Basic/mock in dev, XSUAA in production.  
6. Prepare the CAP application for deployment to BTP.

---

## 3. Architecture

```mermaid
flowchart LR
  CLI[Cline / CLI client] -->|SSE / Stream-HTTP| CAP[CAP Service: mcp-proxy]
  CAP -->|Auth via JWT / Basic| XSUAA[XSUAA (SAP BTP)]
  CAP -->|Forward stream| MCP[mcp-abap-adt (submodule)]
  MCP -->|stream responses| CAP --> CLI
```

---

## 4. XSUAA Integration

```bash
cds add xsuaa
```

CAP automatically:
- creates the `xs-security.json` file;
- adds to `package.json`:
  ```json
  { "cds": { "requires": { "auth": "xsuaa" } } }
  ```
- adds dependencies:
  ```json
  { "@sap/xssec": "^3", "@sap/xsenv": "^3" }
  ```
- enables the `cds.auth()` middleware for JWT tokens.  

---

## 5. Key Components

| Component | Description |
|-----------|-------------|
| **CAP mcp-proxy** | Proxy that accepts SSE and Stream-HTTP requests, verifies authorization, and forwards the data to `mcp-abap-adt`. |
| **XSUAA (SAP BTP)** | Authorization service that validates JWT tokens. |
| **authShim** | Additional middleware that processes Basic auth (dev) and Bearer tokens (prod) and populates `req.user` in CAP format. |
| **mcp-abap-adt** | Actual MCP API implementation connected as a git submodule. |
| **Cline/CLI** | Client that initiates SSE or Stream-HTTP requests. |

---

## 6. CAP Configuration (package.json)

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
      "auth": "xsuaa",
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
              "alice": { "roles": ["MCP_Connector", "MCP_Admin"] },
              "bob": { "roles": ["MCP_Connector"] }
            }
          }
        }
      }
    }
  }
}
```

---

## 7. Security Model (xs-security.json)

```json
{
  "xsappname": "mcp-proxy",
  "tenant-mode": "shared",
  "scopes": [
    { "name": "$XSAPPNAME.MCP_Connect", "description": "Connect to MCP stream" },
    { "name": "$XSAPPNAME.MCP_Read", "description": "Read MCP stream" },
    { "name": "$XSAPPNAME.MCP_Admin", "description": "Admin operations" }
  ],
  "roles": [
    {
      "name": "MCP_Connector",
      "description": "Basic MCP access",
      "scope-references": [ "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]
    },
    {
      "name": "MCP_Admin",
      "description": "Full administrative access",
      "scope-references": [ "$XSAPPNAME.MCP_Admin", "$XSAPPNAME.MCP_Connect", "$XSAPPNAME.MCP_Read" ]
    }
  ]
}
```

---

## 8. Local Service Binding (default-env.json)

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

## 9. AuthShim (Universal Middleware for SSE/Stream)

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
      req.user = new cds.User({ id: user || 'anonymous', roles: ['MCP_Connector'] })
      return next()
    }
    if (hdr.startsWith('Bearer ')) {
      if (!xsuaa) throw new Error('Missing XSUAA binding')
      await new Promise((resolve, reject) =>
        xssec.createSecurityContext(hdr.slice(7), xsuaa, (e, sc) => e ? reject(e) : resolve(req._sc = sc))
      )
      const scopes = new Set(req._sc.getScopes() || [])
      const roles = []
      if (scopes.has(`${xsuaa.xsappname}.MCP_Connect`)) roles.push('MCP_Connector')
      if (scopes.has(`${xsuaa.xsappname}.MCP_Admin`)) roles.push('MCP_Admin')
      req.user = new cds.User({ id: req._sc.getLogonName(), roles })
      return next()
    }
    res.status(401).send('Unauthorized')
  } catch (e) {
    res.status(401).send('Unauthorized: ' + e.message)
  }
}
```

> Even with `cds.auth()` enabled, custom Express routes for SSE do not always receive `req.user`. The `authShim` guarantees correct user and role resolution.

---

## 10. SSE Endpoint (GET /mcp/stream/sse)

```js
cds.on('bootstrap', (app) => {
  app.use(cds.auth())

  app.get('/mcp/stream/sse', authShim, async (req, res) => {
    if (!req.user?.is('MCP_Connector')) return res.sendStatus(403)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write('retry: 15000\\n\\n')
    const ping = setInterval(() => res.write(': ping\\n\\n'), 15000)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/sse', { headers: { Accept: 'text/event-stream' } })

    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end', () => { clearInterval(ping); res.end() })
    req.on('close', () => { upstream.body?.destroy?.(); clearInterval(ping); res.end() })
  })
})
```

**SSE Requirements:**
- Disable compression/buffering on `/mcp/stream/sse`.
- Heartbeat every 10–30 seconds (`: ping`) with `retry: 15000` for the client.
- Read/write timeouts must be at least 60 seconds.

---

## 11. Stream-HTTP Endpoint (POST /mcp/stream/http)

```js
cds.on('bootstrap', (app) => {
  app.post('/mcp/stream/http', authShim, async (req, res) => {
    if (!req.user?.is('MCP_Connector')) return res.sendStatus(403)

    const target = cds.env.requires?.mcpTarget?.credentials?.url || 'http://127.0.0.1:7070'
    const upstream = await fetch(target + '/stream', { method: 'POST', body: req })

    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/x-ndjson')
    upstream.body.on('data', chunk => res.write(chunk))
    upstream.body.on('end', () => res.end())
  })
})
```

**Stream-HTTP Requirements:**
- Response format must be NDJSON (`application/x-ndjson`) or `text/plain` line-delimited JSON.
- Manage backpressure via `res.write()` and proper flushing.
- Enforce an event size limit (for example, 1 MB).

---

## 12. Run Profiles (Dev / Prod)

| Mode | Authorization | Example Header |
|------|---------------|----------------|
| **Dev** | Basic (mock) | `Authorization: Basic YWxpY2U6` |
| **Prod** | JWT (XSUAA) | `Authorization: Bearer <JWT>` |

**Dev:**  
```bash
cds watch --profile dev
# Basic: alice:
# curl -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse
```

**Prod:**  
- Bind the `xsuaa` service on CF/BTP.  
- Clients must present a valid `Bearer` token (service token or on-behalf-of).

---

## 13. Cline Configuration Examples

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

**Stream-HTTP (`cline.json`):**
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

## 14. Acceptance Criteria

1. Authorized users (MCP_Connector role) receive events via SSE.  
2. Missing role results in `403 Forbidden`.  
3. Dev mode works with Basic `alice:` credentials.  
4. Streams remain stable with heartbeats every 15 seconds.  
5. Sustained load of 500 events/second shows no memory leaks.  
6. XSUAA JWT tokens are validated.  
7. Deployment documentation for BTP is ready.  

---

## 15. Test Plan

### 15.1 Functional Tests
- [ ] Open an SSE stream in dev (Basic alice).  
- [ ] Open an SSE stream in prod (JWT).  
- [ ] POST to `/mcp/stream/http` with NDJSON.  
- [ ] Verify the response without a token (expect 401).  
- [ ] Verify the response without the role (expect 403).  

### 15.2 Load Tests
- [ ] 500 events/second for 5 minutes without errors or instability.  
- [ ] Observe CPU/RAM utilization.  

### 15.3 Security
- [ ] Mask sensitive headers in logs.  
- [ ] Apply IP rate limiting (optional).  
- [ ] Check for XSS/injection in payload events.  

---

## 16. Next Steps

1. Implement the SSE and Stream-HTTP endpoints.  
2. Integrate XSUAA via `cds add xsuaa`.  
3. Link `mcp-abap-adt` as a submodule.  
4. Write tests with Cline/curl.  
5. Deploy to SAP BTP (Cloud Foundry).  
6. Add observability (structured logs and metrics).
