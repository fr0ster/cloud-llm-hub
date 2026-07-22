# OpenAI-Compatible LLM Agent

Cloud LLM Hub exposes an OpenAI-compatible API at `/v1/*` endpoints, allowing any
OpenAI-compatible client to interact with the SAP-aware SmartAgent.

## Endpoints

| Method | Path                    | Description                          |
|--------|-------------------------|--------------------------------------|
| POST   | `/v1/chat/completions`  | Chat completion (streaming + sync)   |
| GET    | `/v1/models`            | List available models                |
| GET    | `/v1/usage`             | Token usage statistics               |

## Authentication

All `/v1/*` endpoints require an XSUAA JWT token.

### Obtaining a Token

```bash
# Step 1: Fetch XSUAA service key (requires CF CLI login)
npm run get:key          # saves to mcp.json

# Step 2: Browser-based auth to get JWT token
npm run get:token        # opens browser, saves to service.env (XSUAA_JWT_TOKEN)

# Or with headless mode (prints URL to console)
npx mcp-auth --service-key ./mcp.json --output ./service.env --type xsuaa --browser none
```

The token must include MCP role scopes. Assign Role Collections in BTP Cockpit:
Security -> Role Collections -> assign "MCP Full Access" (or other MCP role) to user.

**References:**
- [SAP BTP Security: Role Collections](https://help.sap.com/docs/btp/sap-business-technology-platform/role-collections-and-roles)
- [XSUAA OAuth2 Authorization](https://help.sap.com/docs/btp/sap-business-technology-platform/security)

## Connecting Clients

### curl

```bash
# Non-streaming
curl -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $XSUAA_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"List ABAP classes in package ZTEST"}],"stream":false}'

# Streaming (SSE)
curl -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $XSUAA_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain class ZCL_EXAMPLE"}],"stream":true}'

# List models
curl "$BASE_URL/v1/models" -H "Authorization: Bearer $XSUAA_JWT_TOKEN"

# Check usage
curl "$BASE_URL/v1/usage" -H "Authorization: Bearer $XSUAA_JWT_TOKEN"
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-app.cfapps.eu10.hana.ondemand.com/v1",
    api_key="<XSUAA_JWT_TOKEN>"
)

# Non-streaming
response = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "List ABAP classes in package ZTEST"}],
    stream=False
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Explain class ZCL_EXAMPLE"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### OpenAI Node.js SDK

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-app.cfapps.eu10.hana.ondemand.com/v1',
  apiKey: '<XSUAA_JWT_TOKEN>',
});

const response = await client.chat.completions.create({
  model: 'default',
  messages: [{ role: 'user', content: 'List ABAP classes in package ZTEST' }],
  stream: false,
});

console.log(response.choices[0].message.content);
```

### Continue (VS Code / JetBrains)

In `~/.continue/config.yaml`:

```yaml
models:
  - model: default
    title: Cloud LLM Hub
    provider: openai
    apiBase: https://your-app.cfapps.eu10.hana.ondemand.com/v1
    apiKey: <XSUAA_JWT_TOKEN>
```

### Cursor

In Cursor Settings -> Models -> OpenAI API Key:
- API Key: `<XSUAA_JWT_TOKEN>`
- Base URL: `https://your-app.cfapps.eu10.hana.ondemand.com/v1`
- Model: `default`

## Request Format

Standard OpenAI chat completions format:

```json
{
  "messages": [
    {"role": "system", "content": "You are a helpful SAP ABAP assistant."},
    {"role": "user", "content": "Find all classes that implement interface ZIF_EXAMPLE"}
  ],
  "stream": true,
  "tools": [],
  "model": "default"
}
```

### Supported Fields

| Field            | Type     | Description                                |
|------------------|----------|--------------------------------------------|
| `messages`       | array    | Chat messages (role: system/user/assistant) |
| `stream`         | boolean  | Enable SSE streaming (default: false)       |
| `stream_options` | object   | `{ include_usage: true }` for usage in stream |
| `tools`          | array    | External tool definitions (OpenAI format)   |
| `model`          | string   | Model name (informational, agent uses configured model) |

## Agent Capabilities

The SmartAgent behind this API has:
- **MCP Tools**: Access to SAP ABAP system via MCP protocol (read/write ABAP objects, search, analyze)
- **RAG**: Retrieval-Augmented Generation with facts, feedback, and state stores
- **Multi-turn**: Maintains conversation context within a session

**Note *(v6.28+)*:** a response may end with an `UNVERIFIED_WRITE:` line — a soft warning that a claimed write (create/update/activate) wasn't confirmed by the actual tool results. Verify against the system before relying on it; disable via `LLM_AGENT_STEP_REVIEW_ENABLED=false`.

## Smoke Testing

```bash
# Run all endpoint tests (auto-detects URL from CF)
bash test/smoke/test-cloud-endpoints.sh

# Or specify URL explicitly
bash test/smoke/test-cloud-endpoints.sh https://your-app.cfapps.eu10.hana.ondemand.com
```

See `.env.example` for token setup instructions.

## Related Documentation

- [MCP Proxy Connection](MCP_CONNECTION.md) - Connecting to MCP Stream-HTTP endpoint
- [CAP Express Auth](../development/CAP_EXPRESS_AUTH.md) - How auth works on custom routes
- [Consumer Guide](CONSUMER_GUIDE.md) - General consumer guide
