# Deployment Guide

## Prerequisites

- BTP subaccount with Cloud Foundry runtime
- cloud-llm-hub deployed and running in the same (or accessible) subaccount
- `cf` CLI and `mbt` build tool installed
- Node.js 20+

## Step 1: Create BTP Destination for cloud-llm-hub

In BTP Cockpit → Connectivity → Destinations, create a destination:

| Field | Value |
|-------|-------|
| Name | `CLOUD_LLM_HUB` |
| Type | HTTP |
| URL | `https://<cloud-llm-hub-srv>.cfapps.<region>.hana.ondemand.com` |
| Proxy Type | Internet |
| Authentication | OAuth2JWTBearer (same subaccount) or OAuth2ClientCredentials (cross-subaccount) |
| Token Service URL | `https://<xsuaa>.authentication.<region>.hana.ondemand.com/oauth/token` |
| Client ID | From cloud-llm-hub XSUAA service key |
| Client Secret | From cloud-llm-hub XSUAA service key |

If both services are in the same subaccount and CF space, you can use `NoAuthentication` for simplicity.

## Step 2: Configure Deployment Parameters

```bash
cp .mtaext.example .mtaext
```

Edit `.mtaext`:

```yaml
_schema-version: '3.3.0'
ID: calm-dump-analyzer-deploy
extends: calm-dump-analyzer
version: 1.0.0

parameters:
  CLOUD_LLM_HUB_DESTINATION: "CLOUD_LLM_HUB"
  SAP_DESTINATION: "S4HANA_E19"
```

- `CLOUD_LLM_HUB_DESTINATION` — the BTP Destination created in Step 1
- `SAP_DESTINATION` — the SAP system destination (passed to cloud-llm-hub as `x-sap-destination` header so the SmartAgent knows which system to analyze)

## Step 3: Build and Deploy

```bash
npm install
cds build --production
npx mbt build
cf deploy mta_archives/calm-dump-analyzer_1.0.0.mtar -e .mtaext
```

## Step 4: Verify

```bash
# Get the service URL
cf app calm-dump-analyzer-srv | grep routes

# Health check
curl https://<service-url>/analyzer/Health()

# Test with sample payload
curl -X POST https://<service-url>/odata/v4/analyzer/AnalyzeDump \
  -H "Content-Type: application/json" \
  -d "{\"event\": $(cat test-payload.json | jq -c '.' | jq -Rs '.')}"
```

## Memory and Scaling

The service is stateless and lightweight:
- Default: 128MB memory, 1 instance
- Each request makes one HTTP call to cloud-llm-hub
- Response time depends on cloud-llm-hub (typically 5-30 seconds for dump analysis)
- For high throughput, increase instances in `mta.yaml`

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| 502 from cloud-llm-hub | Destination misconfigured | Check destination URL and auth in BTP Cockpit |
| Empty analysis | cloud-llm-hub can't reach SAP system | Check SAP_DESTINATION in cloud-llm-hub's ListDestinations() |
| Timeout | Dump analysis takes long | Increase CF route timeout or use smaller LLM model |
| 401 Unauthorized | XSUAA token issue | Check destination auth config, service key validity |
