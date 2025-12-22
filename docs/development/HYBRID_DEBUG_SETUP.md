# Hybrid Debugging Setup for Cloud-Only Endpoints

This guide helps you set up hybrid debugging to test cloud-only endpoints (like SAP AI Core) locally.

## Overview

Hybrid debugging allows you to:
- Run the application locally (`cds watch`)
- Connect to real Cloud Foundry services (XSUAA, Destination, SAP AI Core) via `default-env.json`
- Test cloud-only endpoints locally without deploying

## Step-by-Step Setup

### Step 1: Deploy New Version to BTP

```bash
# 1. Build MTA archive
npx mbt build

# 2. Deploy (if you have mta-deploy.yaml configured)
npm run deploy

# Or deploy manually
cf deploy gen/mta_archives/cloud-llm-hub_*.mtar
```

### Step 2: Download Environment Variables from BTP

After deployment, download `VCAP_SERVICES` from the deployed app:

```bash
# Download environment variables
npm run update:env

# Or manually:
node tools/update-default-env.js cloud-llm-hub-srv
```

This script:
- Fetches `VCAP_SERVICES` from BTP using `cf env cloud-llm-hub-srv`
- Updates `default-env.json` with service bindings (XSUAA, Destination, SAP AI Core, etc.)

**Alternative: Add XSUAA Service Key Manually**

If you have a service key file (e.g., `mcp.json` from `cf service-key`), you can add it directly:

```bash
# Add XSUAA service key to default-env.json
node tools/add-xsuaa-service-key.js mcp.json

# Verify it was added
cat default-env.json | jq '.VCAP_SERVICES.xsuaa[0].name'
```

### Step 3: Verify default-env.json

Check that `default-env.json` contains:

```json
{
  "VCAP_SERVICES": {
    "xsuaa": [...],
    "destination": [...],
    "aicore": [...],  // SAP AI Core service binding
    "connectivity": [...]
  }
}
```

**Important:** The `aicore` service binding should include:
- `credentials.clientid`
- `credentials.clientsecret`
- `credentials.serviceurls.AI_API_URL`
- `credentials.url` (OAuth2 token URL)

### Step 4: Setup VS Code for Hybrid Debugging

Create `.vscode/launch.json` if it doesn't exist:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "cds watch (Hybrid - Local + Cloud Services)",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["cds", "watch", "--profile", "production"],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "skipFiles": ["<node_internals>/**"],
      "env": {
        "NODE_OPTIONS": "--inspect=9229"
      },
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/gen/**/*.js"]
    },
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Node (Port 9229)",
      "port": 9229,
      "restart": true,
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "${workspaceFolder}",
      "sourceMaps": true,
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

### Step 5: Start Hybrid Debugging

**Option A: Using VS Code**

1. Open VS Code
2. Go to Run and Debug (Ctrl+Shift+D)
3. Select "cds watch (Hybrid - Local + Cloud Services)"
4. Press F5
5. Set breakpoints in your code (e.g., `srv/agent-service.ts`)

**Option B: Manual Start**

```bash
# Start with inspector
NODE_OPTIONS="--inspect=9229" npx cds watch --profile production

# In another terminal, attach debugger
# Or use VS Code "Attach to Node (Port 9229)" configuration
```

### Step 6: Test Cloud-Only Endpoints

Once the server is running locally with hybrid debugging:

```bash
# Test Agent Health endpoint
curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Accept: application/json" | jq

# Test Agent Chat endpoint (uses SAP AI Core)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! Can you introduce yourself?"}' | jq
```

**Note:** 
- Authentication: In production profile, Basic auth is automatically converted to Bearer token using XSUAA from `default-env.json`
- For hybrid debugging with mocked auth, use `--profile development` instead
- SAP AI Core calls use real service binding credentials
- All cloud services are accessed via `default-env.json`

**Authentication Options:**

1. **Use Bearer Token (Recommended for production profile):**
   ```bash
   # Get XSUAA token
   ./tools/get-xsuaa-token.sh
   # Or manually:
   TOKEN=$(curl -s -X POST "$XSUAA_URL/oauth/token" \
     -u "$CLIENT_ID:$CLIENT_SECRET" \
     -d "grant_type=client_credentials" | jq -r '.access_token')
   
   # Use in requests
   curl -H "Authorization: Bearer $TOKEN" http://localhost:4004/odata/v4/mcp/Health()
   ```

2. **Use Basic Auth (Auto-converted in production profile):**
   ```bash
   # Basic auth will be automatically converted to Bearer token
   curl -H "Authorization: Basic YWxpY2U6" http://localhost:4004/odata/v4/mcp/Health()
   ```

3. **Use Development Profile (Mocked auth):**
   ```bash
   # Use development profile for mocked auth
   cds watch --profile development
   # Then use Basic auth (not converted)
   ```

## Troubleshooting

### Issue: SAP AI Core service binding not found

**Solution:**
```bash
# Re-download environment variables
npm run update:env

# Verify aicore service is in default-env.json
cat default-env.json | jq '.VCAP_SERVICES.aicore'
```

### Issue: OAuth2 token request fails (403)

**Possible causes:**
- Service binding credentials don't have required scopes
- OAuth2 endpoint URL is incorrect
- Service binding needs configuration in SAP AI Core Launchpad

**Check:**
```bash
# Verify service binding credentials
cat default-env.json | jq '.VCAP_SERVICES.aicore[0].credentials'
```

### Issue: API endpoint returns 404

**Possible causes:**
- Model not deployed in SAP AI Core Launchpad
- API endpoint path is incorrect (may need deployment ID)
- Base URL is incorrect for your region

**Check logs:**
```bash
# Check application logs for detailed error
# Look for "SAP Core AI API error" messages
```

### Issue: Breakpoints not hitting

**Solution:**
1. Ensure source maps are enabled in `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "sourceMap": true
     }
   }
   ```
2. Rebuild TypeScript:
   ```bash
   npm run build:fast
   ```
3. Restart debugger

## Workflow Summary

1. **Deploy** → `npm run deploy` or `cf deploy`
2. **Download env** → `npm run update:env`
3. **Start hybrid debug** → VS Code F5 or `NODE_OPTIONS="--inspect=9229" cds watch --profile production`
4. **Test endpoints** → Use curl or Postman with localhost:4004
5. **Debug** → Set breakpoints and step through code

## Next Steps

After verifying hybrid debugging works:
- Test all Agent endpoints locally
- Debug SAP AI Core integration issues
- Verify authentication flow
- Test error handling

