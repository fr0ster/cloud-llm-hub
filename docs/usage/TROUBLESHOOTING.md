# Troubleshooting Guide

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

Quick reference for common issues and solutions when using Cloud LLM Hub.

## 🔍 Quick Diagnostics

### Check Service Health

```bash
# Health check
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp-proxy/Health\(\)

# Expected: {"status":"UP","timestamp":"..."}
```

### Check Logs

```bash
# Local development
cds watch --profile development --debug

# Cloud Foundry
cf logs cloud-llm-hub-srv --recent
cf logs cloud-llm-hub-srv  # Stream logs
```

### Verify Service Bindings

```bash
# Check bound services
cf services

# Check service bindings
cf env cloud-llm-hub-srv
```

---

## 🔐 Authentication Issues

### Problem: 401 Unauthorized

**Symptoms:**

- Requests return `401 Unauthorized`
- "Authentication required" error messages

**Possible Causes:**

1. Missing `Authorization` header
2. Invalid or expired JWT token
3. Incorrect Basic auth credentials
4. XSUAA service not bound

**Solutions:**

**1. Check Authorization Header:**

```bash
# Verify header is present
curl -v -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp-proxy/Health\(\)
```

**2. Refresh XSUAA Token:**

```bash
# Get new token
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

**3. Verify Service Binding:**

```bash
# Check XSUAA service
cf services | grep xsuaa

# Bind service if missing
cf bind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf restage cloud-llm-hub-srv
```

**4. Check Development Mode:**

```bash
# Ensure development profile is active
cds watch --profile development

# Use correct Basic auth (alice: empty password)
echo -n "alice:" | base64  # Should be YWxpY2U6
```

---

### Problem: Web chat — wrong SAP password after switching systems

**TL;DR:** The browser password manager keeps only the **last** SAP password you
saved. If the same SAP user has **different passwords on different systems**
(e.g. `DEVELOPER` on DEV vs QAS), after switching systems you must **re-type the
password manually** — the autofilled one belongs to the other system.

**Symptoms:**

- Login gate connects to one system fine, but a different system fails / 401.
- You switched destination (e.g. DEV → QAS) and it stopped working.

**Why:**

- The login gate stores credentials in the **browser password manager**, keyed by
  `(host, username)`.
- Same hub host + same SAP user = **one** stored password. The manager autofills
  that one password for **every** system — but each SAP system may have its own
  password for that user.
- So whichever system's password you saved last works; the other gets the wrong
  password.

**Fix:**

- When you LOGOUT and reconnect to a different system that uses the **same SAP
  user with a different password**, **clear the autofilled password field and
  type the correct password** for that system.
- The manager then remembers the last one you entered (so switching back requires
  re-typing again). This is a browser password-manager limitation (one password
  per user per site), not a server issue.

---

### Problem: Local proxy — `SAP_CREDENTIALS_REQUIRED` even though creds are set

**TL;DR:** Point the `mcp-abap-adt-proxy` `targetUrl` at the **bare srv route**, NOT
the approuter. The approuter **strips custom `x-sap-*` headers**, so the srv never
sees your SAP login/password → fail-closed `SAP_CREDENTIALS_REQUIRED`.

**Symptoms:**

- Proxy/Cline request returns `SAP_CREDENTIALS_REQUIRED` (or `401`) although the
  proxy `defaultHeaders` carry `x-sap-login` / `x-sap-password`.
- The same call works against another subaccount whose `targetUrl` points at its
  srv route.

**Fix:**

- Set the proxy `targetUrl` to the **srv** route, e.g.
  `https://<subaccount>-cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com`
  (the app `cloud-llm-hub-srv`), **not** the approuter
  `https://<subaccount>-cloud-llm-hub...` (the app `cloud-llm-hub`).
- The srv route is intentionally public so the proxy can deliver `x-sap-*`
  headers directly. The approuter is for the browser/XSUAA flow only.
- The srv route is named per subaccount (`${APPROUTER_HOST}-srv`); if you still
  see a generic `<org-name>-sn-<guid>` route, redeploy so the named route
  is created, then update `targetUrl`.

---

### Problem: Wrong SAP client (mandant) — e.g. QAS needs client 600

**TL;DR:** The `X-SAP-Client` **header alone is ignored** by ABAP — the client is
selected via the `sap-usercontext` cookie, which the hub now sets from the
destination's `sap-client` **or** the per-request `x-sap-client` header.

**Symptoms:**

- Connection to a system in a non-default client (e.g. client `600`) fails with
  `CSRF ... 401` while the same user works in the default client (e.g. `100`).

**Fix:**

- Set `sap-client` on the BTP destination (e.g. `600` for QAS), **or** pass the
  per-request header `x-sap-client: 600` (proxy `defaultHeaders`).
- The hub sends both `X-SAP-Client` and the `sap-usercontext=sap-client=<n>`
  cookie, so ABAP routes to the right client.
