# MCP Proxy - Streaming Endpoints

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

CAP-based secure proxy for MCP (Model Command Protocol) with Stream-HTTP support.

## 🚀 Quick Start

### Development Mode

```bash
# Install dependencies
npm install

# Start in development mode (mock auth)
cds watch --profile development

# Or use the default task
npm start
```

The service will start on `http://localhost:4004`

### Production Mode

Requires XSUAA service binding on SAP BTP Cloud Foundry.

## 🔐 Authentication

### Development (Basic Auth)

Use Basic authentication with predefined users:

- **alice**: Full admin access (MCP_Connector + MCP_Admin)
- **bob**: Read-only access (MCP_Connector)

```bash
# alice credentials (empty password)
echo -n "alice:" | base64
# Output: YWxpY2U6

# bob credentials (empty password)
echo -n "bob:" | base64
# Output: Ym9iOg==
```

### Production (Bearer JWT)

Use valid XSUAA JWT token obtained via OAuth2 client credentials flow.

```bash
# Get access token
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

## 📡 Endpoints

## 🌐 BTP Connectivity (On-Premise Destinations)

When the proxy runs on SAP BTP and needs to reach an on-premise ABAP system via Cloud Connector, there are two supported options for supplying connection details:

1. **Preferred: let the Destination service drive the configuration.**

- Add the header `X-SAP-Destination: <destination-name>`.
- The proxy uses SAP Cloud SDK's `executeHttpRequest` to resolve the destination, which automatically:
  - Retrieves destination configuration from the Destination service
  - Handles authentication (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
  - Routes requests through the Connectivity proxy when `ProxyType=OnPremise`
  - Manages token lifecycle and refresh automatically
  - Propagates `CloudConnectorLocationId` for multi-tunnel scenarios
- Optionally include `X-SAP-Client` to override the `sap-client` maintained in the destination.

2. **Manual headers (fallback when destinations are unavailable).**

- `X-SAP-Connectivity-Mode: onprem` — enables the Connectivity integration.
- `X-SAP-Connectivity-Location-ID` (optional) — Cloud Connector location ID when multiple tunnels exist.
- `X-SAP-Connectivity-Auth` (optional) — bearer token for principal propagation (`SAP-Connectivity-Authentication`).

### Prerequisites

- Destination (`tag: destination`) and Connectivity (`tag: connectivity`) service instances must be bound to the application.
- The Connectivity service is configured in `mta.yaml` with `ConnectorID: AA45023094B911E8B0C6F0E30A06C478` for Cloud Connector integration.
- The destination stores ABAP system credentials using **Basic** or **OAuth2 Client Credentials**. For OAuth, SAP Cloud SDK's `executeHttpRequest` handles token acquisition and refresh automatically.
- No SAP credentials need to be provided in headers when a destination is used—SAP Cloud SDK fetches everything from the service binding and manages authentication transparently.

### Request examples

**Using a destination:**

```bash
curl -X POST \
  -H "Authorization: Bearer <xsuaa-token>" \
  -H "X-SAP-Destination: ERP-OnPrem" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @request.ndjson \
  https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/stream/http
```

**Manual Connectivity headers:**

```bash
curl -X POST \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Connectivity-Mode: onprem" \
  -H "X-SAP-Connectivity-Location-ID: EU10-A" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @request.ndjson \
  https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/stream/http
