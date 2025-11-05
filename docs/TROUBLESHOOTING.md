# Troubleshooting Guide

Quick reference for common issues and solutions when using Cloud LLM Hub.

## 🔍 Quick Diagnostics

### Check Service Health

```bash
# Health check
curl -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/odata/v4/mcp/Health\(\)

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
     http://localhost:4004/odata/v4/mcp/Health\(\)
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
# Development users
# alice: MCP_Connector, MCP_Admin
# bob: MCP_Connector

# Verify with correct user
curl -H "Authorization: Basic YWxpY2U6" \  # alice
     http://localhost:4004/odata/v4/mcp/Health\(\)
```

**2. Verify XSUAA Scopes:**
- Check `xs-security.json` for required scopes
- Ensure role collections are configured
- Verify user has `MCP_Connector` role

**3. Check Production Roles:**
```bash
# In BTP Cockpit
# Go to Security → Role Collections
# Assign MCP_Connector role to user
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
     "http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=SAP_DEV_DEST"
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

**4. Reset MCP Session:**
```bash
# Omit Mcp-Session-Id header to force re-initialization
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     # NO Mcp-Session-Id header
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

## 📡 Streaming Issues

### Problem: SSE Stream Disconnects

**Symptoms:**
- SSE connection closes unexpectedly
- No heartbeat received
- Connection timeout errors

**Solutions:**

**1. Check Network Stability:**
```bash
# Test with verbose curl
curl -v -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

**2. Verify Heartbeat:**
- SSE should send `: ping` every 15 seconds
- If missing, check server logs
- Verify timeout settings

**3. Handle Reconnection:**
```javascript
// Client should handle reconnection
eventSource.onerror = (error) => {
  // Reconnect after delay
  setTimeout(() => {
    eventSource = new EventSource(url);
  }, 15000);
};
```

---

### Problem: Stream-HTTP Session Issues

**Symptoms:**
- "Server already initialized" errors
- Session not persisting
- Requests failing after first call

**Solutions:**

**1. Check Session Management:**
```bash
# First request: Omit Mcp-Session-Id
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:4004/mcp/stream/http

# Response includes: Mcp-Session-Id: <session-id>

# Subsequent requests: Include Mcp-Session-Id
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Mcp-Session-Id: <session-id-from-previous-response>" \
     -H "Content-Type: application/x-ndjson" \
     --data '{"jsonrpc":"2.0","id":2,"method":"tools/call",...}' \
     http://localhost:4004/mcp/stream/http
```

**2. Reset Session:**
```bash
# Omit Mcp-Session-Id to force re-initialization
# Useful after credential rotation
```

**3. Check Session Expiration:**
- Sessions expire after 30 minutes of inactivity
- Cache is cleared on proxy restart
- Force re-initialization if needed

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

### Problem: Submodule Issues

**Symptoms:**
- MCP server not found
- Import errors from submodule

**Solutions:**

```bash
# Reinitialize submodules
git submodule deinit --all
git submodule update --init --recursive

# Build submodule
cd submodules/mcp-abap-adt
npm install
npm run build
cd ../..
```

---

## 📋 Common Error Messages

### "Invalid Request: Server already initialized"

**Cause:** MCP session already exists, but request doesn't include `Mcp-Session-Id`.

**Solution:** Include `Mcp-Session-Id` header from previous response, or omit it to reset.

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

- [API Reference](API_REFERENCE.md) - Complete API specification
- [MCP Proxy Usage](MCP_PROXY_USAGE.md) - Detailed usage guide
- [Debugging Guide](DEBUGGING.md) - Debugging techniques
- [MCP Config Update How-To](MCP_CONFIG_UPDATE_HOWTO.md) - Configuration help

### Support Channels

- **GitHub Issues:** Report bugs and request features
- **GitHub Discussions:** Ask questions and share ideas
- **Documentation:** Check docs/ directory for guides

---

**Last Updated:** 2025-11-05  
**Version:** 1.0

