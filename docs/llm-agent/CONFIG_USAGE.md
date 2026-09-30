# SmartAgent Configuration

How cloud-llm-hub configures the agent. Everything here is read by
`srv/agent-config.ts`, which assembles a singleton config from `LLM_AGENT_*`
environment variables — there is no config file. The one thing a request can
change is the **model**: `/v1/chat/completions` passes `body.model` into
`getSmartAgent`, which hot-swaps it for every cached agent, not just the caller.
Provider and credentials are process-wide.

> **Rewritten against the code.** Earlier revisions documented a
> constructor-based agent with its own connect step and response shape. That API
> is gone: the agent is built by `SmartAgentBuilder` in `srv/agent-manager.ts`
> and reached through `getSmartAgent()`. See git history for the previous text.

## Where values come from

| Source | When |
|--------|------|
| `.env` in the repo root | Local development only — `srv/env-setup.ts` loads it when neither `VCAP_APPLICATION` nor `CF_INSTANCE_INDEX` is set |
| `.mtaext` parameters → `mta.yaml` → `cloud-llm-hub-srv.properties` | Deployed, for every variable `mta.yaml` declares |
| `cf set-env` | Deployed, for secrets `mta.yaml` deliberately does not declare — `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL` |

There is **no HTTP-header override** for provider credentials — headers naming
an LLM vendor or key are not read anywhere. SAP connection headers (`x-sap-*`)
are a different mechanism and do apply per request.

## Variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_AGENT_PROVIDER` | `sap-ai-sdk` | `sap-ai-sdk`, `openai`, `anthropic` or `deepseek` |
| `LLM_AGENT_MODEL` | `gpt-4o-mini` | Model id; for SAP AI Core it must be deployed in AI Launchpad |
| `LLM_AGENT_API_KEY` | — | Non-SAP providers only. Set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_BASE_URL` | — | Non-SAP providers only. Also used for the embedder |
| `LLM_AGENT_RESOURCE_GROUP` | `default` | SAP AI Core resource group |
| `LLM_AGENT_MCP_DESTINATION` | empty | Default BTP destination; empty means LLM-only mode |
| `LLM_AGENT_RAG_TYPE` | `in-memory` | Legacy switch: `in-memory` is keyword-only; any other value takes the vector path. Still read — it is the default the per-class variables below fall back to |
| `LLM_AGENT_RAG_QUERY_K` | `5` in code, **`15` in `mta.yaml`** | Tools returned per query by the tool-intent RAG |
| `LLM_AGENT_EMBEDDER` | `sap-ai-core` if `LLM_AGENT_PROVIDER=sap-ai-sdk`, else `openai` | `sap-ai-core` \| `openai` \| `ollama`. Only accepted when at least one RAG class below is not `in-memory` |
| `LLM_AGENT_EMBEDDING_MODEL` | `text-embedding-3-small` (`ollama`: none — required) | Embedding model id |
| `LLM_AGENT_EMBEDDER_URL` | `openai`: `LLM_AGENT_BASE_URL`; `ollama`: `http://localhost:11434` | Embedder base URL |
| `LLM_AGENT_EMBEDDER_API_KEY` | `openai`: `LLM_AGENT_API_KEY` | Embedder API key. Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_TOOLS_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` (today's behaviour) | `in-memory` \| `vector` \| `qdrant` for the tool-intent RAG class. `qdrant` does **not** translate queries (`vector` does — one LLM call per non-ASCII query); it relies on a multilingual embedder such as `bge-m3` |
| `LLM_AGENT_SESSION_RAG_BACKEND` | same as tools | `in-memory` \| `vector` \| `qdrant` for the session-history RAG class. `qdrant` is not yet supported (phase 2) |
| `LLM_AGENT_RAG_BACKEND` | derived from `LLM_AGENT_RAG_TYPE` | `in-memory` \| `vector` \| `qdrant` for persistent collections. `qdrant` is not yet supported — it arrives with Plan B |
| `LLM_AGENT_QDRANT_URL` | — | Required when any RAG class above is `qdrant` |
| `LLM_AGENT_QDRANT_API_KEY` | — | Secret — set with `cf set-env`, never in `.mtaext` |
| `LLM_AGENT_QDRANT_PREFIX` | `cloud-llm-hub` | Prefix for Qdrant collection names. Deployments sharing one Qdrant must each use a distinct prefix |
| `LLM_AGENT_DESTINATION_SOURCE` | `btp` | `btp` (Destination service) \| `env` (the Cloud SDK `destinations` variable — off-platform, where no Destination service is reachable) |
| `LLM_AGENT_CLASSIFIER_MODEL` | falls back to `LLM_AGENT_MODEL` | Optional cheaper model for classification |
| `LLM_AGENT_THROTTLE_MAX_WAIT_MS` | `20000` | The longest LLM-side `429` interval we wait out **when no door is configured**. Anything longer is reported with the number attached. Not applied once `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` is set: behind a door an admitted session waits exactly the interval the server named. A value that is not a whole number of milliseconds is refused at startup |
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | unset | How many sessions may run a pipeline at once, across `/v1/chat/completions`, `/v1/messages` and `execute_step`. Unset: no door on the chat channels, and `execute_step` keeps its cap of two. Size it against the container's memory |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | the capacity | How many callers may wait to be admitted — for a slot, for their own session, or for a retention place. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`. The queue passing three quarters is logged as pressure |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | unbounded | How many sessions may hold history and session collections. An idle one is evicted — history, collections and their files — to make room: first sessions no caller ever presented (a client keeping no cookie gets one per request), then the least recently used; a session with a pipeline or a RAG operation running is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller. With `/v1/rag/*` in use, set it above the capacity by the number of concurrent uploads |
| `LLM_AGENT_TEMPERATURE`, `LLM_AGENT_MAX_TOKENS` | provider defaults | Sampling parameters |
| `LLM_AGENT_MODE`, `LLM_AGENT_MAX_ITERATIONS` | see `agent-config.ts` | Agent loop behaviour |
| `LLM_AGENT_HISTORY_RECENCY_WINDOW` | see `agent-config.ts` | How much history reaches the model |
| `LLM_AGENT_MCP_ENDPOINT` | — | **Inert.** Read and logged, consumed by nothing |

