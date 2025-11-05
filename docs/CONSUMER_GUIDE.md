# 👥 Consumer Guide

**Welcome!** This guide is for **users** of Cloud LLM Hub who want to connect their tools to SAP systems. You don't need to know how Cloud LLM Hub works internally—just how to use it effectively.

## 🎯 What is Cloud LLM Hub?

Cloud LLM Hub is a **bridge** between your SAP ABAP systems and modern AI/automation tools. Think of it as a translator that lets tools like Cline, n8n, or your custom scripts talk to SAP.

**What it does:**
- ✅ Connects AI assistants (Cline, Claude Desktop) to SAP
- ✅ Enables automation workflows (n8n, Zapier, CI/CD)
- ✅ Provides secure access to SAP ABAP systems
- ✅ Works with cloud and on-premise SAP systems

**What you get:**
- 🔍 Query ABAP code, objects, and dependencies
- 📊 Analyze code structure and impacts
- 🔄 Automate SAP-related tasks
- 🤖 AI-powered code assistance

## 🚀 Getting Started (3 Steps)

### Step 1: Get Access

You need:
- **Cloud LLM Hub deployment URL** (or deploy your own)
- **SAP system access** (URL or Destination name)
- **Authentication tokens** (XSUAA for MCP, JWT for SAP)

**Quick check:**
```bash
# Test if your deployment is accessible
curl https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)
```

### Step 2: Configure Your Client

**For Cline (VS Code):**
```bash
# One command setup
curl -sSL https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js | \
  node - --template cloud-destination \
    --connection sap-dev \
    --mcp-app cloud-llm-hub \
    --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
    --service-key-file sapAbap=./keys/sap-abap.json
```

**For other tools:** See [INTEGRATIONS.md](./INTEGRATIONS.md)

### Step 3: Start Using!

**In Cline:**
- Ask: "What classes are in package Z_MY_PACKAGE?"
- Ask: "Show me the dependencies of class Z_MY_CLASS"
- Ask: "Analyze the impact of changing this method"

**In n8n/Zapier:**
- Create workflows that query SAP on schedule
- Trigger actions based on SAP data
- Sync information between systems

## 🎨 Use Cases

### 1. AI-Assisted Development (Cline)

**What you can do:**
- Ask questions about your ABAP codebase
- Generate code from natural language descriptions
- Analyze code impacts before changes
- Get refactoring suggestions with context

**Example:**
```
You: "What classes use Z_MY_INTERFACE?"
Cline: [Queries SAP via MCP] "Found 5 classes: Z_CLASS1, Z_CLASS2..."
```

### 2. Automated Code Reviews

**CI/CD Integration:**
- Check code quality before merge
- Analyze dependencies automatically
- Generate impact reports
- Validate coding standards

**Example GitHub Action:**
```yaml
- name: Analyze Changes
  run: |
    node scripts/analyze-pr.js \
      --connection sap-ci \
      --pr-number ${{ github.event.pull_request.number }}
```

### 3. Workflow Automation

**n8n/Zapier workflows:**
- Daily code quality reports
- Automated dependency checks
- Change impact notifications
- Documentation generation

**Example:**
```
Schedule (Daily) → Query SAP → Process Results → Send Email Report
```

### 4. Data Synchronization

**Sync SAP metadata:**
- Object catalogs
- Dependency graphs
- Enhancement lists
- Code metrics

## 🛠️ Available Tools

Cloud LLM Hub provides access to these MCP tools:

### Code Discovery
- **GetObjectList** - List ABAP objects by type/package
- **GetObjectDetails** - Get detailed object information
- **GetObjectSource** - Retrieve source code

### Dependency Analysis
- **GetDependencies** - Find what an object depends on
- **GetWhereUsed** - Find where an object is used

### Enhancement Discovery
- **GetEnhancements** - List all enhancements
- **GetEnhancementByName** - Get specific enhancement details

### Batch Operations
- **DetectObjectTypeListArray** - Batch detect object types
- **DetectObjectTypeListJson** - Batch detect with JSON payload

**Full list:** See [submodules/mcp-abap-adt/README.md](../submodules/mcp-abap-adt/README.md)

## 📋 Configuration Options

### Mode 1: Cloud with Destination (Recommended)

**Best for:** Production, enterprise environments

**Pros:**
- ✅ Centralized configuration
- ✅ Automatic authentication
- ✅ Cloud Connector support
- ✅ No credentials in code

**Setup:**
```bash
node tools/update-cline-connection.js \
  --template cloud-destination \
  --connection sap-prod \
  --mcp-app cloud-llm-hub \
  --destination-name SAP_PROD_DEST \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json
```

### Mode 2: Direct Connection

**Best for:** Development, testing, local setups

**Pros:**
- ✅ Simple setup
- ✅ Direct SAP URL
- ✅ No Destination service needed

