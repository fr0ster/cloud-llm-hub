# Deployment Checklist

## Pre-Deployment Checklist

### Artifacts & Config
- [ ] `mta.yaml` present and correctly configured
- [ ] `xs-security.json` present with required scopes/roles
- [ ] `app/router/xs-app.json` routes configured
- [ ] Build script `tools/copy-mcp-submodule.js` available

### Required Services & Tags (CF/BTP)
- [ ] XSUAA service instance `cloud-llm-hub-auth` defined in `mta.yaml`
- [ ] Destination service instance `cloud-llm-hub-destination` defined in `mta.yaml`
- [ ] Destination binding has tag `destination`
- [ ] Connectivity service (only if on‑prem) instance defined in `mta.yaml`
- [ ] Connectivity binding has tag `connectivity` (only if on‑prem)

### ⚠️ Important Notes

**Service Tags:**
When deploying manually (not via MTA), ensure service bindings have correct tags:

```bash
# Create destination service
cf create-service destination lite cloud-llm-hub-destination

# Bind with tag
cf bind-service cloud-llm-hub-srv cloud-llm-hub-destination \
  -c '{"tags": ["destination"]}'

# Create connectivity service (if needed)
cf create-service connectivity connectivity_standard cloud-llm-hub-connectivity

# Bind with tag
cf bind-service cloud-llm-hub-srv cloud-llm-hub-connectivity \
  -c '{"tags": ["connectivity"]}'
```

**MTA Deployment:**
MTA should automatically handle service creation and binding. Verify tags after deployment:

```bash
cf env cloud-llm-hub-srv | grep -A 5 destination
cf env cloud-llm-hub-srv | grep -A 5 connectivity
```

## Build Checklist

- [ ] Install dependencies
  ```bash
  npm install
  ```
- [ ] Build submodule `submodules/mcp-abap-adt`
  ```bash
  npm ci --prefix submodules/mcp-abap-adt
  npm run build --prefix submodules/mcp-abap-adt
  ```
- [ ] Build CAP project
  ```bash
  npx cds build --production
  ```
- [ ] Copy submodule build into deployment folder
  ```bash
  node tools/copy-mcp-submodule.js
  ```
- [ ] Build MTA archive
  ```bash
  mbt build
  ```

## Deployment Checklist

- [ ] Deploy MTA
  ```bash
  cf deploy mta_archives/cloud-llm-hub.mtar
  ```
- [ ] Verify services exist and bound
  ```bash
  cf services
  cf service cloud-llm-hub-auth
  cf service cloud-llm-hub-destination
  ```
- [ ] Check application status and recent logs
  ```bash
  cf apps
  cf logs cloud-llm-hub-srv --recent
  ```
- [ ] Health endpoint responds OK
  ```bash
  curl https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com/mcp/Health
  ```

## Post-Deployment Verification

### Destination Probe Endpoint

```bash
# Get XSUAA token first
TOKEN=$(cf oauth-token)

# Test probe endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com/mcp/destination/probe?destination=YOUR_DESTINATION"
```

Or use the test script:
```bash
./test/smoke/test-destination-probe.sh \
  https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com \
  YOUR_DESTINATION \
  "Bearer $TOKEN"
```

### Expected Response

```json
{
  "destination": "YOUR_DESTINATION",
  "connectivity": "internet",
  "proxyType": "Internet",
  "authentication": "BasicAuthentication",
  "sapClient": "100",
  "cloudConnectorLocationId": null,
  "tokenExpiresAt": null,
  "probe": {
    "status": 200,
    "statusText": "OK",
    "contentType": "application/xml"
  },
  "timestamp": "2025-01-XX..."
}
```

## Troubleshooting

### Destination Service Not Found

**Error:** `Destination service binding with tag "destination" is required`

**Solution:**
1. Verify service exists: `cf services`
2. Check binding: `cf service cloud-llm-hub-destination`
3. Verify tags in VCAP_SERVICES: `cf env cloud-llm-hub-srv | grep -A 10 destination`
4. Re-bind with explicit tag if needed

### Connectivity Service Not Found (On-Premise)

**Error:** `Connectivity service binding with tag "connectivity" is required for on-premise destinations`

**Solution:**
1. Create connectivity service (if not exists)
2. Bind with tag: `connectivity`
3. Restage application: `cf restage cloud-llm-hub-srv`

