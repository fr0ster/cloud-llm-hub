# LLM Proxy Testing Guide

## Prerequisites

To test the LLM agent in `cloud-llm-hub`, you need:

1. **A configured LLM provider** — SAP AI Core by default (`LLM_AGENT_PROVIDER=sap-ai-sdk`,
   credentials from the service binding). An API key is needed only for an external
   provider
2. **Running cloud-llm-hub** - CAP service must be running
3. **SAP Configuration** - Either a destination or a direct SAP connection, passed via `x-sap-*` headers

**Important Architecture Note:**
- The agent does **not** call the MCP proxy over HTTP. `agent-manager.ts` gives it an
  embedded MCP client (`transport: 'embedded'`) over the HandlerExporter handlers,
  so tool calls run in-process
- The agent knows nothing about SAP destinations. The per-request ABAP connection is
  built from the request's `x-sap-*` headers and reaches each tool call through
  `connectionALS`

## LLM Provider Configuration

Provider configuration reaches the service in two ways:

> **There is no header-based provider override.** Per-request headers naming an
> LLM vendor or key are read by nothing — no handler and no `env-setup.ts` code
> path (a stale comment in `srv/env-setup.ts` still suggests otherwise). The
> provider is process-wide: `LLM_AGENT_PROVIDER`, `LLM_AGENT_API_KEY`,
> `LLM_AGENT_BASE_URL`, `LLM_AGENT_MODEL`. Only SAP connection headers
> (`x-sap-*`) are per request.

### Option 1: Local Development (.env file)

For local development, create a `.env` file in the **project root** (`cloud-llm-hub/.env`):

```bash
cp .env.example .env
# then edit it with your provider settings
```

**Important:** there is one `.env`, in the repository root, and it is loaded only
outside Cloud Foundry (`srv/env-setup.ts` checks `VCAP_APPLICATION` and
`CF_INSTANCE_INDEX`). Deployed instances take their configuration from the
environment, never from a file.