- If it still fails after the client is correct, the user is likely **locked in
  that client** — unlock in SU01 on that system/client. (CSRF no longer retries
  on 401, so the hub will not re-lock from retries.)

---

### Problem: A create fails with `system_context_missing`

**TL;DR:** the hub found no responsible person for the new object, so nothing
was sent to SAP. Send `x-sap-login` (your own SAP user) or `x-sap-responsible`.

- The responsible is `x-sap-responsible`, else the uppercased `x-sap-login`.
- On a system declared `cloud` (raw MCP route), it is the user the system
  reports; the error then says the system could not be reached — retry later.
- No POST and no LOCK were sent, so no object or lock was left behind.

---

### Problem: `INVALID_SYSTEM_TYPE` (400)

**TL;DR:** `x-sap-system-type` (or the destination's `SAP_SYSTEM_TYPE`
property) holds a value other than `onprem`, `cloud` or `legacy`.

- Fix the header, or drop it — the default is `onprem`.
- A bad destination property fails that destination's resolution (`502`),
  naming the destination and the property. Fix it in the BTP cockpit, or in
  the `destinations` entry for a local run.

---

### Problem: 403 Forbidden

**Symptoms:**

- Requests return `403 Forbidden`
- "Insufficient permissions" error messages

**Possible Causes:**

1. User lacks required scopes
2. Role collection not assigned
3. Incorrect XSUAA configuration

**Solutions:**

**1. Check User Roles:**

```bash
# Development users (mocked auth, see package.json cds.requires.auth)
# alice: MCP_Full, MCP_Developer, MCP_Analyst, MCP_Reader
# bob:   MCP_Developer, MCP_Analyst, MCP_Reader
# carol: MCP_Analyst, MCP_Reader
# dave:  MCP_Reader

# Verify with correct user
curl -H "Authorization: Basic YWxpY2U6" \  # alice
     http://localhost:4004/odata/v4/mcp-proxy/Health\(\)
```

**2. Verify XSUAA Scopes:**

- Check `xs-security.json` for required scopes
- Ensure role collections are configured
- Verify the user holds one of `MCP_Reader`, `MCP_Analyst`, `MCP_Developer`, `MCP_Full`

**3. Check Production Roles:**

```bash
# In BTP Cockpit
# Go to Security → Role Collections
# Assign one of: MCP Reader Access, MCP Analyst Access,
#                MCP Developer Access, MCP Full Access
```

---

## 🔌 Connection Issues

### Problem: Connection Timeout

**Symptoms:**

- Requests timeout after 30-60 seconds
- "ETIMEDOUT" errors in logs
- No response from SAP system

**Possible Causes:**

1. SAP system not accessible
2. Network connectivity issues
3. Firewall blocking connections
4. Cloud Connector not configured

**Solutions:**

**1. Test SAP Connectivity:**

```bash
# Test direct connection
curl -v https://your-sap-system.com/sap/bc/adt/discovery

# Check Cloud Connector status
# In Cloud Connector admin UI
```

**2. Verify Destination Configuration:**

```bash
# Probe destination
curl -H "Authorization: Basic YWxpY2U6" \
     "http://localhost:4004/odata/v4/mcp-proxy/ProbeDestination?destination=SAP_DEV_DEST"
```

**3. Check Network/Firewall:**

- Verify SAP system is accessible from Cloud Foundry
- Check firewall rules for Cloud Connector
- Verify Cloud Connector location ID

**4. Check Cloud Connector:**

```bash
# Verify Cloud Connector is running
# Check Cloud Connector admin UI
# Verify tunnel is active
# Check location ID matches configuration
```

---

### Problem: 502 Bad Gateway

**Symptoms:**

- Requests return `502 Bad Gateway`
- "MCP server connection failed" errors

**Possible Causes:**

1. MCP server not initialized
2. SAP connection failed
3. Invalid SAP credentials
4. Destination configuration error

**Solutions:**

**1. Check MCP Server Status:**

```bash
# Verify MCP server is running (if standalone)
curl http://127.0.0.1:7070/health

# Check logs for initialization errors
cds watch --profile development --debug
```

**2. Verify SAP Credentials:**

```bash
# Test SAP connection directly
curl -u username:password \
     https://sap-system.com/sap/bc/adt/discovery
```

**3. Check Destination Configuration:**

- Verify destination name is correct
- Check destination credentials in BTP Cockpit
- Verify authentication type matches

**4. There is no MCP session to reset.**

The transport runs in stateless mode (`sessionIdGenerator: undefined`,
`srv/mcp-manager.ts`) and a fresh server is built per request, so a plain call
is already a clean one:

```bash
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http
```

---

## 🌐 Destination Issues

### Problem: Destination Not Found

**Symptoms:**

- `404 Not Found` for destination
- "Destination not found" error

**Solutions:**

**1. Verify Destination Exists:**