**Setup:**
```bash
node tools/update-cline-connection.js \
  --template direct-jwt \
  --connection sap-dev \
  --mcp-endpoint http://localhost:4004/mcp/stream/http \
  --sap-token $SAP_JWT_TOKEN
```

### Mode 3: Basic Auth (Testing Only)

**Best for:** Local development, quick tests

**Setup:**
```bash
node tools/update-cline-connection.js \
  --template direct-basic \
  --connection sap-test \
  --mcp-endpoint http://localhost:4004/mcp/stream/sse \
  --mcp-username alice \
  --sap-username developer \
  --sap-password "change-me"
```

## 🔧 Automation Tools

### One-Command Updates

**Update connection settings:**
```bash
node tools/update-cline-connection.js \
  --connection sap-dev \
  --sap-token $(get-sap-token) \
  --mcp-token $(get-mcp-token)
```

### YAML-Driven Configuration

**Manage multiple connections:**
```yaml
# config/connections.yaml
mcpConnection:
  endpoint: https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http
  auth:
    type: bearer
    token:
      source:
        type: serviceKey
        name: mcpXsuaa
        jsonPath: access_token

abapConnection:
  mode: destination
  destination:
    name: SAP_DEV_DEST
```

**Apply:**
```bash
node tools/update-cline-connection.js \
  --config config/connections.yaml \
  --connection sap-dev
```

### CI/CD Integration

**Automated token refresh:**
```yaml
- name: Update MCP Connection
  run: |
    node tools/update-cline-connection.js \
      --connection sap-ci \
      --sap-token ${{ secrets.SAP_JWT_TOKEN }} \
      --mcp-token ${{ secrets.MCP_XSUAA_TOKEN }}
```

## 🎯 Best Practices

### 1. Use Service Keys for Tokens

**Don't:**
```json
{
  "headers": {
    "Authorization": "Bearer hardcoded-token-here"
  }
}
```

**Do:**
```json
{
  "headers": {
    "Authorization": "Bearer {{ mcpXsuaa.access_token }}"
  }
}
```

### 2. Use Destinations for Production

**Benefits:**
- Centralized configuration
- Automatic authentication
- Cloud Connector support
- No credentials in code

### 3. Cache Results When Possible

MCP tools return fresh data each time. For frequently accessed information, consider caching in your application.

### 4. Handle Errors Gracefully

```javascript
try {
  const result = await mcpClient.callTool('GetObjectList', { objectType: 'CLAS' });
} catch (error) {
  if (error.status === 401) {
    // Token expired - refresh and retry
  } else if (error.status === 404) {
    // Object not found
  }
}
```

### 5. Use Batch Operations

For multiple objects, use batch tools:
```javascript
// Instead of multiple calls
const objects = ['CLAS1', 'CLAS2', 'CLAS3'];
const result = await mcpClient.callTool('DetectObjectTypeListArray', { objects });
```

## 🆘 Troubleshooting

### Connection Issues

**Problem:** Can't connect to MCP endpoint

**Solutions:**
1. Check endpoint URL is correct
2. Verify authentication token is valid
3. Check network connectivity
4. Test with `curl`:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
        https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)
   ```

### SAP Connection Issues

**Problem:** MCP connects but can't reach SAP

**Solutions:**
1. Verify SAP destination is configured
2. Check Cloud Connector (for on-premise)
3. Test SAP connection directly
4. Use ProbeDestination endpoint:
   ```bash
   curl "https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/ProbeDestination?destination=SAP_DEST"
   ```

### Token Issues

**Problem:** Authentication errors

**Solutions:**
1. Refresh XSUAA token
2. Verify token has required scopes
3. Check token expiration
4. Regenerate service key if needed

## 📚 Quick Reference

### Endpoints

- **SSE:** `GET /mcp/stream/sse`
- **Stream-HTTP:** `POST /mcp/stream/http`
- **Health:** `GET /odata/v4/mcp/Health()`
- **Probe:** `GET /odata/v4/mcp/ProbeDestination?destination=NAME`

### Required Headers

- `Authorization: Bearer <XSUAA_TOKEN>` - MCP authentication
- `X-SAP-Destination: <NAME>` - Destination mode
- OR `X-SAP-URL: <URL>` - Direct mode

### MCP Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ToolName",
    "arguments": {}
  }
}
```

## 🎉 Next Steps

1. **Try it:** Follow [Quick Setup Guide](./QUICK_SETUP.md)
2. **Integrate:** See [Integration Examples](./INTEGRATIONS.md)
3. **Configure:** Read [Configuration Guide](./MCP_CONFIG_UPDATE_HOWTO.md)
4. **Explore:** Check [API Reference](./MCP_PROXY_USAGE.md)

## 💬 Need Help?

- **Documentation:** Browse `docs/` folder
- **Examples:** See `docs/examples/`
- **Templates:** Use `docs/templates/mcp-config/`
- **Issues:** Open a GitHub issue

---

**Happy automating!** 🚀