Example `.env` file (in project root - same as agent's .env):
```env
# One provider per deployment. srv/agent-config.ts reads only LLM_AGENT_* —
# vendor-prefixed variable names are read by nothing.
LLM_AGENT_PROVIDER=openai
LLM_AGENT_MODEL=gpt-4o-mini
LLM_AGENT_API_KEY=sk-proj-your-key-here
LLM_AGENT_BASE_URL=https://api.openai.com/v1

# Anthropic instead:
#   LLM_AGENT_PROVIDER=anthropic
#   LLM_AGENT_MODEL=claude-3-5-sonnet-20241022
#   LLM_AGENT_BASE_URL=https://api.anthropic.com
#
# DeepSeek instead:
#   LLM_AGENT_PROVIDER=deepseek
#   LLM_AGENT_MODEL=deepseek-chat
#   LLM_AGENT_BASE_URL=https://api.deepseek.com
```

The `.env` file is automatically loaded when running locally (not in BTP).

**File Location:** there is one file — `.env` in the repository root.
- `srv/env-setup.ts` loads it for local development (only when not running in CF)
- `tools/set-btp-env.js` reads the same variables from the environment when
  pushing them to a deployed app

### Option 2: BTP Deployment (Environment Variables)

For BTP deployment, set environment variables after deployment:

**Option A: Using npm script with .env file (recommended - no export needed):**
```bash
# 1. Create .env file with your API keys (see Option 1 above)
# 2. Run the script - it reads from .env automatically
npm run deploy:set-env
```

**Option B: Using npm script with exported variables:**
```bash
export LLM_AGENT_PROVIDER="openai"
export LLM_AGENT_MODEL="gpt-4o-mini"
export LLM_AGENT_API_KEY="sk-proj-your-key-here"
export LLM_AGENT_BASE_URL="https://api.openai.com/v1"

npm run deploy:set-env
```

**Option C: Direct CF CLI (if you prefer):**
```bash
# LLM_AGENT_PROVIDER and LLM_AGENT_MODEL are usually set in .mtaext; only the
# two secrets have to be set on the app, because mta.yaml does not declare them.
cf set-env cloud-llm-hub-srv LLM_AGENT_API_KEY  "sk-proj-your-key-here"
cf set-env cloud-llm-hub-srv LLM_AGENT_BASE_URL "https://api.openai.com/v1"
cf restart cloud-llm-hub-srv
```

**Why use the script?**
- ✅ Reads from `.env` file automatically (no need to export)
- ✅ Sets all variables at once
- ✅ Validates CF CLI and app existence
- ✅ Automatically restages the app
- ✅ Shows masked values for security

**Important Security Note:**
- ❌ **DO NOT** store API keys in `mta.yaml` (they would be committed to version control)
- ✅ **DO** set them via CF CLI after deployment
- ✅ **DO** use the `npm run deploy:set-env` script for convenience

**Priority Order:**
1. Environment variables on the deployed app (`cf set-env`), or `.env` locally
2. Error if none provided

There is no third source: per-request headers cannot select a provider or supply
a key.

## Starting the Service

```bash
# Install dependencies (if not done)
npm install

# Start CAP service
cds watch --profile development
```

The service will be available at `http://localhost:4004`.

## Testing with curl

### 1. Health Check

```bash
curl -X GET \
  "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6"
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": true,
  "llmProvider": "SAP Core AI",
  "llmDestination": "sap-ai-sdk",
  "model": "anthropic--claude-4.5-sonnet",
  "mcpDestination": "S4HANA_DEV",
  "timestamp": "2026-08-13T15:00:00.000Z"
}
```

> `llmProvider` and `llmDestination` are **hardcoded** in `srv/agent-service.ts`
> and always report SAP AI Core, whatever `LLM_AGENT_PROVIDER` is set to. Read
> `model` and the app's environment instead; do not use this endpoint to confirm
> which provider is active.

### 2. Chat through the OpenAI-compatible endpoint

**To test ABAP tools, use the OpenAI-compatible endpoint** — it establishes the
connection from the request's own headers:

```bash
curl -X POST http://localhost:4004/v1/chat/completions \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "What ABAP classes exist in package $TMP?"}]
  }'
```

**With another provider:** the request does not change. The provider is chosen
by `LLM_AGENT_PROVIDER` on the server, not per call — switching from OpenAI to
Anthropic or DeepSeek means changing the environment and restarting, not editing
the curl.

**Expected Response** (OpenAI-compatible — `/v1/chat/completions` does not return
OData shapes):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "The package contains ..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### 3. Conversation History (not implemented)

`GetHistory()` returns an empty array unconditionally and `ClearHistory()`
reports success without clearing anything — both are stubs in
`srv/agent-service.ts`:

```bash
curl -X GET "http://localhost:4004/odata/v4/agent/GetHistory()" \
  -H "Authorization: Basic YWxpY2U6"
# → { "value": [] }   always
```

Real conversation history lives in the OpenAI handler's per-session store
(`sessionStore` in `srv/openai-handler.ts`, 30-minute inactivity TTL) and is not
exposed through this OData service.

### 4. Clear History

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/agent/ClearHistory" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "@odata.context": "$metadata#ClearHistoryResult",
  "success": true,
  "message": "Conversation history cleared successfully"
}
```

## Testing with Postman

### Setup

1. **Create a new request**
2. **Set URL:** `http://localhost:4004/v1/chat/completions`
3. **Method:** POST
4. **Headers:**
   - `Authorization: Basic YWxpY2U6`
   - `Content-Type: application/json`
   - `X-SAP-Destination: SAP_DEV_DEST`

Use `/v1/chat/completions` — it establishes the per-request ABAP connection from
the request's own headers, so this is where the tools work.

**Body (JSON):**
```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "List all available ABAP tools and explain what they do" }
  ]
}
```