```bash
# Check in BTP Cockpit
# Connectivity → Destinations
# Verify destination name matches exactly
```

**2. Check Service Binding:**

```bash
# Verify Destination service is bound
cf services | grep destination

# Bind if missing
cf bind-service cloud-llm-hub-srv cloud-llm-hub-destination
cf restage cloud-llm-hub-srv
```

**3. Verify Destination Name:**

```bash
# Use exact destination name (case-sensitive)
curl -H "Authorization: Basic YWxpY2U6" \
     -H "X-SAP-Destination: SAP_DEV_DEST" \  # Exact name
     http://localhost:4004/mcp/stream/http
```

---

### Problem: Cloud Connector Issues

**Symptoms:**

- On-premise destinations fail
- Connection timeouts
- "Tunnel not found" errors

**Solutions:**

**1. Verify Cloud Connector Configuration:**

- Check `ConnectorID` in `mta.yaml` matches Cloud Connector
- Verify location ID in destination matches Cloud Connector
- Check Cloud Connector admin UI for tunnel status

**2. Check Connectivity Service:**

```bash
# Verify Connectivity service is bound
cf services | grep connectivity

# Bind if missing
cf bind-service cloud-llm-hub-srv cloud-llm-hub-connectivity
cf restage cloud-llm-hub-srv
```

**3. Verify Location ID:**

```bash
# Check destination configuration
# Ensure CloudConnectorLocationId matches Cloud Connector
# Or use X-SAP-Connectivity-Location-ID header
```

---

## 📡 Stream-HTTP Issues

### Problem: Stream-HTTP Session Issues

**Symptoms:**

- "Server already initialized" errors
- Session not persisting
- Requests failing after first call

**Solutions:**

**1. Do not send a session header.**

The endpoint is stateless — it issues no `Mcp-Session-Id` and ignores one if
sent. Each call is independent:

```bash
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http
```

**2. Credential rotation needs no reset.**

A new server instance is created per request from that request's own `x-sap-*`
headers, so the next call already uses the new credentials.

---

## 🐛 Development Issues

### Problem: Port Already in Use

**Symptoms:**

- `EADDRINUSE` error
- Cannot start server on port 4004

**Solutions:**

```bash
# Find process using port
lsof -i :4004
# or (Linux)
netstat -tulpn | grep 4004

# Kill process
kill -9 <PID>

# Or use different port
PORT=4005 cds watch
```

---

### Problem: TypeScript Compilation Errors

**Symptoms:**

- Type errors during build
- Import resolution failures

**Solutions:**

```bash
# Check TypeScript errors
npm exec -- tsc --noEmit

# Clean and rebuild
rm -rf dist/ node_modules/@types
npm install
npm exec -- tsc --noEmit
```

---

## 📋 Common Error Messages

### "Tool ... was not executed: it belongs to the ... group"

**Cause:** Your MCP roles do not cover that tool. The check runs at execution, so
it fires even when you named the tool yourself in the prompt and the model asked
for it by name.

The message states the tool's group and the groups your roles grant, for example
`"high"` needed against `[readonly, search, system]`.

**Solution:** Have the matching role collection assigned (see
[MCP_CONNECTION.md](MCP_CONNECTION.md) for the group each role grants), or use a
tool your current role covers. Retrying will not help — nothing about the request
changes the answer.

---

### "Tool ... was not executed: the caller's permissions could not be determined"

**Cause:** The request carries no MCP role at all — usually a token without any
`MCP_*` scope, or a token from the wrong XSUAA instance.

**Solution:** Check the token's scopes (`npm run get:token`, then decode) and that
the role collection is assigned to your user in the subaccount the app is deployed
to. Deliberately fail-closed: an unidentifiable caller is refused rather than
given a default level of access.

---

### "Invalid Request: Server already initialized"

**Cause:** Two `initialize` calls reached the same MCP server instance. This is
not a session-header problem — the transport is stateless and issues no
`Mcp-Session-Id`; a server is created per request.

**Solution:** Send `initialize` once per connection, then go straight to
`tools/list` / `tools/call`. Do not add a session header — it is neither issued
nor required.

---

### "Destination not found"

**Cause:** Destination name doesn't exist or service not bound.

**Solution:** Verify destination name and service binding.

---

### "Connection timeout"

**Cause:** Cannot reach SAP system or Cloud Connector.

**Solution:** Check network connectivity and Cloud Connector status.

---

### "Authentication failed"

**Cause:** Invalid SAP credentials or token expired.

**Solution:** Verify credentials and refresh tokens.

---

## 🔗 Getting Help

### Additional Resources

- [API Reference](../architecture/API_REFERENCE.md) - Complete API specification

### Support Channels

- **GitHub Issues:** Report bugs and request features
- **GitHub Discussions:** Ask questions and share ideas
- **Documentation:** Check docs/ directory for guides

---

**Last Updated:** 2025-11-05  
**Version:** 1.0
