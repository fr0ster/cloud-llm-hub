# ⚡ Quick Setup Guide

**Get started in 60 seconds!** This is the fastest way to connect your tools to SAP via Cloud LLM Hub.

## 🎯 One-Command Setup

### For Cline (VS Code)

```bash
# Download and run setup
curl -sSL https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js | \
  node - --template cloud-destination \
    --connection sap-dev \
    --mcp-app cloud-llm-hub \
    --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
    --service-key-file sapAbap=./keys/sap-abap.json
```

**What it does:**
1. Downloads the setup tool
2. Generates Cline configuration
3. Updates your Cline settings automatically
4. Ready to use!

**Restart VS Code** and Cline will connect automatically.

---

## 🚀 Deployment Options

### Option 1: Use Existing Deployment (Fastest)

If you have a Cloud LLM Hub deployment:

```bash
# Just configure your client
export MCP_ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com"
export MCP_TOKEN="your-xsuaa-token"
export SAP_DEST="SAP_DEV_DEST"
```

### Option 2: Deploy to SAP BTP

```bash
# Clone and deploy
git clone https://github.com/fr0ster/cloud-llm-hub.git
cd cloud-llm-hub
npm install

# Deploy (requires CF CLI and login)
npm run deploy
```

**Time:** ~5 minutes

---

## 📋 Configuration Checklist

### ✅ Prerequisites

- [ ] SAP BTP account (or use existing deployment)
- [ ] SAP system access (direct URL or Destination)
- [ ] XSUAA service instance (for authentication)
- [ ] Destination service instance (for destination mode)

### ✅ Quick Configuration

1. **Get Service Keys:**
   ```bash
   cf service-key cloud-llm-hub-auth mcp > keys/mcp-xsuaa.json
   cf service-key sap-abap-backend abap > keys/sap-abap.json
   ```

2. **Generate Configuration:**
   ```bash
   node tools/update-cline-connection.js \
     --template cloud-destination \
     --connection my-sap-system \
     --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
     --service-key-file sapAbap=./keys/sap-abap.json
   ```

3. **Verify Connection:**
   ```bash
   curl -H "Authorization: Bearer $(jq -r .access_token keys/mcp-xsuaa.json)" \
        https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)
   ```

---

## 🎨 Template Quick Start

### Cloud with Destination (Recommended)

```bash
node tools/update-cline-connection.js \
  --template cloud-destination \
  --connection sap-prod \
  --mcp-app cloud-llm-hub \
  --destination-name SAP_PROD_DEST \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json
```

### Direct Connection (Local Dev)

```bash
node tools/update-cline-connection.js \
  --template direct-jwt \
  --connection sap-dev \
  --mcp-endpoint http://localhost:4004/mcp/stream/http \
  --service-key-file sapAbapXsuaa=./keys/sap-abap.json
```

### Basic Auth (Testing)

```bash
node tools/update-cline-connection.js \
  --template direct-basic \
  --connection sap-test \
  --mcp-endpoint http://localhost:4004/mcp/stream/sse \
  --mcp-username alice \
  --mcp-password "" \
  --sap-username developer \
  --sap-password "change-me"
```

---

## 🔧 Environment Variables

Quick setup via environment variables:

```bash
export MCP_ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com"
export MCP_XSUAA_TOKEN="your-token"
export SAP_DESTINATION="SAP_DEV_DEST"

# Or for direct mode
export SAP_URL="https://your-sap-system.com"
export SAP_CLIENT="210"
export SAP_JWT_TOKEN="your-sap-token"
```

---

## 📱 Client-Specific Quick Starts

### Cline (VS Code)

```bash
# One command setup
node tools/update-cline-connection.js --template cloud-destination \
  --connection sap-dev --mcp-app cloud-llm-hub \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
  --service-key-file sapAbap=./keys/sap-abap.json
```

### Claude Desktop

1. Download config template:
   ```bash
   curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/docs/templates/mcp-config/cloud-destination.yaml
   ```

2. Fill in your values
3. Convert to Claude Desktop format
4. Add to Claude Desktop settings

### n8n / Zapier / Make.com

Use HTTP Request nodes with:
- **URL:** Your MCP endpoint
- **Headers:** Authorization + X-SAP-Destination
- **Body:** MCP JSON-RPC format

See [INTEGRATIONS.md](./INTEGRATIONS.md) for details.

---

## 🧪 Test Your Setup

```bash
# Health check
curl -H "Authorization: Bearer $MCP_TOKEN" \
     https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)

# Test MCP call
curl -X POST https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "X-SAP-Destination: $SAP_DEST" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "GetObjectList",
      "arguments": {"objectType": "CLAS"}
    }
  }'
```

---

## 🎉 Success Checklist

- [ ] MCP endpoint accessible
- [ ] Authentication working
- [ ] SAP connection established
- [ ] Can call MCP tools
- [ ] Client configured and connected

**All checked?** You're ready to go! 🚀

---

## 📚 Next Steps

- **Integration Examples:** [INTEGRATIONS.md](./INTEGRATIONS.md)
- **Detailed Setup:** [GETTING_STARTED.md](./GETTING_STARTED.md)
- **Configuration Guide:** [MCP_CONFIG_UPDATE_HOWTO.md](./MCP_CONFIG_UPDATE_HOWTO.md)
- **API Reference:** [MCP_PROXY_USAGE.md](./MCP_PROXY_USAGE.md)

---

**Need help?** Check the documentation or open an issue!

