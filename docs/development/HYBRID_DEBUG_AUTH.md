# Hybrid Debugging Authentication Issues

## Problem

When running hybrid debugging (local server + cloud services), authentication fails:
- ❌ Basic auth (mocked) doesn't work
- ❌ Bearer token (XSUAA) doesn't work
- ✅ Local with mocked auth works
- ✅ Cloud with XSUAA token works

## Root Cause

In hybrid debugging mode, the server runs with `--profile production`, which:
1. Uses real XSUAA authentication (not mocked)
2. Tries to convert Basic auth to Bearer token automatically
3. Requires `default-env.json` to be properly loaded with XSUAA credentials

## Solution

### Option 0: Verify XSUAA Service Key is in default-env.json

If you have a service key file (e.g., `mcp.json`), you can add it to `default-env.json`:

```bash
# Add XSUAA service key from mcp.json
node tools/add-xsuaa-service-key.js mcp.json

# Or verify it's already there
cat default-env.json | jq '.VCAP_SERVICES.xsuaa[0]'
```

### Option 1: Use Bearer Token (Recommended)

Get a valid XSUAA token and use it in requests:

```bash
# Get XSUAA token from default-env.json
XSUAA_URL=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url')
CLIENT_ID=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid')
CLIENT_SECRET=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret')

# Get token
TOKEN=$(curl -s -X POST "$XSUAA_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" | jq -r '.access_token')

# Use token in requests
curl -X GET "http://localhost:4004/odata/v4/mcp/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
```

### Option 2: Fix Basic Auth Conversion

The server automatically converts Basic auth to Bearer token in production mode. Check:

1. **Verify default-env.json is loaded:**
   ```bash
   # Check if VCAP_SERVICES is set
   node -e "console.log(process.env.VCAP_SERVICES ? 'SET' : 'NOT SET')"
   ```

2. **Check XSUAA credentials:**
   ```bash
   cat default-env.json | jq '.VCAP_SERVICES.xsuaa[0].credentials | {clientid, url}'
   ```

3. **Enable debug logging:**
   ```bash
   DEBUG=* cds watch --profile production
   ```

4. **Check server logs for:**
   - `🔄 convertBasicToBearer called`
   - `📡 Requesting OAuth token`
   - `✅ Successfully converted Basic auth to Bearer token`
   - Or errors like `⚠️ XSUAA credentials not found`

### Option 3: Use Development Profile with Real Services

Create a custom profile that uses mocked auth but real services:

1. **Create `.vscode/launch.json`:**
   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "type": "node",
         "request": "launch",
         "name": "cds watch (Hybrid - Mock Auth + Cloud Services)",
         "runtimeExecutable": "npx",
         "runtimeArgs": ["cds", "watch", "--profile", "development"],
         "console": "integratedTerminal",
         "env": {
           "NODE_OPTIONS": "--inspect=9229",
           "VCAP_SERVICES": "${workspaceFolder}/default-env.json"
         },
         "sourceMaps": true
       }
     ]
   }
   ```

2. **Modify `package.json` to allow mocked auth with real services:**
   ```json
   {
     "cds": {
       "requires": {
         "auth": {
           "[development]": {
             "kind": "mocked",
             "users": {
               "alice": {
                 "roles": ["MCP_Connector", "MCP_Admin"]
               }
             }
           }
         }
       }
     }
   }
   ```

## Troubleshooting

### Issue: XSUAA credentials not found

**Symptoms:**
- Log shows: `⚠️ XSUAA credentials not found, cannot convert Basic to Bearer`
- Requests fail with 401 Unauthorized

**Solution:**
1. Ensure `default-env.json` exists and contains XSUAA service:
   ```bash
   npm run update:env
   ```

2. Verify VCAP_SERVICES is loaded:
   ```bash
   # Check if CAP loads default-env.json
   node -e "const xsenv = require('@sap/xsenv'); console.log(JSON.stringify(xsenv.loadEnv(), null, 2))"
   ```

3. Manually set VCAP_SERVICES:
   ```bash
   export VCAP_SERVICES=$(cat default-env.json | jq -c '.VCAP_SERVICES')
   cds watch --profile production
   ```

### Issue: OAuth token request fails

**Symptoms:**
- Log shows: `❌ Failed to convert Basic auth to Bearer`
- OAuth token request returns 403 or 401

**Solution:**
1. Verify XSUAA credentials are correct:
   ```bash
   cat default-env.json | jq '.VCAP_SERVICES.xsuaa[0].credentials | {clientid, clientsecret, url}'
   ```

2. Test OAuth token request manually:
   ```bash
   XSUAA_URL=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url')
   CLIENT_ID=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid')
   CLIENT_SECRET=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret')
   
   curl -X POST "$XSUAA_URL/oauth/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -u "$CLIENT_ID:$CLIENT_SECRET" \
     -d "grant_type=client_credentials"
   ```

3. Check if service binding has required scopes in BTP Cockpit

### Issue: CAP doesn't load default-env.json

**Symptoms:**
- VCAP_SERVICES is not set
- Services are not found

**Solution:**
1. Ensure `@sap/xsenv` is installed:
   ```bash
   npm list @sap/xsenv
   ```

2. Manually load in `srv/server.ts` or use environment variable:
   ```bash
   # Load default-env.json manually
   export VCAP_SERVICES=$(cat default-env.json | jq -c '.VCAP_SERVICES')
   export VCAP_APPLICATION=$(cat default-env.json | jq -c '.VCAP_APPLICATION')
   ```

3. Or use `xsenv.loadEnv()` in code (already done in `destinationResolver.ts`)

## Recommended Workflow

1. **Start hybrid debugging:**
   ```bash
   NODE_OPTIONS="--inspect=9229" cds watch --profile production
   ```

2. **Get XSUAA token:**
   ```bash
   # Use the script or manual curl
   TOKEN=$(./tools/get-xsuaa-token.sh)
   ```

3. **Test with Bearer token:**
   ```bash
   curl -X GET "http://localhost:4004/odata/v4/mcp/Health()" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/json"
   ```

4. **Or use Basic auth (will be auto-converted):**
   ```bash
   curl -X GET "http://localhost:4004/odata/v4/mcp/Health()" \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Accept: application/json"
   ```

## Debugging Tips

1. **Enable verbose logging:**
   ```bash
   DEBUG=* cds watch --profile production
   ```

2. **Check server logs for:**
   - `🔄 convertBasicToBearer called`
   - `📡 Requesting OAuth token`
   - `✅ Successfully converted Basic auth to Bearer token`
   - `❌ Failed to convert Basic auth to Bearer`

3. **Verify VCAP_SERVICES:**
   ```bash
   node -e "const xsenv = require('@sap/xsenv'); const env = xsenv.loadEnv(); console.log('XSUAA:', !!env.VCAP_SERVICES?.xsuaa?.[0])"
   ```

4. **Test OAuth token manually:**
   ```bash
   # Use the token from Cline or get a new one
   # Then test with curl
   ```

## Related Documentation

- [Hybrid Debugging Setup](HYBRID_DEBUG_SETUP.md)
- [Quick Hybrid Setup](../QUICK_HYBRID_SETUP.md)
- [Debugging Guide](DEBUGGING.md)

