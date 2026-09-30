# Cloud LLM Hub — Installation Plan for SAP BTP Cloud Foundry

Step-by-step guide to deploy Cloud LLM Hub from scratch on a new BTP subaccount.

## Prerequisites

> **At a new customer, start with the [Readiness Questionnaire](READINESS_QUESTIONNAIRE.md).** It is
> written to be sent as-is and covers what this checklist assumes is already decided: whether a BTP
> subaccount exists, which LLM we may use, whether AI usage is permitted at all, and what SAP access
> we get. Interpret the returned answers with [READINESS_ASSESSMENT.md](READINESS_ASSESSMENT.md).

> **Validate all prerequisites before starting.** If a missing prerequisite is discovered during installation (e.g., entitlement not assigned, ICF service not activated, Cloud Connector path not whitelisted), the process must be paused until the responsible team resolves it. After the fix, the installation restarts from Step 4 (rebuild + redeploy). When multiple teams are involved (Basis, BTP Admin, Security), this can turn a 2-hour installation into a multi-day effort. Completing the checklist below upfront avoids this.

Before starting, ensure the following are in place:

### BTP Subaccount

- [ ] SAP BTP subaccount created (Cloud Foundry environment enabled)
- [ ] Cloud Foundry space created (e.g., `dev`)
- [ ] Subaccount admin or Space Developer role assigned to your user

### Entitlements (Service Plans)

The following entitlements must be available in the subaccount:

| Service | Plan | Purpose | Required |
|---------|------|---------|----------|
| **SAP AI Core** | `extended` | LLM inference (GPT, Claude, Gemini via SAP AI Core Orchestration) | **Scenario A only** |
| **Authorization & Trust Management (XSUAA)** | `application` | Authentication, role-based access | Yes |
| **Destination Service** | `lite` | Route requests to SAP ABAP systems | Yes |
| **Connectivity Service** | `lite` | On-premise system access via Cloud Connector | Yes (for on-prem SAP) |
| **Cloud Foundry Runtime** | — | Application runtime (2.5 GB min per environment: 2 GB backend + 512 MB approuter) | Yes |
| **SAP HANA Cloud** | — | Not required (no database) | No |

The AI Core resource in `mta.yaml` is declared `active: false` and `optional: true`, so it is
inactive unless a `.mtaext` turns it on. Scenario B (an external provider — OpenAI-compatible, or
the native Anthropic or DeepSeek API) needs no AI Core entitlement at all.

### SAP AI Core Setup

- [ ] SAP AI Core instance provisioned. A **service key is not needed for a normal MTA deploy** — the binding delivers credentials via `VCAP_SERVICES`. Create one only for the manual `AICORE_*` env-var path (AI Core living in a different subaccount than the app)
- [ ] At least one LLM model deployed (e.g., `anthropic--claude-4.5-sonnet`, `gpt-4.1-mini`)
- [ ] Embedding model deployed (`text-embedding-3-small`)
- [ ] Resource group configured (default: `default`)

> **No AI Core?** That alone does not disable the agent. Set `LLM_AGENT_PROVIDER` to `openai`,
> `anthropic` or `deepseek`, supply `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL` via `cf set-env`
> (see Step 2), and every endpoint —
> including `/v1/chat/completions` — works exactly as in Scenario A.
>
> Only when **no** provider is configured at all does the deployment fall back to MCP-proxy-only:
> the raw tool surface still serves requests, the agent endpoints do not. That is a useful way to
> test SAP connectivity before any LLM decision has been made.

### SAP ABAP System

- [ ] SAP system accessible from BTP (Cloud Connector for on-prem, or direct for cloud)
- [ ] BTP Destination configured pointing to the SAP system
- [ ] System user or communication arrangement for RFC/ADT access
- [ ] ICF service activated: `/sap/bc/adt` (ADT) — the only endpoint the runtime uses

> **No SAP system yet?** You can deploy without a SAP destination. The service starts, Chat UI loads, LLM responds — but MCP tools won't be available. Add `LLM_AGENT_MCP_DESTINATION` later and redeploy.

### Local Tools

- [ ] Node.js 22+ installed (`package.json` requires `>=22.0.0`; CI runs 22)
- [ ] Cloud Foundry CLI (`cf`) installed and logged in
- [ ] MTA Build Tool (`mbt`) — install via `npm install -g mbt`
- [ ] Git access to the repository

---

## Installation Steps

### Step 1: Clone and Install (5 min)

```bash
git clone <repository-url>
cd cloud-llm-hub
npm install
```

### Step 2: Create MTA Extension File (10 min)

Templates live in `docs/deployment/templates/`. Pick the one for your scenario and copy it to the
repository root as `.mtaext`:

