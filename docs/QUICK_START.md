# 🚀 Quick Start: MCP Proxy in 5 Minutes

Spin up the MCP Proxy locally and connect it to Cline.

---

## ✅ Step 1: Start the service (1 minute)

### Run the CAP server:

```bash
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

### ✓ Verify the service is running:

```bash
curl http://localhost:4004/mcp/Health
```

**Expected response:**
```json
{
  "status": "UP",
  "timestamp": "2025-10-29T..."
}
```

---

## ✅ Step 2: Configure Cline (2 minutes)

### Option A: SSE (recommended)

Create or update the Cline configuration file (for example `~/.config/cline/mcp-settings.json` or through the Cline settings UI):

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "sse",
      "endpoint": "http://localhost:4004/mcp/stream/sse",
      "headers": {
        "Authorization": "Basic YWxpY2U6"
      },
      "description": "MCP Proxy with SSE (alice user)"
    }
  }
}
```

### Option B: Stream-HTTP

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "stream-http",
      "endpoint": "http://localhost:4004/mcp/stream/http",
      "headers": {
        "Authorization": "Basic YWxpY2U6",
        "Content-Type": "application/x-ndjson"
      },
      "description": "MCP Proxy with Stream-HTTP (alice user)"
    }
  }
}
```

### Where to find the Cline configuration

- **VS Code:** `Ctrl+Shift+P` → “Cline: Edit MCP Settings” or edit `~/.vscode/extensions/saoudrizwan.claude-dev-*/mcp-settings.json`
- **Cursor:** Settings → Extensions → Cline → MCP Settings
- **Standalone:** `~/.config/cline/mcp-settings.json`

---

## ✅ Step 3: Reload Cline (30 seconds)

1. In VS Code/Cursor: `Ctrl+Shift+P` → “Reload Window”, or restart the Cline extension.
2. Open the Cline panel and ensure the connection appears.

---

## ✅ Step 4: Sanity check (1 minute)

### In the Cline chat run:

```
@mcp list tools
```

or

```
Show me available MCP tools
```

### ✓ Expected result

Cline lists the available MCP tools exposed by the `mcp-abap-adt` backend.

**Sample output:**
```
Available MCP Tools:
- tool1: Description of tool 1
- tool2: Description of tool 2
- ...
```

---

## 🔧 Troubleshooting

### ❌ Cline cannot see the MCP server

**Cause:** malformed configuration or missing Authorization header

**Fix:**
1. Ensure `Authorization: Basic YWxpY2U6` (alice user)
2. Endpoint must be `http://localhost:4004/mcp/stream/sse`
3. Reload the Cline window

### ❌ Connection refused or timeout

**Cause:** CAP service is not running

**Fix:**
```bash
# Check if the service responds
curl http://localhost:4004/mcp/Health

# If not, start it
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

### ❌ 401 Unauthorized

**Cause:** incorrect Authorization header

**Fix:** generate the correct Base64 value:
```bash
echo -n "alice:" | base64
# Expected: YWxpY2U6
```

Use it in the Cline config:
```json
"Authorization": "Basic YWxpY2U6"
```

### ❌ 403 Forbidden

**Cause:** user lacks the `MCP_Connector` role

**Fix:** use `alice` or `bob` (both include the role):
```bash
# alice
echo -n "alice:" | base64
# YWxpY2U6

# bob
echo -n "bob:" | base64
# Ym9iOg==
```

### ❌ MCP backend unavailable

**Cause:** `mcp-abap-adt` backend is down

**Fix:**
```bash
# Start the backend (if installed)
cd external/mcp-abap-adt
npm install
npm start

# Verify
curl http://127.0.0.1:7070/health
```

**Note:** If the backend is missing, the proxy will return upstream errors. That is fine for auth-only testing.

---

## 🧪 Quick authorization test

### Using curl (without Cline):

```bash
# SSE (should show retry and heartbeat)
timeout 5 curl -N \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse

# Stream-HTTP (should accept the request)
echo '{"command":"test"}' | \
curl -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

---

## 📊 Checklist

- [ ] Service is running: `curl http://localhost:4004/mcp/Health` returns 200
- [ ] Cline configuration uses the correct endpoint and Authorization header
- [ ] Cline has been reloaded
- [ ] Cline shows the MCP tool list
- [ ] (Optional) `mcp-abap-adt` backend is online

---

## 📝 Ready-to-use configs

Preconfigured templates live in `docs/examples/`:

### Development (local)
- `docs/examples/cline-sse-dev.json` — SSE connection
- `docs/examples/cline-stream-dev.json` — Stream-HTTP connection

### Production (BTP)
- `docs/examples/cline-sse-prod.json` — SSE with JWT token

Copy the file you need into your Cline configuration.

---

## 🎯 Next steps

### If everything works

1. Exercise MCP tools via Cline.
2. Tail the CAP logs (terminal running `cds watch`).
3. Try additional users (e.g., `bob`) to validate role-based behaviour.

### When preparing production mode

1. Deploy to BTP: `cf push`
2. Bind XSUAA: `cf bind-service cloud-llm-hub mcp-xsuaa`
3. Obtain a JWT via OAuth2
4. Switch to the production config with the Bearer token

---

## 💡 Useful commands

```bash
# Start the service
cd /home/developer/prj/cloud-llm-hub && cds watch --profile development

# Health check
curl http://localhost:4004/mcp/Health | jq .

# Quick SSE test
timeout 3 curl -N -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse

# Automated smoke tests
cd test/smoke && ./test-auth-interactive.sh
```

---

## 📚 More documentation

- **Detailed testing guide:** `docs/TESTING_GUIDE.md`
- **Command cheat sheet:** `docs/TESTING_CHEAT_SHEET.md`
- **Usage guide:** `docs/MCP_PROXY_USAGE.md`
- **Implementation report:** `docs/IMPLEMENTATION_REPORT.md`

---

**That’s it!** Within minutes you should have an MCP Proxy connected to Cline. 🎉

If anything breaks, revisit the troubleshooting section or run the automated smoke test: `cd test/smoke && ./test-auth-interactive.sh`
