# JWT Authentication Debugging Guide

## Quick Start

When the server is running in debug mode, check these log messages in order:

```bash
# Run server with debug logging
CDS_LOG_LEVEL=debug cds serve --with-mocks --in-memory --profile development

# Filter logs for JWT-related messages
cds serve 2>&1 | grep -E "jwt|token|mcp-manager|mcp-proxy"
```

## What to Check During Debug Session

### Step 1: Token Extraction from Headers (server.ts)

**Look for:**

```
[mcp-proxy/stream-http] Extracted tokens from headers
```

**Must contain:**

- `hasJwtToken: true` ✅
- `jwtTokenLength: <number>` (should be > 0)
- `hasRefreshToken: true/false`

**If missing:** Check that `X-SAP-JWT-TOKEN` header is sent in the request.

---

### Step 2: Session Config Creation (server.ts)

**Look for one of:**

```
[mcp-proxy/stream-http] sessionSapConfig from destination with refresh support
```

OR

```
[mcp-proxy/stream-http] JWT config with refresh support
```

**Must contain:**

- `hasJwtToken: true` ✅
- `jwtTokenLength: <number>` (should match Step 1)
- `authType: "jwt"` ✅
- `canRefresh: true/false` (if refresh token provided)

**If missing:** Token is lost between header extraction and config creation.

---

### Step 3: Config Extraction in mcp-manager (mcp-manager.ts)

**Look for:**

```
[mcp-manager] SAP config extracted from headers
```

**Must contain:**

- `authType: "jwt"` ✅
- `hasJwtToken: true` ✅
- `jwtTokenLength: <number>` (should match Step 1)
- `tokenPreview: "..."` (first/last 20 chars of token)

**If missing:** Token is lost in `extractSapContext()` function.

---

### Step 4: Passing Config to Connection (mcp-manager.ts)

**Look for:**

```
[mcp-manager] Passing sapConfig to mcp-abap-adt for connection creation
```

**Must contain:**

- `hasJwtToken: true` ✅
- `jwtTokenLength: <number>` (should match Step 1)
- `jwtTokenPreview: "..."` (first/last 20 chars)
- `source: "headers"` or `source: "destination"`

**If missing:** Token is lost before creating connection.

---

### Step 5: CRITICAL Error Check

**Look for:**

```
[mcp-manager] CRITICAL: JWT auth type but no JWT token in sapConfig!
```

**If present:** Token was lost between extraction and connection creation. Check Steps 1-4 to find where.

---

## Debug Environment Variables

Enable all debug logging:

```bash
export CDS_LOG_LEVEL=debug          # CAP framework logs
export DEBUG_CONNECTORS=true        # MCP connection logs
export DEBUG_HANDLERS=true          # MCP handler logs
export DEBUG_CONNECTION_MANAGER=true # Connection manager logs

cds serve --with-mocks --in-memory --profile development
```

## Log Filtering Commands

### Filter by Component

```bash
# JWT/token related
cds serve 2>&1 | grep -iE "jwt|token|auth"

# mcp-manager only
cds serve 2>&1 | grep "mcp-manager"

# mcp-proxy only
cds serve 2>&1 | grep "mcp-proxy"

# Errors only
cds serve 2>&1 | grep -iE "error|critical|failed"
```

### Filter by Message Type

```bash
# Token extraction
cds serve 2>&1 | grep "Extracted tokens from headers"

# Config creation
cds serve 2>&1 | grep "sessionSapConfig\|JWT config"

# Connection creation
cds serve 2>&1 | grep "Passing sapConfig\|Creating new MCP server"
```

## Troubleshooting Flow

### Problem: JWT token not found in connection

1. **Check Step 1:** Is token in headers?
   - Look for `Extracted tokens from headers` with `hasJwtToken: true`
   - If `false`: Client is not sending `X-SAP-JWT-TOKEN` header

2. **Check Step 2:** Is token in sessionSapConfig?
   - Look for `sessionSapConfig from destination` or `JWT config with refresh support`
   - If token missing: Check `resolveDestinationSapConfig()` or header extraction logic

3. **Check Step 3:** Is token in mcp-manager config?
   - Look for `SAP config extracted from headers`
   - If token missing: Check `extractSapContext()` in mcp-manager.ts

4. **Check Step 4:** Is token passed to connection?
   - Look for `Passing sapConfig to mcp-abap-adt`
   - If token missing: Check `getMCPServer()` function

5. **Check Step 5:** Any CRITICAL errors?
   - If yes: Token was lost at the step before the error

## Expected Log Sequence (Success Case)

```
[mcp-proxy/stream-http] Extracted tokens from headers { hasJwtToken: true, jwtTokenLength: 1234 }
[mcp-proxy/stream-http] JWT config with refresh support { hasJwtToken: true, jwtTokenLength: 1234 }
[mcp-manager] SAP config extracted from headers { authType: 'jwt', hasJwtToken: true, jwtTokenLength: 1234 }
[mcp-manager] Passing sapConfig to mcp-abap-adt for connection creation { hasJwtToken: true, jwtTokenLength: 1234 }
[mcp-proxy/stream-http] Running in sessionContext { hasJwtToken: true, jwtTokenLength: 1234 }
```

## Common Issues

### Issue 1: Token Missing in Step 2

**Symptom:** `hasJwtToken: false` in `sessionSapConfig from destination`

**Possible causes:**

- Destination doesn't support JWT (uses Basic auth instead)
- `resolveDestinationSapConfig()` not passing JWT token
- Header `X-SAP-JWT-TOKEN` not extracted correctly

**Fix:** Check `destinationResolver.ts` and ensure JWT token is passed to `buildSapConfigFromDestination()`

### Issue 2: Token Missing in Step 3

**Symptom:** `hasJwtToken: false` in `SAP config extracted from headers`

**Possible causes:**

- `extractSapContext()` not reading `X-SAP-JWT-TOKEN` header
- Header name mismatch (case sensitivity)

**Fix:** Check `mcp-manager.ts` line 116: `req.headers['x-sap-jwt-token']`

### Issue 3: Token Missing in Step 4

**Symptom:** `CRITICAL: JWT auth type but no JWT token in sapConfig!`

**Possible causes:**

- `sapConfig` object modified between extraction and connection creation
- Token property not copied correctly

**Fix:** Check `getMCPServer()` function, ensure `sapConfig` is not modified

## Cloud Foundry Logs

If running in Cloud Foundry:

```bash
# Stream logs
cf logs cloud-llm-hub-srv | grep -E "jwt|token|mcp-manager"

# Recent logs
cf logs cloud-llm-hub-srv --recent | grep "mcp-manager"

# Export logs
cf logs cloud-llm-hub-srv --recent > jwt-debug-$(date +%Y%m%d).log
```

## Quick Debug Checklist

When debugging JWT authentication:

- [ ] Token extracted from headers? (Step 1)
- [ ] Token in sessionSapConfig? (Step 2)
- [ ] Token in mcp-manager config? (Step 3)
- [ ] Token passed to connection? (Step 4)
- [ ] No CRITICAL errors? (Step 5)
- [ ] Token length consistent across all steps?
- [ ] authType is "jwt" (not "basic")?

If all checked ✅, JWT token is correctly passed through the entire chain.
