# Cloud LLM Hub - MCP Proxy

SAP CAP-based secure proxy for MCP (Model Command Protocol) with SSE and Stream-HTTP support.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Development mode (mock auth)
cds watch --profile development

# Production mode (requires XSUAA)
cds watch --profile production
```

The service will start on `http://localhost:4004`

## 📁 Project Structure

File or Folder | Purpose
---------|----------
`app/` | UI frontends
`db/` | Domain models and data
`srv/` | Service models and implementation
`docs/` | Documentation and examples
`test/smoke/` | Smoke tests for endpoints
`xs-security.json` | XSUAA security configuration
`package.json` | Project metadata and CDS configuration

## 🔐 Authentication & Authorization

### XSUAA Configuration

The project uses SAP BTP XSUAA for authentication with the following security model:

**Scopes:**
- `MCP_Connect` - Connect to MCP stream endpoints
- `MCP_Read` - Read MCP stream data
- `MCP_Admin` - Administrative operations

**Roles:**
- `MCP_Connector` - Basic access (Connect + Read)
- `MCP_Admin` - Full administrative access

Configuration file: [`xs-security.json`](xs-security.json)

### Development Mode

Two mock users are available:

| User | Password | Roles | Access |
|------|----------|-------|--------|
| alice | _(empty)_ | MCP_Connector, MCP_Admin | Full access |
| bob | _(empty)_ | MCP_Connector | Read-only |

**Example:**
```bash
# alice credentials (Base64)
curl -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/Health
```

### Production Mode

Requires valid XSUAA JWT token obtained via OAuth2 client credentials flow.

## 📡 Streaming Endpoints

### SSE Endpoint: `GET /mcp/stream/sse`

Server-Sent Events with automatic heartbeat and reconnection.

**Features:**
- Heartbeat every 15 seconds
- Auto-reconnect hint: 15 seconds
- No buffering/compression
- 2-minute timeout

**Example:**
```bash
curl -N -H "Accept: text/event-stream" \
     -H "Authorization: Basic YWxpY2U6" \
     http://localhost:4004/mcp/stream/sse
```

### Stream-HTTP Endpoint: `POST /mcp/stream/http`

Bidirectional NDJSON streaming.

**Example:**
```bash
echo '{"command":"test"}' | \
curl -X POST \
     -H "Authorization: Basic YWxpY2U6" \
     -H "Content-Type: application/x-ndjson" \
     --data-binary @- \
     http://localhost:4004/mcp/stream/http
```

## 🧪 Testing

### Run All Smoke Tests

```bash
cd test/smoke
chmod +x run-all.sh
./run-all.sh
```

### Individual Tests

```bash
# Health check
./test-health.sh

# SSE endpoint
./test-sse.sh

# Stream-HTTP endpoint
./test-stream-http.sh
```

## 🔗 MCP Backend Integration

The proxy forwards requests to `mcp-abap-adt` backend.

### Setup Backend

```bash
# Add as git submodule
git submodule add <repo-url> external/mcp-abap-adt
git submodule update --init --recursive

# Start backend
cd external/mcp-abap-adt
npm install
npm start
```

### Configuration

Backend URL is configured in `package.json`:

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

## 🔧 Cline Integration

Example configurations are in [`docs/examples/`](docs/examples/):

- `cline-sse-dev.json` - SSE for development
- `cline-stream-dev.json` - Stream-HTTP for development  
- `cline-sse-prod.json` - SSE for production

## 🚀 Deployment to BTP

```bash
# Build
cds build --production

# Deploy
cf push

# Create & bind XSUAA service
cf create-service xsuaa application mcp-xsuaa -c xs-security.json
cf bind-service cloud-llm-hub mcp-xsuaa
cf restage cloud-llm-hub
```

## 📚 Documentation

- **[MCP Proxy Usage Guide](docs/MCP_PROXY_USAGE.md)** - Detailed documentation
- **[Technical Specification v1.3](docs/TZ_MCP_SSE_StreamHTTP_Proxy_XSUAA_v1.3.md)** - Requirements
- **[Roadmap](docs/roadmap.md)** - Future plans
- **[ADR Catalog](docs/adrs)** - Architecture decisions

## 🐛 Troubleshooting

### Service Won't Start

```bash
# Check dependencies
npm install

# Clear cache
rm -rf node_modules gen
npm install
```

### XSUAA Binding Issues

```bash
# Check service binding
cf services
cf env cloud-llm-hub

# Re-bind service
cf unbind-service cloud-llm-hub mcp-xsuaa
cf bind-service cloud-llm-hub mcp-xsuaa
cf restage cloud-llm-hub
```

### Backend Connection Issues

```bash
# Verify backend is running
curl http://127.0.0.1:7070/health

# Check configuration
cat package.json | grep -A 5 mcpTarget
```

## 🤝 Contributing

1. Follow the existing code style
2. Add tests for new features
3. Update documentation
4. Submit a pull request

## 📄 License

This project is part of the cloud-llm-hub CAP application.

## Learn More

- [SAP CAP Documentation](https://cap.cloud.sap/docs/get-started/)
- [XSUAA Documentation](https://help.sap.com/docs/btp/sap-business-technology-platform/using-authorization-and-trust-management-service)
- [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
