# Cloud LLM Hub — Installation Summary

For effort estimation. Full details: [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md).

Two deployment scenarios: **SAP AI Core** (enterprise, BTP-native) or **OpenAI-compatible provider** (any API: OpenAI, Azure OpenAI, Ollama, vLLM, etc.).

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

### Installation (7 steps, ~2 hours)

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

## Scenario B: OpenAI-Compatible Provider

No SAP AI Core needed. Works with any OpenAI-compatible API.

### Prerequisites

| Requirement | Who | Lead time |
|-------------|-----|-----------|
| BTP Subaccount (CF enabled) + entitlements (XSUAA, Destination, Connectivity) | Global Account Admin | 1-5 days |
| OpenAI-compatible API access (API key + base URL) | LLM Provider | Available immediately |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min - 2 hours |
| Cloud Connector (on-prem only) | Basis Admin | 2-4 hours |
| SAP system user + ICF services `/sap/bc/adt` | Basis Admin | 1-4 hours |

> **No AI Core entitlement required.** Set AI Core resource to `active: false` in `.mtaext`.

### Installation (7 steps, ~2 hours)

1. Clone repo, `npm install`
2. Create `.mtaext` — key parameters:
   ```yaml
   LLM_AGENT_PROVIDER: "openai"
   LLM_AGENT_API_KEY: "sk-..."
   LLM_AGENT_BASE_URL: "https://api.openai.com/v1"  # or any compatible endpoint
   LLM_AGENT_MODEL: "gpt-4o"
   LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"
   ```
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

If the customer has a proprietary or non-standard LLM API, a custom provider can be implemented in llm-agent as a plugin. This is a development task, not a configuration change.

| Step | Effort | Who |
|------|--------|-----|
| Implement `ILlm` adapter for customer's API | 2-5 days | Developer |
| Implement `IEmbedder` adapter (if custom embedding API) | 1-2 days | Developer |
| Register provider in `makeLlm()` or inject via builder | 0.5 day | Developer |
| Test and deploy | 1 day | Developer |
| **Total** | **4-8 days** | |

> This scenario requires code changes in llm-agent. Discuss with the team before committing to a customer.

---

## Common to All Scenarios

> **All prerequisites must be validated before starting.** A missing prerequisite discovered mid-installation forces a pause (often waiting for another team), then restart from rebuild + redeploy. This can turn a 2-hour job into a multi-day effort.

### Compatible OpenAI Providers (Scenario B)

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | Direct OpenAI API |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<model>/v1` | Azure deployment |
| Ollama | `http://localhost:11434/v1` | Local, free |
| vLLM | `http://localhost:8000/v1` | Self-hosted |
| Together AI | `https://api.together.xyz/v1` | Hosted open-source models |
| Any OpenAI-compatible | Custom URL | Must support `/chat/completions` |
