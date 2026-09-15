# Testing LLM Proxy After Deployment

## Prerequisites

After deploying to SAP BTP, ensure:

1. ✅ **SAP AI Core credentials** reach the app one of three ways — the service
   binding via `VCAP_SERVICES` (bind it in `mta.yaml`), a ready-made
   `AICORE_SERVICE_KEY`, or the full `AICORE_*` set that `agent-config.ts`
   assembles into one
2. ✅ **Models** are deployed in SAP AI Core Launchpad
3. ✅ **XSUAA token** for authentication

**Note:** there is no "AI Core destination" option — the runtime never reads a
destination name for AI Core. Destinations are for SAP ABAP systems. To point at
an AI Core instance in another subaccount, use the `AICORE_*` variables.

## Getting Your Deployment URL

After deployment, get your app URL:

```bash
# Get app URL
cf apps | grep cloud-llm-hub

# Or get from app info
cf app cloud-llm-hub-srv | grep urls
```

Example URL: `https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com`

## Getting XSUAA Token

For testing, you need an XSUAA token:

```bash
# Get token using CF CLI
cf oauth-token

# Or manually via OAuth endpoint
curl -X POST "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>"
```

## Testing Scenarios

### Scenario 1: LLM Only (Without MCP)

Test the agent with LLM only. `Health()` below probes the model without a
connection; the chat call below sends no `X-SAP-Destination`, so no ABAP tool
runs either — just the model, and the session cookie carrying context between
the two requests.

#### 1. Health Check

```bash
BASE_URL="https://your-app.cfapps.eu10.hana.ondemand.com"
TOKEN="your-xsuaa-token"

curl -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" | jq '.'
```

`Health` takes no request context — the handler signature is `(_req)` and it
ignores headers entirely, reporting on the server's own configuration. Passing
`X-SAP-Destination` changes nothing, and `mcpConnected: true` requires
`LLM_AGENT_MCP_DESTINATION` to be set in the deployment, not in the request.

**Expected Response:**
```json
{
  "@odata.context": "$metadata#AgentHealthStatus",
  "status": "READY",
  "agentReady": true,
  "mcpConnected": false,
  "llmProvider": "SAP Core AI",
  "llmDestination": "sap-ai-sdk",
  "model": "<whatever LLM_AGENT_MODEL is set to>",
  "mcpDestination": "<whatever LLM_AGENT_MCP_DESTINATION is set to>",
  "timestamp": "<current time>"
}
```

**Note:** `mcpConnected: false` is expected for LLM-only mode (no MCP tools).

#### 2. Simple Chat, keeping the session

The session lives in the `clh_session` cookie the service issues; keep it with a
cookie jar so the second request continues the first.

```bash
curl -s -c jar -b jar -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello! Remember the word PINE."}]}' | jq '.choices[0].message.content'

curl -s -c jar -b jar -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Which word did I ask you to remember?"}]}' | jq '.choices[0].message.content'
```

**Expected Response:** each call is an OpenAI `chat.completion`; the second
answer names `PINE`:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "...",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "You asked me to remember PINE." },
      "finish_reason": "stop"
    }
  ]
}
```

#### 3. Changing the model or provider

**Model — yes, per request.** `/v1/chat/completions` reads `body.model` and
passes it to `getSmartAgent(requestedModel, ...)`:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic--claude-4.5-sonnet","messages":[{"role":"user","content":"What is 2+2?"}]}'
```

> ⚠️ The switch is **not** scoped to your request. `agent-manager.ts` performs a
> hot-swap: it builds a new LLM and assigns it to *every* cached agent handle,
> then records it as the current model. The next caller — anyone — keeps the
> model you asked for until someone asks for another. Treat it as changing a
> global setting through a request, not as an isolated override.

**Provider and credentials — no.** `LLM_AGENT_PROVIDER`, `LLM_AGENT_API_KEY` and
`LLM_AGENT_BASE_URL` are read once from the environment, so changing those means:

```bash
cf set-env cloud-llm-hub-srv LLM_AGENT_PROVIDER "anthropic"
cf restart cloud-llm-hub-srv
```

### Scenario 2: LLM + MCP (With Tools)

Test the agent with MCP tools integration. **These calls go to
`/v1/chat/completions`** — only the `/v1` path establishes the per-request ABAP
connection, so only there do tools actually execute.

#### 1. Health Check (With MCP)

The call is the same one as in Scenario 1 — `Health` ignores request headers, so
there is no "with destination" variant. What changes is the deployment: with
`LLM_AGENT_MCP_DESTINATION` set and that destination initialized, `mcpConnected`
turns true.

```bash
curl -X GET \
  "$BASE_URL/odata/v4/agent/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" | jq '.'
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
  "model": "<whatever LLM_AGENT_MODEL is set to>",
  "mcpDestination": "<whatever LLM_AGENT_MCP_DESTINATION is set to>",
  "timestamp": "<current time>"
}
```

**Note:** `mcpConnected: true` means every MCP client reported healthy. It says
nothing about the destination a *request* asks for — that connection is built
per request, in the `/v1` and agent-MCP paths only.

#### 2. Chat with MCP Tools

```bash
curl -X POST \
  "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "What tools are available?" }]
  }' | jq '.'
```

