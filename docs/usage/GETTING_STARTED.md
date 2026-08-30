# 🚀 Getting Started with Cloud LLM Hub

**Version:** 2.2.0
**Last Updated:** 2026-03-25

**Welcome!** This guide will get you up and running with Cloud LLM Hub in **under 5 minutes**. Whether you're integrating with Cline, Claude Desktop, n8n, or building custom automations, we've got you covered.

## Why Cloud LLM Hub?

✅ **Zero Configuration** - Works out of the box with your existing SAP systems  
✅ **Stream-HTTP Transport** - Streamable HTTP support  
✅ **Enterprise Ready** - Built on SAP CAP with XSUAA authentication  
✅ **On-Premise Support** - Seamless Cloud Connector integration  
✅ **Automation Tools** - One-command setup scripts  
✅ **CI/CD Ready** - YAML-driven configuration and deployment

## 🎯 Quick Start (3 Steps)

### Step 1: Deploy to SAP BTP (or use existing deployment)

```bash
# Clone and deploy
git clone https://github.com/fr0ster/cloud-llm-hub.git
cd cloud-llm-hub
npm install
npm run deploy  # or follow docs/DEPLOYMENT_CHECKLIST.md
```

**Already have a deployment?** Just note your app URL: `https://your-app.cfapps.eu10.hana.ondemand.com`

**Configure the LLM provider** by setting the `LLM_AGENT_PROVIDER` environment variable. Supported values: `sap-ai-sdk` (default, SAP AI Core), `openai` (any OpenAI-compatible API), `anthropic`, `deepseek`. For non-SAP providers, also set `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL`.

### Step 2: Get Your API Key

Open the **Token page** at `https://your-app.cfapps.eu10.hana.ondemand.com/chat/webapp/token.html` to generate a personal JWT token (valid for 7 days). Use this token as the `Authorization: Bearer <token>` header in all API calls.

### Step 3: Get Your Connection Configuration

Choose your integration method:

#### Option A: Automated Setup (Recommended)

```bash
# Download the setup tool
curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js

# Generate configuration for Cline
node update-cline-connection.js --template cloud-destination \
  --connection my-sap-system \
  --mcp-app cloud-llm-hub \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
  --service-key-file sapAbap=./keys/sap-abap.json
```

#### Option B: Manual Configuration

Copy the template from `docs/templates/mcp-config/` and fill in your values.

### Step 4: Connect Your Client

**For Cline (VS Code):**

```json
{
  "mcpServers": {
    "sap-system": {
      "url": "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
      "type": "streamableHttp",
      "headers": {
        "Authorization": "Bearer YOUR_XSUAA_TOKEN",
        "X-SAP-Destination": "SAP_ABAP_DESTINATION"
      }
    }
  }
}
```

**For Claude Desktop:**

Use a client configuration that supports Stream-HTTP and points to
`https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http`.

**That's it!** You're now connected to your SAP ABAP system via MCP.

## 🎨 Common Use Cases

### 1. **Cline Integration** (VS Code)

Perfect for AI-assisted ABAP development.

**Benefits:**

- Ask questions about your ABAP codebase
- Generate code from natural language
- Analyze dependencies and impacts
- Refactor suggestions with context

