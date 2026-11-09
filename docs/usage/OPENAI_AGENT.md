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
Security -> Role Collections -> assign "MCP Developer Access" (or "MCP Reader Access") to user.

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
  - model: <id from GET /v1/models>
    title: Cloud LLM Hub
    provider: openai
    apiBase: https://your-app.cfapps.eu10.hana.ondemand.com/v1
    apiKey: <XSUAA_JWT_TOKEN>
```

### Cursor

In Cursor Settings -> Models -> OpenAI API Key:
- API Key: `<XSUAA_JWT_TOKEN>`
- Base URL: `https://your-app.cfapps.eu10.hana.ondemand.com/v1`
- Model: the id from `GET /v1/models`

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

`UNVERIFIED_WRITE` notices use deterministic tool-journal checks, with no automatic LLM review of workers or answers. Failed/unanswered write notices and recording placeholders remain. `LLM_AGENT_STEP_REVIEW_ENABLED=false` disables claim-based notices only. Verification checks are explicit coordinator decisions each turn: run a planned check, skip it stating why, or add an unplanned check; user input can require `plan_revise`. Checker failures need exact result quotes and cited supplied evidence (or `none provided`); invalid failures are unusable verdicts for the coordinator to assess, not failures. No tools executed alone is never grounds for fail.


## Session role models and limits

Send `x-clh-session: <key>` for an open session owned by the authenticated user.
Session settings last until changed, the session closes, or the hub restarts;
they are isolated from other sessions and users. Only `MCP_Admin` may change
models or limits through any channel. Reading settings is available to the
session owner without that role.

The WebUI **LLM** button next to **MANAGE** opens settings for coordinator,
planner, executor and checker. It shows effective models, limits and their
sources. Non-admin users get an information-only window without Save.
Model parameter controls are read-only in stage 1; their effective values are
not currently exposed by the session API. Hub-owned limits support numbers
and `off`; an empty input with `off` unchecked clears the session override.
Unchecking `off` prefills the config/default value when numeric. Select model
`auto` to clear a role model override. Library-owned `planStepBudget` is unavailable until stage 2.

### Chat API headers (OpenAI and Anthropic)

- `x-clh-model-coordinator`, `x-clh-model-planner`, `x-clh-model-executor`,
  `x-clh-model-checker`: allowlisted model ID; `auto` or an empty value clears
  the role override.
- `x-clh-params-<role>`: JSON model parameters. Stage 1 refuses these with a
  field-specific reason; parameter support follows in stage 2.
- `x-clh-limits`: JSON execution limits, for example
  `{"executor":{"maxIterations":"off","maxToolCalls":30},"historyTokenBudget":8000}`.
  Per-run roles are coordinator, executor and checker. Session-wide fields
  are `toolResultMaxChars` and `historyTokenBudget`. `planStepBudget` is
  refused in stage 1. `off` removes the hub limit; stop the task or close the
  session to stop a run. A limit value of `null` clears that individual session
  override and restores its config/default source, for example
  `{"executor":{"maxIterations":null}}`. Omitted header fields stay unchanged.

Headers are **sticky**: supplied fields merge into the session settings;
requests without them keep previous values. Nested role limits merge field
by field. All supplied models and limits are validated together and applied
atomically. Invalid updates return 400 with `error.field` and `error.reason`;
non-admin updates return 403. Settings headers require an open session and
`x-clh-session`; they cannot configure a plain request without a session.

`x-clh-models-effective` in the response contains JSON mapping each role to
its effective model (null means the coordinator chooses). A session role
override wins over the request body's coordinator `model`. The response
`x-clh-model-ignored` reports an ignored body model, including models sent
by non-admin users or outside the allowlist. `x-clh-params-ignored` lists
ignored body parameter names (`temperature`, `top_p`, `max_tokens`,
`max_completion_tokens`, `reasoning_effort`, `thinking`); in stage 1 body
parameters are ignored for everyone. These ignored body fields do not fail
the request.

### Session settings endpoints

Both endpoints require `x-clh-session` for an open session:

- `GET /v1/session/models` returns `{ settings, effective, capabilities,
  limits, effectiveLimits, canEdit }`. Effective models and limits include
  their source. Capabilities are keyed by allowlisted model ID.
- `PUT /v1/session/models` (MCP_Admin only) replaces all role settings and
  limits together. The body has role settings at the top level, plus
  `limits`, for example
  `{"executor":{"model":"gpt-4o"},"checker":"auto","limits":{"executor":{"maxIterations":"off"}}}`.
  Use a model from this deployment's allowlist. Omitted settings revert to
  defaults. Individual limit values also accept `null` to clear an override.
  Success returns the same snapshot as GET; validation failures
  return `400 {"error":{"field":"...","reason":"..."}}`; permission
  failures return 403.

### Agent MCP

For `MCP_Admin`, `session_open` accepts optional `models` and `limits`.
`models` contains planner, executor and checker role settings; a coordinator
entry is refused because the connecting agent coordinates. Limits use the
same shape and stage 1 restrictions as the HTTP API, including `null` to
clear individual limit overrides.

`session_set_models` accepts `{ session, models, limits }` for an open session,
replaces the settings and returns the effective snapshot. It is listed only
for `MCP_Admin`; direct calls by other users are refused as an unknown tool.
For other users, `session_open` omits `models` and `limits` from its schema
and refuses them if supplied anyway. Admin access applies only to the
caller's own session.