### Probe Returns 502

**Possible causes:**
- Destination configuration missing in BTP
- Invalid credentials in destination
- Network connectivity issues
- Cloud Connector not configured (for on-premise)

**Debug:**
1. Check application logs: `cf logs cloud-llm-hub-srv --recent`
2. Verify destination in BTP Cockpit
3. Test destination connectivity manually

## Environment Variables

### LLM Provider API Keys

**Important:** API keys should NOT be stored in `mta.yaml` for security reasons.

**After deployment, set LLM provider API keys:**

**Option 1: Using npm script with .env file (recommended - simplest):**
```bash
# 1. Copy .env from agent (this is the agent's .env file)
cp submodules/llm-agent/.env .env

# 2. Edit .env and ensure LLM_PROVIDER is set (e.g., LLM_PROVIDER=openai)

# 3. Run script - it reads from .env automatically
npm run deploy:set-env
```

**Note:** The `.env` file in project root is the same as the agent's `.env` file. Copy it from agent: `cp submodules/llm-agent/.env .env`

**Option 2: Using npm script with exported variables:**
```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
export OPENAI_MODEL="gpt-4o-mini"
npm run deploy:set-env
```

**Option 3: Direct CF CLI (if you prefer manual control):**
```bash
# Export variables
export OPENAI_API_KEY="sk-proj-your-key-here"
export OPENAI_MODEL="gpt-4o-mini"

# Set in CF
cf set-env cloud-llm-hub-srv OPENAI_API_KEY "$OPENAI_API_KEY"
cf set-env cloud-llm-hub-srv OPENAI_MODEL "$OPENAI_MODEL"
cf set-env cloud-llm-hub-srv OPENAI_ORG "$OPENAI_ORG"  # optional
cf set-env cloud-llm-hub-srv OPENAI_PROJECT "$OPENAI_PROJECT"  # optional
cf restage cloud-llm-hub-srv

# For Anthropic
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
cf set-env cloud-llm-hub-srv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
cf set-env cloud-llm-hub-srv LLM_PROVIDER "anthropic"
cf restage cloud-llm-hub-srv

# For DeepSeek
export DEEPSEEK_API_KEY="sk-your-key-here"
cf set-env cloud-llm-hub-srv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
cf set-env cloud-llm-hub-srv LLM_PROVIDER "deepseek"
cf restage cloud-llm-hub-srv
```

**Why use the script?**
- ✅ Reads from `.env` file automatically (no need to export)
- ✅ Sets all variables at once
- ✅ Validates CF CLI and app existence
- ✅ Automatically restages the app

**Verify environment variables:**
```bash
cf env cloud-llm-hub-srv
```

### For Hybrid Debugging (Development Only!)

```bash
cf set-env cloud-llm-hub-srv NODE_OPTIONS "--inspect=0.0.0.0:9229"
cf set-env cloud-llm-hub-srv DEBUG "*"
cf restage cloud-llm-hub-srv
```

**Warning:** Never enable debugging in production!

## Local/Hybrid Checklist (default-env.json)

- [ ] Update `default-env.json` with fresh `VCAP_SERVICES` after each deploy or service change
  ```bash
  # View current env and copy the VCAP_SERVICES block
  cf env cloud-llm-hub-srv
  # Paste the updated VCAP_SERVICES JSON into default-env.json
  # {
  #   "VCAP_SERVICES": { ... }
  # }
  ```
- [ ] Ensure root app does not depend on submodule `.env` (only `default-env.json`)
- [ ] For stream-HTTP tests, set timeout via headers when needed:
  - `X-MCP-Timeout: <ms>`
  - `X-Request-Timeout: <ms>`

## Testing Checklist

- [ ] Health endpoint responds: `/odata/v4/mcp/Health()`
- [ ] SSE endpoint accessible: `/mcp/stream/sse`
- [ ] Stream-HTTP endpoint accessible: `/mcp/stream/http`
- [ ] Destination probe works: `/odata/v4/mcp/ProbeDestination?destination=XXX`
- [ ] Authentication required for all endpoints
- [ ] XSUAA token validation works
- [ ] Destination resolution works
- [ ] On-premise connectivity works (if applicable)

**Tip:** Run integration tests via `npm test` (requires `test/integration.yaml` config).