```

## 🚢 Deploying to SAP BTP via MTA

The project now ships with an `mta.yaml` descriptor and an optimized build process that streamline SAP BTP Cloud Foundry deployment.

1. **Build the MTA archive**

Using the provided npm script (recommended):
```bash
npm run build:mta
```
Or using the Cloud MTA Build Tool directly:
```bash
npx mbt build -t gen/mta_archives --mtar cloud-llm-hub.tar
```

2. **Deploy to Cloud Foundry**

Using the provided npm script (recommended):
```bash
npm run deploy
```
Or using the `cf deploy` command:
```bash
cf deploy gen/mta_archives/cloud-llm-hub.tar --abort-on-error --delete-services
```

### Build Optimization

The `mta.yaml` uses a custom builder to minimize the deployment size:
- Uses `npm ci --omit=dev` to exclude development dependencies.
- Removes source maps (`*.map`), markdown documentation (`*.md`), and `docs/` folders from `node_modules`.
- Cleans up development tools like `tsx` and `esbuild`.
- **Result:** The final MTA archive size is reduced to **~16MB**.

The descriptor provisions application modules (CAP service + approuter) and automatically creates and binds:

- **XSUAA service** (`cloud-llm-hub-auth`) for authentication and authorization
- **Destination service** (`cloud-llm-hub-destination`) for destination management
- **Connectivity service** (`cloud-llm-hub-connectivity`) with `ConnectorID: AA45023094B911E8B0C6F0E30A06C478` for on-premise connectivity via Cloud Connector

Adjust service plans or quotas inside `mta.yaml` before deploying to production landscapes.

### SSE Endpoint: `GET /mcp/stream/sse` (currently disabled)

The SSE transport is not available in the current build. Requests to this endpoint return `404`.
Use Stream-HTTP instead.

### Stream-HTTP Endpoint: `POST /mcp/stream/http`

Bidirectional streaming with NDJSON (Newline-Delimited JSON) format.

**Features:**

- Content-Type: `application/x-ndjson`
- Bidirectional streaming
- Backpressure control
- Event size limit: 1 MB
- 2-minute timeout

**Example with curl:**

```bash
# Send streaming request
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http <<EOF
{"command":"tools/list"}
{"command":"tools/call","params":{"name":"test"}}
EOF
```

**Example with Node.js:**

```javascript
const response = await fetch('http://localhost:4004/mcp/stream/http', {
  method: 'POST',
  headers: {
    Authorization: 'Basic YWxpY2U6',
    'Content-Type': 'application/x-ndjson',
  },
  body: JSON.stringify({ command: 'tools/list' }) + '\n',
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  console.log('Received:', chunk);
}
```

### Streamable HTTP Session Lifecycle

- The first request that initializes the MCP session **must omit** the `Mcp-Session-Id` header. The proxy will return a freshly generated session identifier in the response headers.
- All follow-up requests must echo that identifier via `Mcp-Session-Id`, otherwise the proxy interprets the call as a new initialization attempt and tears down the previous transport.
- Cline, Claude Desktop, and other Streamable HTTP clients automatically forward the header once they receive it; if you write a custom integration, capture the header returned by the proxy and attach it to every subsequent POST.
- To deliberately reset the session (for example, after rotating SAP credentials), drop the `Mcp-Session-Id` header or restart the proxy. The next request will negotiate a new session cleanly.
- The proxy creates MCP server instances per request (no server instance cache). The `Mcp-Session-Id` header is still required for Stream-HTTP session continuity.

## 🔧 Cline Integration

### Stream-HTTP Configuration (`cline.json`)

```json
{
  "type": "stream-http",
  "endpoint": "http://localhost:4004/mcp/stream/http",
  "headers": {
    "Authorization": "Basic YWxpY2U6",
    "Content-Type": "application/x-ndjson"
  }
}
```

### Production Configuration

```json
{
  "type": "stream-http",
  "endpoint": "https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/stream/http",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}",
    "Content-Type": "application/x-ndjson"
  }
}
```

## 🧪 Testing

### Refreshing Cline tokens

Use `tools/update-cline-connection.js` to keep `cline_mcp_settings.json` synchronized with the credentials you currently use.

#### Inside this repository

```bash
npm run update:cline -- --connection cloud-llm-hub

# Regenerate a SAP JWT via the helper tool and update the settings in one go
npm run update:cline -- \
  --connection cloud-llm-hub \
  --service-key path/to/service-key.json \
  --browser system
```

#### Standalone usage (copy just the script)

1. Download `tools/update-cline-connection.js` into any project (for example via `curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js`).
2. Run it with plain Node.js and point it to your Cline profile:

```bash
node update-cline-connection.js \
  --connection cloud-llm-hub \
  --settings ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json \
  --update all \
  --mcp-token <bearer-or-jwt-token> \
  --sap-token <sap-jwt-token>
