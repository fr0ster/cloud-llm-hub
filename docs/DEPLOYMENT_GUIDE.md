# Deployment Guide

## Prerequisites

- SAP BTP account with Cloud Foundry environment
- CF CLI installed and logged in
- MTA Build Tool (`mbt`) installed
- Node.js >= 18.0.0

## Quick Deployment

### 1. Build the Application

```bash
# Install dependencies
npm install

# Build CAP project
npx cds build --production

# Build MTA archive
mbt build
```

### 2. Deploy to BTP

```bash
# Deploy MTA archive
cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
```

The MTA deployment will automatically:
- Create and bind XSUAA service (`cloud-llm-hub-auth`)
- Create and bind Destination service (`cloud-llm-hub-destination`)
- Create and bind Connectivity service (`cloud-llm-hub-connectivity`)
- Create and bind SAP AI Core service (`cloud-llm-hub-ai-core`)
- Deploy the CAP service application

### 3. Update default-env.json for Local Development

After deployment, update your local `default-env.json` with service bindings from BTP:

```bash
# Update default-env.json with VCAP_SERVICES from deployed app
node tools/update-default-env.js
```

Or specify a different app name:

```bash
node tools/update-default-env.js cloud-llm-hub-srv
```

This script will:
- Fetch `VCAP_SERVICES` from the deployed app
- Update `default-env.json` with all service bindings
- Show summary of updated services (XSUAA, Destination, Connectivity, SAP AI Core)

## Verification

### Check Deployment Status

```bash
# List deployed apps
cf apps

# Check service bindings
cf services

# View app environment
cf env cloud-llm-hub-srv
```

### Test Health Endpoints

```bash
# Get XSUAA token
TOKEN=$(cf oauth-token)

# Test MCP health
curl -H "Authorization: Bearer $TOKEN" \
  https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com/odata/v4/mcp/Health()

# Test Agent health
curl -H "Authorization: Bearer $TOKEN" \
  -H "X-SAP-Core-AI-Model: gpt-4o-mini" \
  https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com/odata/v4/agent/Health()
```

## Post-Deployment Configuration

### SAP AI Core Configuration

1. **Configure Models in SAP AI Core Launchpad:**
   - Access SAP AI Core Launchpad
   - Configure which LLM providers are available (OpenAI, Anthropic, DeepSeek)
   - Set up model routing

2. **Optional: Create Destination for AI Core:**
   - If you want to use a destination instead of service binding:
   - Create destination in Destination service pointing to your AI Core instance
   - Set `SAP_CORE_AI_DESTINATION` environment variable:
     ```bash
     cf set-env cloud-llm-hub-srv SAP_CORE_AI_DESTINATION SAP_AI_CORE_DEST
     cf restage cloud-llm-hub-srv
     ```

### Environment Variables (Optional)

```bash
# Optional: AI Core configuration
cf set-env cloud-llm-hub-srv SAP_CORE_AI_MODEL gpt-4o-mini
cf set-env cloud-llm-hub-srv SAP_CORE_AI_TEMPERATURE 0.7
cf set-env cloud-llm-hub-srv SAP_CORE_AI_MAX_TOKENS 2000

# Restage to apply
cf restage cloud-llm-hub-srv
```

## Troubleshooting

### Service Binding Issues

If services are not bound correctly:

```bash
# Check service instances
cf services

# Check bindings
cf service cloud-llm-hub-ai-core
cf service cloud-llm-hub-destination
cf service cloud-llm-hub-connectivity
cf service cloud-llm-hub-auth

# View app logs
cf logs cloud-llm-hub-srv --recent
```

### Update default-env.json After Service Changes

If you update service bindings or recreate services:

```bash
# Re-fetch VCAP_SERVICES
node tools/update-default-env.js

# Verify updated services
cat default-env.json | jq '.VCAP_SERVICES | keys'
```

## Local Development with default-env.json

After updating `default-env.json`, you can run the app locally with the same service bindings:

```bash
# Start CAP service
cds watch
```

The app will use service bindings from `default-env.json` for:
- XSUAA authentication
- Destination service
- Connectivity service
- SAP AI Core service

## Next Steps

- [AGENT_TESTING_AFTER_DEPLOYMENT.md](AGENT_TESTING_AFTER_DEPLOYMENT.md) - Test the deployed agent
- [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) - Complete deployment checklist
- [MCP_PROXY_USAGE.md](MCP_PROXY_USAGE.md) - MCP proxy usage guide