**Expected Response** (OpenAI-compatible):
```json
{
  "object": "chat.completion",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "I have access to GetProgram, GetClass, GetFunctionModule ..." },
      "finish_reason": "stop" }
  ],
  "usage": { "total_tokens": 0 }
}
```

#### 3. Chat with Tool Execution

```bash
curl -X POST \
  "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-SAP-Destination: SAP_DEV_DEST" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "List all ABAP classes in package Z_MY_PACKAGE" }]
  }' | jq '.'
```

**Expected Response** (OpenAI-compatible):
```json
{
  "object": "chat.completion",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "Here are the ABAP classes in package Z_MY_PACKAGE: ZCL_MY_CLASS, ZCL_ANOTHER_CLASS ..." },
      "finish_reason": "stop" }
  ]
}
```

The agent will:
1. Receive user message
2. LLM decides to use MCP tool (e.g., `GetClass`)
3. Agent executes tool via MCP
4. Tool result is added as separate message (not user message!)
5. LLM processes tool result and generates final answer

## Quick Test Script

`test/test-agent-btp.sh` runs the three checks above in order: Health, an
LLM-only chat through the OData endpoint, and — when a SAP destination is given
— an ABAP tool call through `/v1`.

```bash
export BASE_URL="https://your-app.cfapps.eu10.hana.ondemand.com"
export SAP_DESTINATION="SAP_DEV_DEST"   # optional; without it step 3 is skipped

bash test/test-agent-btp.sh
```

The script takes no model or provider argument. Those come from the
application's own environment, and sending a model in the request body would
hot-swap it for every cached agent — see *Changing the model or provider* above.

## Troubleshooting

### ❌ "SAP AI Core access is required"

There is no destination-based option — the runtime never reads a destination
name for AI Core.

**Solution:**
- **Service binding (recommended):** activate the `cloud-llm-hub-ai-core`
  resource in `.mtaext`; credentials arrive through `VCAP_SERVICES` and nothing
  else needs setting.
- **Cross-subaccount:** set all four `AICORE_*` variables. `agent-config.ts`
  assembles `AICORE_SERVICE_KEY` only when every one of them is present, so a
  partial set produces nothing:
  ```bash
  cf set-env cloud-llm-hub-srv AICORE_AUTH_URL      "https://<subaccount>.authentication.<region>.hana.ondemand.com"
  cf set-env cloud-llm-hub-srv AICORE_CLIENT_ID     "sb-<guid>|aicore!b540"
  cf set-env cloud-llm-hub-srv AICORE_CLIENT_SECRET "<secret>"
  cf set-env cloud-llm-hub-srv AICORE_BASE_URL      "https://api.ai.prod.<region>.aws.ml.hana.ondemand.com"
  cf restage cloud-llm-hub-srv
  ```

### ❌ "SAP AI Core API error"

**Solution:**
- Check the AI Core service is bound: `cf services | grep ai-core`
- Verify the model named by `LLM_AGENT_MODEL` is deployed in AI Launchpad —
  an entitlement without a deployed model is not enough
- On the cross-subaccount path, confirm all four `AICORE_*` variables are set

### ❌ `mcpConnected: false` when expecting `true`

`Health` reports the server's own state and ignores request headers, so no
`X-SAP-Destination` on the health call can change this.

**Solution:**
- Verify `LLM_AGENT_MCP_DESTINATION` is set on the app: `cf env cloud-llm-hub-srv | grep MCP_DESTINATION`
- Give that destination time to initialize — vectorization is bounded by
  `LLM_AGENT_DESTINATION_INIT_WAIT_MS` (90 s by default) and `mcpConnected` stays
  false until an agent handle exists
- Confirm the destination itself resolves: `curl "$BASE_URL/odata/v4/mcp-proxy/ProbeDestination?destination=<name>"`
- For a **tool call** through `/v1`, verify the request carries
  `X-SAP-Destination` — that header builds the per-request connection. It has no
  bearing on `Health`, which reports server state only
- Check CAP service logs for ADT connection errors

### ❌ "401 Unauthorized"

**Solution:**
- Get fresh XSUAA token: `cf oauth-token`
- Verify token is not expired
- Check XSUAA service is bound: `cf services | grep xsuaa`

## Environment Variables

After deployment, set these environment variables (all optional if using service binding):

There are no HTTP headers for any of these — the application reads them once
from its environment.

```bash
cf set-env cloud-llm-hub-srv LLM_AGENT_MODEL       anthropic--claude-4.5-sonnet
cf set-env cloud-llm-hub-srv LLM_AGENT_TEMPERATURE 0.7
cf set-env cloud-llm-hub-srv LLM_AGENT_MAX_TOKENS  32000

# Restart to apply changes
cf restart cloud-llm-hub-srv
```

`SAP_CORE_AI_MODEL`, `SAP_CORE_AI_TEMPERATURE` and `SAP_CORE_AI_MAX_TOKENS` are
still honoured as legacy fallbacks (`agent-config.ts`), but prefer the
`LLM_AGENT_*` names above.

**Note:** with the AI Core service bound through `mta.yaml`, credentials come from `VCAP_SERVICES` automatically — nothing needs setting by hand. The `AICORE_*` variables exist only for the cross-subaccount case.

## Next Steps

- [LLM Agent Testing](../llm-agent/TESTING.md) - Complete testing guide

