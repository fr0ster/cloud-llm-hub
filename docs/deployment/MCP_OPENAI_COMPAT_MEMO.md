# Cloud LLM Hub — MCP + OpenAI-Compatible Provider Memo

Short memory aid for the deployment scenario where:

- MCP is enabled for SAP access
- SAP AI Core is not used
- LLM calls go to an external OpenAI-compatible provider

Use this together with the full guides:

- [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md)
- [INSTALLATION_SUMMARY.md](INSTALLATION_SUMMARY.md)

---

## When to Use This Scenario

Choose this setup when you want:

- MCP tools against SAP via BTP Destination
- chat/agent features enabled
- any OpenAI-compatible backend instead of SAP AI Core

Examples:

- OpenAI
- Azure OpenAI
- vLLM
- Ollama
- Together AI
- any API that supports `/chat/completions`

---

## Minimal Checklist

- [ ] BTP subaccount with Cloud Foundry
- [ ] XSUAA entitlement
- [ ] Destination entitlement
- [ ] Connectivity entitlement if SAP is on-prem
- [ ] SAP destination created in BTP Cockpit
- [ ] SAP ICF services active: `/sap/bc/adt`, `/sap/bc/http`
- [ ] External provider API key
- [ ] External provider base URL
- [ ] Model name supported by that provider

> No AI Core entitlement or AI Core service instance is required for this scenario.

---

## Billable Time for Customer Installation

This is the practical answer to: "management said install `cloud-llm-hub` at the customer, how many hours should the customer pay for?"

### Recommended Commercial Estimate

| Situation | Billable engineering time | Why |
|----------|----------------------------|-----|
| Customer landscape is ready, all access is already available | **6-8 hours** | Real work still includes review, configuration, deploy, validation, and handover |
| Small gaps in destinations, roles, routing, or provider config | **8-12 hours** | Usually at least one troubleshoot/redeploy cycle is needed |
| First installation in a new customer landscape | **12-16 hours** | Discovery and alignment overhead is significant even when deployment itself is straightforward |
| New customer landscape with multiple external dependencies and waiting loops | **16-24 hours** | Basis/BTP/Security coordination dominates elapsed effort |

### What These Hours Cover

- prerequisite review and fit-gap check
- review of customer landscape constraints
- `.mtaext` preparation for external OpenAI-compatible provider
- BTP destination parameter alignment
- build and deploy
- first smoke test
- first troubleshooting cycle
- role assignment validation
- short handover note: URLs, required env values, known limitations

### What Is Usually Not Included

- waiting for entitlements to be assigned
- waiting for Cloud Connector setup
- waiting for SAP ICF activation
- waiting for firewall/network allowlisting
- procurement or approval flow for external LLM provider
- extended workshops, security reviews, or architecture presentations

Those items are customer-side dependencies. They affect wall-clock duration, but should not be confused with pure implementation time.

### Why the Estimate Is Not "Just 2 Hours"

The technical deploy step may be around 1.5-2 hours on a prepared landscape. The paid effort is higher because the engineer is also responsible for:

- validating prerequisites before touching production-like landscape
- preventing a wrong `.mtaext` or wrong destination from causing failed deploy cycles
- checking both planes: MCP connectivity and external LLM connectivity
- proving that chat, roles, and SAP access actually work end-to-end
- documenting enough context so the customer can operate the setup after handover

If the customer buys only "2 hours deploy", they are not buying enough time for proper verification and accountable handover.

### Recommended Statement for Management / Customer

Use this wording:

> For `cloud-llm-hub` with MCP enabled and an external OpenAI-compatible provider, budget **6-8 billable hours** when the customer landscape is ready. Budget **12-16 hours** for a first installation in a new customer landscape. Any missing prerequisites on the customer side extend elapsed duration and may require additional effort.

### Simple Charging Model

Use one of these models:

- **Fixed package: 8 hours** for ready landscape
- **Fixed package: 16 hours** for first customer installation
- **Time & material** beyond package when customer-side blockers appear