**Setup:** See [Cline Integration Guide](#cline-integration)

### 2. **CI/CD Pipelines**

Automate SAP deployments and code analysis.

**Benefits:**

- Automated code reviews
- Dependency checks before merge
- Impact analysis for changes
- Automated documentation generation

**Setup:** See [CI/CD Integration](#cicd-integration)

### 3. **Workflow Automation (n8n, Zapier)**

Connect SAP to your automation stack.

**Benefits:**

- Trigger workflows from SAP events
- Sync data between systems
- Automated reporting
- Error handling and notifications

**Setup:** See [n8n Integration](#n8n-integration)

### 4. **Custom Applications**

Build your own MCP-powered tools.

**Benefits:**

- RESTful API access
- Streaming support (Stream-HTTP)
- Standard MCP protocol
- Enterprise authentication

**Setup:** See [API Integration](#api-integration)

## 🔧 Integration Guides

### Cline Integration

**Prerequisites:**

- VS Code with Cline extension installed
- SAP BTP deployment (or local dev server)

**Quick Setup:**

```bash
# 1. Generate Cline configuration
node tools/update-cline-connection.js \
  --template cloud-destination \
  --connection sap-dev \
  --mcp-app cloud-llm-hub \
  --service-key-file mcpXsuaa=./service-keys/mcp-xsuaa.json \
  --service-key-file sapAbap=./service-keys/sap-abap.json

# 2. Copy generated config to Cline settings
# The script automatically updates ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json

# 3. Restart VS Code
# Cline will automatically connect to your SAP system
```

**Features:**

- ✅ Automatic token refresh
- ✅ Multiple connection support
- ✅ YAML-driven configuration
- ✅ One-command updates

### CI/CD Integration

**GitHub Actions Example:**

```yaml
name: SAP Code Analysis
on: [pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Download MCP Tool
        run: |
          curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js

      - name: Configure Connection
        run: |
          node update-cline-connection.js \
            --connection sap-ci \
            --settings .github/.cline-settings.json \
            --sap-token ${{ secrets.SAP_JWT_TOKEN }} \
            --mcp-token ${{ secrets.MCP_XSUAA_TOKEN }}
        env:
          SAP_JWT_TOKEN: ${{ secrets.SAP_JWT_TOKEN }}
          MCP_XSUAA_TOKEN: ${{ secrets.MCP_XSUAA_TOKEN }}

      - name: Run Code Analysis
        run: |
          # Your custom analysis script using MCP
          node scripts/analyze-changes.js
```

**GitLab CI Example:**

```yaml
analyze:
  stage: test
  image: node:20
  script:
    - curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js
    - |
      node update-cline-connection.js \
        --connection sap-ci \
        --sap-token $SAP_JWT_TOKEN \
        --mcp-token $MCP_XSUAA_TOKEN
    - node scripts/analyze-changes.js
  variables:
    SAP_JWT_TOKEN: $SAP_JWT_TOKEN
    MCP_XSUAA_TOKEN: $MCP_XSUAA_TOKEN
```

**Benefits:**

- ✅ Automated code reviews
- ✅ Pre-merge validation
- ✅ Impact analysis
- ✅ Documentation generation

### n8n Integration

**HTTP Request Node Configuration:**

1. **Create HTTP Request Node:**
   - Method: `POST`
   - URL: `https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http`
   - Headers:
     ```json
     {
       "Authorization": "Bearer {{ $env.MCP_XSUAA_TOKEN }}",
       "X-SAP-Destination": "SAP_ABAP_DESTINATION",
       "Content-Type": "application/json"
     }
     ```

2. **MCP Request Body:**

   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "GetObjectList",
       "arguments": {
         "objectType": "CLAS",
         "package": "Z_MY_PACKAGE"
       }
     }
   }
   ```

3. **Response Handling:**
   - Parse JSON response
   - Extract `result` field
   - Use in subsequent nodes

**Workflow Example:**

```
Trigger → HTTP Request (MCP) → Process Results → Send Notification
```

**Benefits:**

- ✅ Visual workflow builder
- ✅ No-code integration
- ✅ Error handling built-in
- ✅ Scheduled execution

### API Integration

**Direct Stream-HTTP Access:**

**Stream-HTTP Example:**

```javascript
const response = await fetch('https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer YOUR_TOKEN',
    'X-SAP-Destination': 'SAP_ABAP_DESTINATION',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'GetObjectList',
      arguments: { objectType: 'CLAS' },
    },
  }),
});

const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log('Chunk:', new TextDecoder().decode(value));
}
```

## 🎛️ Chat UI & Destination Switching *(v2.2+)*

Cloud LLM Hub includes a built-in chat webapp at `/chat/webapp/index.html` with:

- **Model selector** — switch between LLM models (Claude, GPT, DeepSeek) at runtime
- **Destination selector** — switch between discovered SAP systems with live status:
  - **✓ ready** — destination vectorized, tools available
  - **⏳ vectorizing** — tool embeddings being created
  - **• pending** — queued for vectorization
  - **✗ error** — vectorization failed

### OpenAI-Compatible API

Use the `/v1/chat/completions` endpoint with any OpenAI-compatible client:

```bash
curl -X POST "https://your-app.cfapps.eu10.hana.ondemand.com/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: S4HANA_DEV" \
  -d '{
    "model": "anthropic--claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "List classes in package Z_MY_PKG"}],
    "stream": true
  }'
```

### Discover Available Destinations

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     "https://your-app.cfapps.eu10.hana.ondemand.com/v1/models"
```

The response includes `_destinations` array with status and tool counts for each SAP system.

### Destination Mapping

You can map short system codes to BTP destination names so clients use a friendly alias instead of the full destination name. Configure destination mapping in your deployment settings so that `X-SAP-Destination: dev` resolves to the actual BTP destination (e.g., `S4HANA_DEV`).

---

## 🛠️ Available Tools

Cloud LLM Hub provides access to all MCP tools from the underlying ABAP ADT server:

- **Code Analysis:** `GetObjectList`, `GetObjectDetails`, `GetObjectSource`
- **Dependency Analysis:** `GetDependencies`, `GetWhereUsed`
- **Enhancement Discovery:** `GetEnhancements`, `GetEnhancementByName`
- **Include Management:** `GetIncludesList`
- **Batch Operations:** `DetectObjectTypeListArray`, `DetectObjectTypeListJson`

**Full list:** See the ABAP ADT MCP server documentation for `@mcp-abap-adt/core`.

## 📚 Next Steps

1. **Explore Templates:** Check `docs/templates/mcp-config/` for ready-to-use configurations
2. **Test Integration:** Use `npm test` to verify your setup

## 🆘 Need Help?

- **Documentation:** Check `docs/` folder for detailed guides
- **Examples:** See `docs/examples/` for configuration samples
- **Templates:** Use `docs/templates/mcp-config/` for quick starts
- **Issues:** Open an issue on GitHub

## 🎉 You're All Set!

You now have:

- ✅ A working MCP connection to your SAP system
- ✅ Tools to automate configuration
- ✅ Examples for common integrations
- ✅ CI/CD ready setup

**Happy automating!** 🚀
