# Deployment Checklist

## Pre-Deployment Verification

### ✅ Build Artifacts
- [x] `mta.yaml` exists and configured
- [x] `xs-security.json` exists with required scopes
- [x] `app/router/xs-app.json` configured
- [x] Build scripts (`copy-mcp-submodule.js`) ready

### ✅ Service Bindings Required

The application requires the following Cloud Foundry service bindings with specific tags:

1. **XSUAA** (`tag: xsuaa`)
   - Service name: `cloud-llm-hub-auth`
   - Configured in `mta.yaml` resources section
   - Used for: User authentication and authorization

2. **Destination** (`tag: destination`)
   - Service name: `cloud-llm-hub-destination`
   - Configured in `mta.yaml` resources section
   - **CRITICAL**: Must have `tag: "destination"` in service binding
   - Used for: SAP destination resolution for ABAP connections

3. **Connectivity** (optional, `tag: connectivity`)
   - Required only for on-premise destinations
   - **CRITICAL**: Must have `tag: "connectivity"` in service binding
   - Used for: On-premise connectivity via Cloud Connector

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

## Build Process

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build submodule:**
   ```bash
   npm ci --prefix submodules/mcp-abap-adt
   npm run build --prefix submodules/mcp-abap-adt
   ```

3. **Build CAP project:**
   ```bash
   npx cds build --production
   ```

4. **Copy submodule:**
   ```bash
   node scripts/copy-mcp-submodule.js
   ```

5. **Build MTA:**
   ```bash
   mbt build
   ```

## Deployment Steps

1. **Deploy MTA:**
   ```bash
   cf deploy mta_archives/cloud-llm-hub.mtar
   ```

2. **Verify services:**
   ```bash
   cf services
   cf service cloud-llm-hub-auth
   cf service cloud-llm-hub-destination
   ```

3. **Check application status:**
   ```bash
   cf apps
   cf logs cloud-llm-hub-srv --recent
   ```

4. **Test health endpoint:**
   ```bash
   curl https://cloud-llm-hub-srv.cfapps.<region>.hana.ondemand.com/mcp/Health
   ```

## Post-Deployment Verification

### Test Destination Probe Endpoint

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

### For Hybrid Debugging (Development Only!)

```bash
cf set-env cloud-llm-hub-srv NODE_OPTIONS "--inspect=0.0.0.0:9229"
cf set-env cloud-llm-hub-srv DEBUG "*"
cf restage cloud-llm-hub-srv
```

**Warning:** Never enable debugging in production!

## Testing Checklist

- [ ] Health endpoint responds: `/mcp/Health`
- [ ] SSE endpoint accessible: `/mcp/stream/sse`
- [ ] Stream-HTTP endpoint accessible: `/mcp/stream/http`
- [ ] Destination probe works: `/mcp/destination/probe?destination=XXX`
- [ ] Authentication required for all endpoints
- [ ] XSUAA token validation works
- [ ] Destination resolution works
- [ ] On-premise connectivity works (if applicable)