This is usually easier to defend than quoting only the happy-path deploy time.

---

## Remember It as 6 Steps

1. Copy `.mtaext` from template
2. Switch provider to `openai`
3. Turn AI Core resource off
4. Point MCP to SAP destination
5. Build and deploy
6. Verify MCP, models, and chat

---

## `.mtaext` Delta

Start from:

```bash
cp .mtaext.template .mtaext
```

Then set the key parameters:

```yaml
parameters:
  LLM_AGENT_PROVIDER: "openai"
  LLM_AGENT_API_KEY: "sk-..."
  LLM_AGENT_BASE_URL: "https://api.openai.com/v1"
  LLM_AGENT_MODEL: "gpt-4o-mini"
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"
  APPROUTER_HOST: "<your-subdomain>-cloud-llm-hub"

resources:
  - name: cloud-llm-hub-ai-core
    active: false
```

Optional but usually useful:

```yaml
parameters:
  LLM_AGENT_CLASSIFIER_MODEL: "gpt-4o-mini"
  LLM_AGENT_EMBEDDING_MODEL: "text-embedding-3-small"
  LLM_AGENT_RAG_TYPE: "vector"
```

Notes:

- `LLM_AGENT_PROVIDER` must be `openai` for OpenAI-compatible APIs
- `LLM_AGENT_BASE_URL` must be the provider's OpenAI-compatible `/v1` endpoint
- `LLM_AGENT_MCP_DESTINATION` must match the BTP Destination name exactly
- `cloud-llm-hub-ai-core.active` must be `false`

---

## Deployment Flow

### 1. Create SAP destination

In BTP Cockpit, create destination:

- Name: same as `LLM_AGENT_MCP_DESTINATION`
- Type: `HTTP`
- URL: SAP host URL
- Authentication: per your landscape
- ProxyType: `OnPremise` or `Internet`

If on-prem:

- Cloud Connector must be registered
- `/sap/bc/adt/**` and `/sap/bc/http/**` must be allowed

### 2. Build

```bash
npx mbt build
```

### 3. Deploy

```bash
cf deploy mta_archives/cloud-llm-hub_<version>.mtar -e .mtaext
```

### 4. Assign roles

Assign one of the role collections:

- `MCP Reader Access`
- `MCP Analyst Access`
- `MCP Developer Access`
- `MCP Full Access`

---

## Smoke Test

### Backend health

```bash
curl -s "https://<srv-url>/mcp/health"
```

Expected: status is `ok`.

### Models endpoint

```bash
curl -s "https://<srv-url>/v1/models" \
  -H "Authorization: Bearer <jwt>"
```

Expected:

- endpoint responds successfully
- your configured external model appears or the endpoint is otherwise healthy

### Chat/UI

Open:

```text
https://<APPROUTER_HOST>.cfapps.<landscape>.hana.ondemand.com/chat/webapp/index.html
```

Test prompt:

```text
Read table T000
```

Expected:

- LLM responds
- MCP tools load
- SAP destination is used

---

## Fast Troubleshooting

### MCP tools do not load

Check:

- destination name equals `LLM_AGENT_MCP_DESTINATION`
- destination is reachable
- Cloud Connector mapping exists
- SAP ICF services are active

### Agent/chat works poorly or fails immediately

Check:

- `LLM_AGENT_PROVIDER=openai`
- `LLM_AGENT_API_KEY` is valid
- `LLM_AGENT_BASE_URL` points to the provider's OpenAI-compatible endpoint
- `LLM_AGENT_MODEL` exists on that provider

### `/v1/*` fails but `/mcp/*` works

This usually means MCP is configured correctly, but the external LLM config is wrong.

### App fails on startup

Check:

- `.mtaext` values were actually passed during deploy
- AI Core resource is disabled for this scenario
- required destination exists

---

## One-Line Reminder

`openai provider + api key + base url + model + sap destination + ai-core inactive`
