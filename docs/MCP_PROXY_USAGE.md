# MCP Proxy - Streaming Endpoints

CAP-based secure proxy for MCP (Model Command Protocol) with SSE and Stream-HTTP support.

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

### SSE Endpoint: `GET /mcp/stream/sse`

Server-Sent Events stream with automatic heartbeat and reconnection hints.

**Features:**
- Content-Type: `text/event-stream`
- Heartbeat every 15 seconds (`: ping`)
- Reconnection hint: `retry: 15000`
- No buffering or compression
- 2-minute timeout

**Example with curl:**

```bash
# Development mode
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse

# Production mode
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Bearer <your-jwt-token>" \
     https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/stream/sse
```

**Example with JavaScript:**

```javascript
const eventSource = new EventSource('http://localhost:4004/mcp/stream/sse', {
  headers: {
    'Authorization': 'Basic YWxpY2U6'
  }
});

eventSource.onmessage = (event) => {
  console.log('Received:', event.data);
};

eventSource.onerror = (error) => {
  console.error('SSE Error:', error);
};
```

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
    'Authorization': 'Basic YWxpY2U6',
    'Content-Type': 'application/x-ndjson'
  },
  body: JSON.stringify({ command: 'tools/list' }) + '\n'
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

## 🔧 Cline Integration

### SSE Configuration (`cline.json`)

```json
{
  "type": "sse",
  "endpoint": "http://localhost:4004/mcp/stream/sse",
  "headers": {
    "Authorization": "Basic YWxpY2U6"
  },
  "timeoutMs": 0
}
```

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
  "type": "sse",
  "endpoint": "https://<your-app>.cfapps.<region>.hana.ondemand.com/mcp/stream/sse",
  "headers": {
    "Authorization": "Bearer ${ACCESS_TOKEN}"
  },
  "timeoutMs": 0
}
```

## 🧪 Testing

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

### Test SSE Stream

```bash
# Terminal 1: Start the server
cds watch --profile development

# Terminal 2: Test SSE endpoint
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

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
curl -I http://localhost:4004/mcp/stream/sse

# Should return 403 (if user lacks role)
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic dW5rbm93bjo=" \
     http://localhost:4004/mcp/stream/sse
```

## 🔗 MCP Backend Integration

The proxy forwards requests to `mcp-abap-adt` service.

### Configuration

Edit `package.json`:

```json
{
  "cds": {
    "requires": {
      "mcpTarget": {
        "kind": "rest",
        "credentials": {
          "url": "http://127.0.0.1:7070"
        }
      }
    }
  }
}
```

### Add as Git Submodule

```bash
# Add mcp-abap-adt submodule
git submodule add <repo-url> external/mcp-abap-adt
git submodule update --init --recursive

# Start the MCP backend
cd external/mcp-abap-adt
npm install
npm start
```

Expected upstream endpoints:
- SSE: `http://127.0.0.1:7070/sse`
- Stream: `http://127.0.0.1:7070/stream`

## 🛡️ Security

### Roles and Scopes

| Scope | Description | Role |
|-------|-------------|------|
| `MCP_Connect` | Connect to MCP streams | MCP_Connector |
| `MCP_Read` | Read stream data | MCP_Connector |
| `MCP_Admin` | Administrative operations | MCP_Admin |

### Development Users

| User | Roles | Access |
|------|-------|--------|
| alice | MCP_Connector, MCP_Admin | Full access |
| bob | MCP_Connector | Read-only |

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
curl -v -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
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