```bash
# Scenario A — SAP AI Core
cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext

# Scenario B — external provider
cp docs/deployment/templates/mcp-openai.mtaext.template .mtaext      # OpenAI-compatible
cp docs/deployment/templates/mcp-anthropic.mtaext.template .mtaext   # native Anthropic

# No SAP system yet (LLM chat only) / no LLM yet (MCP proxy only)
cp docs/deployment/templates/llm-only.mtaext.template .mtaext
cp docs/deployment/templates/mcp-only.mtaext.template .mtaext
```

Then edit it. What you must actually set depends on the scenario — there is no universal minimum:

| Deployment | Must set | Notes |
|------------|----------|-------|
| **Any** | `APPROUTER_HOST` | Subdomain for UI access |
| **Scenario A** — SAP AI Core | `LLM_AGENT_MODEL`, and the AI Core resource switched to `active: true` | The model must be deployed in your AI Core instance |
| **Scenario B** — external provider | `LLM_AGENT_PROVIDER` and `LLM_AGENT_MODEL` in `.mtaext`; `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL` via `cf set-env` **after** deploying (see below) | Leave the AI Core resource inactive |
| **With SAP access** (both scenarios) | `LLM_AGENT_MCP_DESTINATION` | Without it the app starts in LLM-only mode: chat works, ABAP tools do not |

```yaml
parameters:
  # Approuter host (subdomain for UI access)
  APPROUTER_HOST: "<your-subdomain>-cloud-llm-hub"

  # LLM model — for Scenario A it must be deployed in your AI Core instance
  LLM_AGENT_MODEL: "anthropic--claude-4.5-sonnet"

  # SAP system destination (configured in BTP Cockpit > Destinations)
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"

# Scenario A only — enable the AI Core service binding
resources:
  - name: cloud-llm-hub-ai-core
    active: true
```

**Scenario B — the API key and base URL are not `.mtaext` parameters.** `mta.yaml` does not
declare `LLM_AGENT_API_KEY` or `LLM_AGENT_BASE_URL`, so a value placed in `.mtaext` is silently
dropped and never reaches the container — and a secret does not belong in an extension descriptor
anyway. Set them on the deployed app instead:

```bash
cf set-env cloud-llm-hub-srv LLM_AGENT_API_KEY  "<your-api-key>"
cf set-env cloud-llm-hub-srv LLM_AGENT_BASE_URL "https://api.openai.com/v1"
cf restart cloud-llm-hub-srv
```

Strictly speaking `LLM_AGENT_MODEL` also has a code fallback (`gpt-4o-mini`) and
`LLM_AGENT_MCP_DESTINATION` may be empty, but neither default is useful in a real deployment —
treat the table above as the practical minimum.

**Everything else is optional** — the defaults below are what a deployment gets if you leave the
parameter out. Add one only when you actually need to change the behaviour:

| Parameter | Default | When you need it |
|-----------|---------|------------------|
| `LLM_AGENT_CLASSIFIER_MODEL` | falls back to `LLM_AGENT_MODEL` | Only to route classification to a cheaper model. A separate deployed model is not a prerequisite |
| `LLM_AGENT_EMBEDDING_MODEL` | `text-embedding-3-small` | Only when your provider names the model differently |
| `LLM_AGENT_RAG_TYPE` | `in-memory` (keyword-only) | Set to `vector` for semantic tool selection — requires a reachable embeddings endpoint |
| `DESTINATION_MAPPING` | empty | Only for CALM or other external callers that address systems as `DEV.100` instead of a destination name |
| `LLM_AGENT_RAG_QUERY_K` | `15` in `mta.yaml` (code fallback is `5`) | Tuning how many tools reach the model |

For Scenario B, replace the AI Core block with `LLM_AGENT_PROVIDER`, `LLM_AGENT_API_KEY` and
`LLM_AGENT_BASE_URL`, and leave the AI Core resource inactive.

### Step 3: Configure BTP Destination (10 min)

In BTP Cockpit → Subaccount → Destinations, manually create the destination:

1. Create destination pointing to your SAP system:
   - **Name**: must match `LLM_AGENT_MCP_DESTINATION` (e.g., `S4HANA_DEV`)
   - **Type**: HTTP
   - **URL**: `https://<sap-host>:<port>`
   - **Authentication**: BasicAuthentication or PrincipalPropagation
   - **ProxyType**: OnPremise (via Cloud Connector) or Internet

2. For on-premise systems — ensure Cloud Connector is configured:
   - Virtual host mapped to the SAP system
   - Access control for `/sap/bc/adt/**`

> This step is mandatory — without a destination the agent has no SAP system to connect to and MCP tools will not load.

### Step 4: Build MTA Archive (2 min)

```bash
npx mbt build
```

Output: `mta_archives/cloud-llm-hub_<version>.mtar`

### Step 5: Deploy to Cloud Foundry (5 min)