```

Only the script is required—no other files from this repository. When no local ABAP `.env` is available, supply credentials explicitly by using `--sap-token` (or `--sap-username/--sap-password`) and the MCP headers via `--mcp-*` flags. Pass `--sap-auth-script <path>` if you keep `sap-abap-auth-browser.js` outside of the repository.

#### Helpful flags

- `--update sap|mcp|all` controls which side of the connection is touched.
- `--sap-auth-type`, `--sap-token`, `--sap-username`, `--sap-password` toggle JWT vs. basic authentication for the ABAP backend.
- `--mcp-auth-type`, `--mcp-token`, `--mcp-username`, `--mcp-password`, `--mcp-auth-header` set the authorization header Cline sends to the MCP proxy.
- `--sap-auth-script` defines the location of `sap-abap-auth-browser.js` when regenerating tokens from a service key without the git submodule present.
- `--dry-run` prints the changes without rewriting the settings file.

The script picks defaults for the Cline settings file and the ABAP `.env` automatically. If no local `.env` is found, you will be prompted to pass explicit values.

### Health Check

```bash
curl http://localhost:4004/mcp/Health
```

Expected response:

```json
{
  "status": "UP",
  "timestamp": "2025-10-29T12:00:00.000Z"
}
```

### Probe Destination

The `ProbeDestination` CAP function validates destination connectivity and configuration using SAP Cloud SDK's `executeHttpRequest`:

```bash
# Development mode
curl -H "Authorization: Basic YWxpY2U6" \
  "http://localhost:4004/mcp/ProbeDestination?destination=ABAP_DEV"

# Production mode
curl -H "Authorization: Bearer <your-jwt-token>" \
  "https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/ProbeDestination?destination=ABAP_DEV"
```

Expected response:

```json
{
  "destination": "ABAP_DEV",
  "connectivity": "internet",
  "proxyType": "Internet",
  "authentication": "BasicAuthentication",
  "sapClient": "100",
  "cloudConnectorLocationId": "",
  "tokenExpiresAt": 0,
  "probe": {
    "status": 200,
    "statusText": "OK",
    "contentType": "application/atomsvc+xml"
  },
  "timestamp": "2025-11-04T09:30:00.000Z"
}
```

The function automatically:

- Resolves destination configuration via SAP Cloud SDK
- Determines connectivity mode (internet vs. on-premise)
- Performs an ADT discovery request to validate connectivity
- Returns HTTP status and metadata about the destination

For on-premise destinations, the function automatically routes through the Connectivity proxy using the configured `ConnectorID`.

### Test Stream-HTTP

```bash
# Send test request
echo '{"test":"data"}' | \
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

### Test Authorization

```bash
# Should return 401
curl -I -X POST http://localhost:4004/mcp/stream/http

# Should return 403 (if user lacks role)
echo '{"test":"data"}' | \
curl -X POST \
     -H "Authorization: Basic dW5rbm93bjo=" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

## 🛡️ Security

### Roles and Scopes

| Scope         | Description               | Role          |
| ------------- | ------------------------- | ------------- |
| `MCP_Connect` | Connect to MCP streams    | MCP_Connector |
| `MCP_Read`    | Read stream data          | MCP_Connector |
| `MCP_Admin`   | Administrative operations | MCP_Admin     |

### Development Users

| User  | Roles                    | Access      |
| ----- | ------------------------ | ----------- |
| alice | MCP_Connector, MCP_Admin | Full access |
| bob   | MCP_Connector            | Read-only   |

### Rate Limiting

Consider adding rate limiting in production:

- 1000 events/sec per user
- 1 MB max event size
- Connection limit per IP

## 🐛 Troubleshooting

### XSUAA Binding Issues

```bash
# Check if XSUAA service is bound
cf services

# View environment variables
cf env <app-name>

# Bind XSUAA service
cf bind-service <app-name> <xsuaa-instance>
cf restage <app-name>
```

### Local Testing with XSUAA

1. Copy `default-env.json.template` to `default-env.json`
2. Fill in XSUAA credentials from BTP cockpit
3. Start the app: `cds watch`

### Connection Issues

```bash
# Check if MCP backend is running
curl http://127.0.0.1:7070/health

# Check proxy logs
cds watch --profile development --debug

# Test with verbose curl
echo '{"test":"data"}' | \
curl -v -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

## 📚 Additional Resources

- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
- [XSUAA Setup Guide](https://help.sap.com/docs/btp/sap-business-technology-platform/using-authorization-and-trust-management-service)
- [Server-Sent Events Spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [NDJSON Format](http://ndjson.org/)

## 🚀 Deployment to BTP

```bash
# Build the app
cds build --production

# Deploy to Cloud Foundry
cf push

# Create XSUAA service
cf create-service xsuaa application mcp-xsuaa -c xs-security.json

# Bind service
cf bind-service cloud-llm-hub mcp-xsuaa

# Restage app
cf restage cloud-llm-hub

# View logs
cf logs cloud-llm-hub --recent
```

## 📝 License

This project is part of the cloud-llm-hub CAP application.