## Testing Scenarios

### Scenario 1: The model answers — no SAP involved

`Health()` asks the LLM provider whether the configured model is available,
without a completion and without a connection:

```bash
curl "http://localhost:4004/odata/v4/agent/Health()" -H "Authorization: Basic YWxpY2U6"
```

`agentReady: true` means the model is reachable.

### Scenario 2: Query available tools

```bash
curl -X POST http://localhost:4004/v1/chat/completions \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What ABAP tools are available?"}]}'
```

### Scenario 3: A query that must reach the system

```bash
curl -X POST http://localhost:4004/v1/chat/completions \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Find ABAP classes whose name contains CUSTOMER"}]}'
```

## Troubleshooting

### Error: the provider reports a missing API key

**Solution:** set the variable the code actually reads — `LLM_AGENT_API_KEY`
(with `LLM_AGENT_BASE_URL` for the endpoint):
```bash
export LLM_AGENT_API_KEY="sk-your-key-here"
export LLM_AGENT_BASE_URL="https://api.openai.com/v1"
```
Deployed, set both with `cf set-env` and restart — `mta.yaml` does not carry them.

### A tool call fails with a connection error

There is no MCP endpoint to check — the agent calls the ABAP handlers in-process.
What can be missing is the **per-request connection**, so check:
- the request carries `X-SAP-Destination` (or the direct-mode `x-sap-*` headers)
- the destination exists and is reachable — `GET /odata/v4/mcp-proxy/ProbeDestination?destination=<name>`
- the call goes through `/v1/*` or the agent MCP surface — the only paths that
  establish a connection

### Error: "Connection failed" or "MCP server not ready"

**Solution:**
1. Check the service health endpoint: `GET /odata/v4/mcp-proxy/Health()`
   (that is this app's own OData service, not a separate process)
2. Verify the SAP destination is configured correctly
3. Check the app logs for ADT connection errors

### Agent returns empty response

**Possible causes:**
1. LLM API key is invalid
2. MCP tools are not accessible
3. Network connectivity issues

**Debug steps:**
1. Check agent health: `GET /odata/v4/agent/Health()`
2. Verify MCP connection: Check `mcpConnected` in health response
3. Check CAP service logs for errors

## Quick Test Script

> **`test/test-agent.sh` is out of date — do not treat its output as a verdict.**
> It sends `X-SAP-Core-AI-*` headers that nothing reads, calls
> `/odata/v4/agent/Chat` — removed, so those calls now 404 — and assumes every
> provider goes through SAP AI Core. Use the curl calls above until it is
> rewritten.

For reference, the script lives at `test/test-agent.sh`:

```bash
# Make it executable (if not already)
chmod +x test/test-agent.sh

# Run from project root
bash test/test-agent.sh

# Or from test directory
cd test
./test-agent.sh
```

## Expected Behavior

1. **First request for a destination:** the agent is built and its tool corpus is
   ready — `getSmartAgent` waits, bounded by `LLM_AGENT_DESTINATION_INIT_WAIT_MS`
   (90 s), rather than failing fast. The tool corpus itself is vectorized once
   and shared by every destination
2. **Subsequent requests:** the agent handle is reused from `agentHandles` for
   the process lifetime. The **ABAP connection is not** — it is created per
   request from that request's `x-sap-*` headers and passed through
   `connectionALS`
3. **Tools:** called in-process through the embedded MCP client; there is no HTTP
   hop to the proxy
4. **History:** kept only by `/v1/chat/completions`, in a per-session store with
   a 30-minute inactivity TTL. The OData history endpoints are stubs
5. **Errors:** descriptive messages; a destination that has not finished
   initializing yields a retryable 503

## Next Steps

After basic testing works:
1. Test with different LLM models
2. Test with different SAP destinations
3. Test conversation context (multi-turn conversations)
4. Test error handling (invalid destinations, network issues)