```bash
# Login to CF (if not already)
cf login -a https://api.cf.<landscape>.hana.ondemand.com

# Deploy with extension
cf deploy mta_archives/cloud-llm-hub_<version>.mtar -e .mtaext
```

Deployment creates:
- `cloud-llm-hub-srv` — backend (CAP Node.js)
- `cloud-llm-hub` — approuter (UI access)
- Service instances: xsuaa, destination, connectivity, ai-core

### Step 6: Assign Role Collections (5 min)

In BTP Cockpit → Subaccount → Security → Role Collections:

1. Find role collections created by XSUAA:
   - **MCP Reader Access** — read-only (browse, search ABAP objects)
   - **MCP Analyst Access** — read + analysis (SQL, dumps, profiling)
   - **MCP Developer Access** — create / update / delete / activate via the high-level tools
   - **MCP Full Access** — all tool groups

2. Assign appropriate role collection to your user(s)

### Step 7: Verify Deployment (5 min)

```bash
# Check apps are running
cf apps | grep cloud-llm-hub

# Check health (use srv URL)
SRV_URL=$(cf app cloud-llm-hub-srv | grep routes | awk '{print $2}')
curl -s "https://$SRV_URL/mcp/health" | python3 -m json.tool

# Get your API key — two options:
# Option A: Open the token page in browser (requires approuter login):
#   https://<APPROUTER_HOST>.cfapps.<landscape>.hana.ondemand.com/chat/webapp/token.html
#
# Option B: Via CF CLI (service key + client_credentials grant):
cf create-service-key cloud-llm-hub-auth api-key
CREDS=$(cf service-key cloud-llm-hub-auth api-key 2>/dev/null | tail -n +2)
CLIENT_ID=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientid'])")
CLIENT_SECRET=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['clientsecret'])")
TOKEN_URL=$(echo "$CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read(),strict=False); c=d.get('credentials',d); print(c['url'])")
TOKEN=$(curl -s -X POST "$TOKEN_URL/oauth/token" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Check models endpoint
curl -s "https://$SRV_URL/v1/models" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected health response:
```json
{
  "status": "ok",
  "session": "<session-id>"
}
```

### Step 8: Access Chat UI (2 min)

Open the approuter URL in a browser:

```
https://<APPROUTER_HOST>.cfapps.<landscape>.hana.ondemand.com/chat/webapp/index.html
```

You should see:
- LLM model selector (populated from AI Core)
- Destination selector (your SAP system)
- Status: READY (after agent initialization)

### Step 9: Test Chat (2 min)

Send a test message in the chat UI:

```
Read table T000
```

Expected: agent calls MCP tools → reads SAP table → returns result.

---

## Optional Steps

### Connect Claude CLI via ANTHROPIC_BASE_URL (5 min)

Cloud LLM Hub exposes an Anthropic-compatible endpoint at `/v1/messages`. To use Claude CLI:

```bash
export ANTHROPIC_BASE_URL=https://<SRV_URL>
export ANTHROPIC_API_KEY=<your-xsuaa-jwt-token>
claude  # connects to your SAP system via cloud-llm-hub
```

### Connect Cline / Goose / other AI tools (5 min)

Use the OpenAI-compatible endpoint `/v1/chat/completions` with any tool that supports custom base URL:

```
Base URL: https://<SRV_URL>/v1
API Key: <your-xsuaa-jwt-token>
```

### Connect MCP clients (Cline, Claude Desktop) (5 min)

Use the MCP endpoint directly:

```
POST https://<SRV_URL>/mcp/stream/http
Header: X-SAP-Destination: <destination-name>
```

### Deploy without AI Core

AI Core is already inactive in `mta.yaml` (`active: false`, `optional: true`), so there is nothing
to switch off — simply do not activate it in `.mtaext`.

What you get then depends on whether another provider is configured:

- **External provider set** (`LLM_AGENT_PROVIDER` = `openai` | `anthropic` | `deepseek`, plus
  `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL`) — this is Scenario B. The agent and
  `/v1/chat/completions` work normally; no AI Core involved.
- **No provider at all** — MCP-proxy-only mode. The raw tool surface works; the agent endpoints do
  not. Fine for validating SAP connectivity first.

### Add additional SAP destinations

Additional SAP systems are auto-discovered from BTP Destination service. Create a new destination in BTP Cockpit — it appears in the UI destination selector after restart or `POST /v1/destinations/refresh`.

### Set up Approuter custom domain

Override `APPROUTER_HOST` in `.mtaext` to use a meaningful subdomain instead of the auto-generated one.

---

## Known Issues and Force-Majeure

### Entitlements not available

**Symptom**: Cannot find the required service plan in BTP Cockpit.

**Resolution**: Contact your BTP Global Account admin to assign entitlements to your subaccount. Common missing entitlements:
- AI Core `extended` plan — requires AI Foundation booster or manual assignment
- Connectivity `lite` — not available in trial accounts

**Workaround**: Deploy without AI Core (`active: false`) or without Connectivity (skip on-prem SAP).

### Cloud Connector not registered for subaccount

**Symptom**: Destination shows "reachable" in BTP Cockpit but MCP tools fail with connection errors.

**Resolution**: Cloud Connector admin must register the subaccount in Cloud Connector admin UI. Each subaccount needs a separate registration.

**Impact**: On-premise SAP systems are unreachable. Cloud systems work fine.

### AI Core model deployment quota exceeded

**Symptom**: `cf deploy` succeeds but agent fails with "model not found" or "quota exceeded".

**Resolution**: Check AI Launchpad → ML Operations → Deployments. Free tier allows limited concurrent deployments. Stop unused deployments to free capacity.

### CF deploy fails with "Service broker error"

**Symptom**: `cf deploy` fails during service creation with broker errors.

**Resolution**:
- Check if service instances already exist from a previous deployment: `cf services`
- If corrupted, delete manually: `cf delete-service <name> -f`
- Retry deploy

### Approuter returns 502 Bad Gateway

**Symptom**: UI loads but shows 502 errors on API calls.

**Resolution**: Approuter can't reach the backend. Check:
- `cf app cloud-llm-hub-srv` — is the backend running?
- Check if `srv-api` route is bound correctly: `cf routes`
- Restart approuter: `cf restart cloud-llm-hub`

### SAP AI Core streaming errors (500 on 2nd+ tool iteration)

**Symptom**: First tool call works, subsequent iterations fail with `code: 500, location: "LLM Module"`.

**Resolution**: This is a known SAP AI Core Orchestration issue with streaming + Anthropic models + tool use. The service uses `FallbackLlmCallStrategy` — it automatically falls back to non-streaming on failure. (An earlier version of this entry suggested a pipeline-mode variable; `mta.yaml` still passes one, but no code reads it, so setting it changes nothing.)

### Token usage unexpectedly high

**Symptom**: Simple requests consume 50K+ input tokens.

**Resolution**: Check how many tools reach the model. `LLM_AGENT_RAG_QUERY_K` is set to **15** in `mta.yaml`, so that — not the code fallback of `5` — is what a BTP deployment runs with; lowering it cuts input tokens directly. Also verify `refreshToolsPerIteration: false`.

---

## Time Estimate Summary

| Step | Description | Time |
|------|-------------|------|
| 1 | Clone and install | 10 min |
| 2 | Create .mtaext | 15 min |
| 3 | Configure BTP Destination | 15-30 min |
| 4 | Build MTA | 5 min |
| 5 | Deploy to CF | 10 min |
| 6 | Assign roles | 10 min |
| 7-9 | Verify, access UI, test chat | 30 min |
| | **Total (happy path)** | **~2 hours** |

> Prerequisites (AI Core setup, Cloud Connector, Destination) may take additional hours or days depending on organization. Budget at least 1 extra day for first deployment at a new customer.

---

## Troubleshooting

### App fails to start

```bash
cf logs cloud-llm-hub-srv --recent | grep -i error
```

Common causes:
- No LLM provider at all → either activate the AI Core binding (`active: true` in `.mtaext`) **or** set `LLM_AGENT_PROVIDER` with `LLM_AGENT_API_KEY` and `LLM_AGENT_BASE_URL`
- Missing destination → verify destination name matches `LLM_AGENT_MCP_DESTINATION`
- Missing entitlements → check subaccount entitlements in BTP Cockpit

### "Agent initialization failed"

Scenario A (SAP AI Core):
- AI Core model not deployed → deploy model in AI Launchpad
- Wrong model name → check `LLM_AGENT_MODEL` matches deployed model ID

Scenario B (external provider):
- Wrong or missing `LLM_AGENT_BASE_URL` / `LLM_AGENT_API_KEY`
- `LLM_AGENT_MODEL` not offered by that provider
- Egress to the provider endpoint not allowlisted from Cloud Foundry

### MCP tools not loading

- Destination unreachable → test destination in BTP Cockpit (Check Connection)
- Cloud Connector not configured → check virtual host mapping
- ICF services not activated → activate `/sap/bc/adt` in SAP transaction SICF

### 401 Unauthorized

- Role collection not assigned → assign to your user in BTP Cockpit
- Token expired → re-authenticate

### Chat returns empty response

- Check `cf logs cloud-llm-hub-srv --recent` for errors
- Verify SAP system is reachable: destination status should be "ready" in UI

---

## Next Steps

- [Testing After Deployment](TESTING_AFTER_DEPLOYMENT.md) — comprehensive testing guide
- [Architecture](../architecture/ARCHITECTURE.md) — system architecture and configuration reference