All `LLM_GATEKEEPER_*` values: unset means off. A value that is not plain digits for a positive integer (`0x10`, `1e3`, ` 5` and `5.0` are refused) — or a combination the notes above forbid — stops `cds serve` before it listens, naming the variable. The values in force are logged at startup and returned in `Health()`.

`LLM_AGENT_STEP_REVIEW_ENABLED=false` switches off the honesty controller's
reviewer (`srv/agent-manager.ts`).

## Scenario A — SAP AI Core

```yaml
parameters:
  LLM_AGENT_MODEL: "anthropic--claude-4.5-sonnet"
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"

resources:
  - name: cloud-llm-hub-ai-core
    active: true
```

Credentials arrive through the service binding in `VCAP_SERVICES`; no key is set
by hand.

## Scenario B — external provider

```yaml
parameters:
  LLM_AGENT_PROVIDER: "openai"
  LLM_AGENT_MODEL: "gpt-4o"
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"
```

then, after deploying:

```bash
cf set-env cloud-llm-hub-srv LLM_AGENT_API_KEY  "<your-api-key>"
cf set-env cloud-llm-hub-srv LLM_AGENT_BASE_URL "https://api.openai.com/v1"
cf restart cloud-llm-hub-srv
```

`mta.yaml` declares neither of those two, so a value placed in `.mtaext` is
dropped silently.

Native Anthropic and DeepSeek work the same way, with one caveat: the embedder
is built against the **same** base URL as chat, and neither serves an
OpenAI-compatible `/embeddings`. Set `LLM_AGENT_RAG_TYPE: "in-memory"` for those,
which makes tool selection keyword-only.

## See also

- `srv/agent-config.ts` — the single place these variables are read
- [ARCHITECTURE.md §12](../architecture/ARCHITECTURE.md) — per-variable semantics
- [Installation Plan](../deployment/INSTALLATION_PLAN.md) — which of these a deployment actually needs
