# Cloud LLM Hub — Installation Summary

For effort estimation. Full details: [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md).

Three deployment scenarios: **A — SAP AI Core** (enterprise, BTP-native), **B — external provider** (OpenAI-compatible APIs such as OpenAI, Azure OpenAI, Ollama or vLLM, plus the natively supported Anthropic and DeepSeek APIs), or **C — custom provider** (a proprietary interface that needs an adapter; see below).

> **Which scenario applies at a given customer** comes out of the [Readiness Questionnaire](READINESS_QUESTIONNAIRE.md);
> [READINESS_ASSESSMENT.md](READINESS_ASSESSMENT.md) maps the answers to a scenario and to the
> effort adjustments the tables below do not include. The estimates here assume every prerequisite
> is already in place.

---

## Scenario A: SAP AI Core (default)

### Prerequisites

| Requirement | Who | Lead time |
|-------------|-----|-----------|
| BTP Subaccount (CF enabled) + entitlements | Global Account Admin | 1-5 days |
| SAP AI Core instance + LLM models deployed | AI Core Admin | 1-2 hours |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min - 2 hours |
| Cloud Connector (on-prem only) | Basis Admin | 2-4 hours |
| SAP system user + ICF services `/sap/bc/adt` | Basis Admin | 1-4 hours |

### Installation (6 steps, ~2 hours)

1. Clone repo, `npm install`
2. Create `.mtaext` — set `LLM_AGENT_MODEL`, `LLM_AGENT_MCP_DESTINATION`, AI Core active
3. Create BTP Destination to SAP system (manual, BTP Cockpit)
4. Build (`npx mbt build`) and deploy (`cf deploy`)
5. Assign role collections to users
6. Verify: health check, MCP tools, test chat

### Total Effort

| Situation | Hands-on | Wall-clock |
|-----------|----------|------------|
| All prerequisites ready | 2 hours | 2 hours |
| Minor gaps, troubleshooting | 3-4 hours | 1 day |
| New subaccount + AI Core setup | 4-6 hours | 2-3 days |
| From scratch at new customer | 1-2 days | 1-2 weeks |

---

## Scenario B: External Provider

No SAP AI Core needed. Works with any OpenAI-compatible API, and also with the native Anthropic and DeepSeek APIs — `LLM_AGENT_PROVIDER` supports `anthropic` and `deepseek` directly, so "not OpenAI-compatible" alone does not push a customer into Scenario C.

> **Embeddings come from the same endpoint as chat.** For any non-AI-Core provider the embedder is built against the same `LLM_AGENT_BASE_URL` and `LLM_AGENT_API_KEY`; there is no separate embedding endpoint. Providers without OpenAI-compatible `/embeddings` — including native Anthropic and DeepSeek — must run with `LLM_AGENT_RAG_TYPE: "in-memory"`, which makes tool selection keyword-only.

### Prerequisites

| Requirement | Who | Lead time |
|-------------|-----|-----------|
| BTP Subaccount (CF enabled) + entitlements (XSUAA, Destination, Connectivity) | Global Account Admin | 1-5 days |
| LLM API access — OpenAI-compatible, or the native Anthropic or DeepSeek API (API key + base URL) | LLM Provider | Available immediately |
| Embeddings on that same base URL, if vector RAG is wanted — otherwise `LLM_AGENT_RAG_TYPE: "in-memory"` | LLM Provider | Available immediately |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min - 2 hours |
| Cloud Connector (on-prem only) | Basis Admin | 2-4 hours |
| SAP system user + ICF services `/sap/bc/adt` | Basis Admin | 1-4 hours |

> **No AI Core entitlement required.** Set AI Core resource to `active: false` in `.mtaext`.

### Installation (6 steps, ~2 hours)

1. Clone repo, `npm install`
2. Create `.mtaext` — key parameters:
   ```yaml
   LLM_AGENT_PROVIDER: "openai"
   LLM_AGENT_MODEL: "gpt-4o"
   LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"
   ```
   The API key and base URL are **not** `.mtaext` parameters — `mta.yaml` does not declare them.
   Set them after the deploy: `cf set-env cloud-llm-hub-srv LLM_AGENT_API_KEY "..."`,
   the same for `LLM_AGENT_BASE_URL`, then `cf restart cloud-llm-hub-srv`.
3. Create BTP Destination to SAP system (manual, BTP Cockpit)
4. Build (`npx mbt build`) and deploy (`cf deploy`)
5. Assign role collections to users
6. Verify: health check, MCP tools, test chat

### Total Effort

| Situation | Hands-on | Wall-clock |
|-----------|----------|------------|
| All prerequisites ready | 1.5 hours | 1.5 hours |
| New subaccount needed | 3-4 hours | 1-3 days |
| From scratch at new customer | 1 day | 1-2 weeks |

---

## Scenario C: Custom LLM Provider (optional, advanced)

If the customer has a proprietary or non-standard LLM API, a custom provider must be developed before installation. This scenario includes both development and full deployment.

| Phase | Step | Effort | Who |
|-------|------|--------|-----|
| **Development** | Implement `ILlm` adapter for customer's API | 2-5 days | Developer |
| | Implement `IEmbedder` adapter (if custom embedding API) | 1-2 days | Developer |
| | Register provider in `makeHubLlm()` (`srv/lib/llm-factory.ts`) or inject via builder | 0.5 day | Developer |
| | Integration testing with customer's API | 1-2 days | Developer |
| **Installation** | Full installation (same as Scenario A/B) | 2 hours - 2 days | Developer + Admins |
| | **Total** | **1-2 weeks hands-on, 2-4 weeks wall-clock** | |

> This scenario requires code changes in llm-agent. Discuss with the team before committing to a customer.

---

## Common to All Scenarios

> **All prerequisites must be validated before starting.** A missing prerequisite discovered mid-installation forces a pause (often waiting for another team), then restart from rebuild + redeploy. This can turn a 2-hour job into a multi-day effort.

### Compatible Providers (Scenario B)

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | Direct OpenAI API |
| Anthropic | `https://api.anthropic.com` | Native API, `LLM_AGENT_PROVIDER=anthropic` — no `/chat/completions` needed |
| DeepSeek | `https://api.deepseek.com` | Native API, `LLM_AGENT_PROVIDER=deepseek` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<model>/v1` | Azure deployment |
| Ollama | `http://localhost:11434/v1` | Local, free |
| vLLM | `http://localhost:8000/v1` | Self-hosted |
| Together AI | `https://api.together.xyz/v1` | Hosted open-source models |
| Any OpenAI-compatible | Custom URL | Must support `/chat/completions` |
