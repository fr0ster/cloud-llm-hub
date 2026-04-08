# Cloud LLM Hub — Installation Plan for SAP BTP Cloud Foundry

Step-by-step guide to deploy Cloud LLM Hub from scratch on a new BTP subaccount.

## Prerequisites

Before starting, ensure the following are in place:

### BTP Subaccount

- [ ] SAP BTP subaccount created (Cloud Foundry environment enabled)
- [ ] Cloud Foundry space created (e.g., `dev`)
- [ ] Subaccount admin or Space Developer role assigned to your user

### Entitlements (Service Plans)

The following entitlements must be available in the subaccount:

| Service | Plan | Purpose | Required |
|---------|------|---------|----------|
| **SAP AI Core** | `extended` | LLM inference (GPT, Claude, Gemini via SAP AI Core Orchestration) | Yes |
| **Authorization & Trust Management (XSUAA)** | `application` | Authentication, role-based access | Yes |
| **Destination Service** | `lite` | Route requests to SAP ABAP systems | Yes |
| **Connectivity Service** | `lite` | On-premise system access via Cloud Connector | Yes (for on-prem SAP) |
| **Cloud Foundry Runtime** | — | Application runtime (256 MB min) | Yes |
| **SAP HANA Cloud** | — | Not required (no database) | No |

### SAP AI Core Setup

- [ ] SAP AI Core instance provisioned
- [ ] At least one LLM model deployed (e.g., `anthropic--claude-4.5-sonnet`, `gpt-4.1-mini`)
- [ ] Embedding model deployed (`text-embedding-3-small`)
- [ ] Resource group configured (default: `default`)

### SAP ABAP System

- [ ] SAP system accessible from BTP (Cloud Connector for on-prem, or direct for cloud)
- [ ] BTP Destination configured pointing to the SAP system
- [ ] System user or communication arrangement for RFC/ADT access
- [ ] ICF services activated: `/sap/bc/adt` (ADT), `/sap/bc/http` (HTTP)

### Local Tools

- [ ] Node.js 20+ installed
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

Copy the template and fill in your subaccount-specific values:

```bash
cp .mtaext.template .mtaext
```

Edit `.mtaext` — minimum required parameters:

```yaml
parameters:
  # LLM Model (must be deployed in your AI Core instance)
  LLM_AGENT_MODEL: "anthropic--claude-4.5-sonnet"

  # SAP system destination (configured in BTP Cockpit > Destinations)
  LLM_AGENT_MCP_DESTINATION: "S4HANA_DEV"

  # Classifier model (cheaper model for classification tasks)
  LLM_AGENT_CLASSIFIER_MODEL: "gpt-4.1-mini"

  # Embedding model for RAG semantic search
  LLM_AGENT_EMBEDDING_MODEL: "text-embedding-3-small"

  # RAG type: "vector" (semantic search) or "in-memory" (keyword only)
  LLM_AGENT_RAG_TYPE: "vector"

  # Approuter host (subdomain for UI access)
  APPROUTER_HOST: "<your-subdomain>-cloud-llm-hub"

# Enable AI Core service binding
resources:
  - name: cloud-llm-hub-ai-core
    active: true
```

### Step 3: Configure BTP Destination (10 min)

In BTP Cockpit → Subaccount → Destinations:

1. Create destination pointing to your SAP system:
   - **Name**: must match `LLM_AGENT_MCP_DESTINATION` (e.g., `S4HANA_DEV`)
   - **Type**: HTTP
   - **URL**: `https://<sap-host>:<port>`
   - **Authentication**: BasicAuthentication or PrincipalPropagation
   - **ProxyType**: OnPremise (via Cloud Connector) or Internet

2. For on-premise systems — ensure Cloud Connector is configured:
   - Virtual host mapped to the SAP system
   - Access control for `/sap/bc/adt/**` and `/sap/bc/http/**`

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
   - **MCP Developer Access** — CRUD via compact handlers
   - **MCP Full Access** — all tool groups

2. Assign appropriate role collection to your user(s)

### Step 7: Verify Deployment (5 min)

```bash
# Check apps are running
cf apps | grep cloud-llm-hub

# Check health (use srv URL)
SRV_URL=$(cf app cloud-llm-hub-srv | grep routes | awk '{print $2}')
curl -s "https://$SRV_URL/mcp/health" | python3 -m json.tool

# Check models endpoint (requires auth)
# Get a JWT token first, then:
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

## Time Estimate Summary

| Step | Description | Time |
|------|-------------|------|
| 1 | Clone and install | 5 min |
| 2 | Create .mtaext | 10 min |
| 3 | Configure BTP Destination | 10 min |
| 4 | Build MTA | 2 min |
| 5 | Deploy to CF | 5 min |
| 6 | Assign roles | 5 min |
| 7 | Verify deployment | 5 min |
| 8 | Access UI | 2 min |
| 9 | Test chat | 2 min |
| | **Total** | **~45 min** |

> Prerequisites (AI Core setup, Cloud Connector, Destination) may take additional 30-60 min if not already configured.

---

## Troubleshooting

### App fails to start

```bash
cf logs cloud-llm-hub-srv --recent | grep -i error
```

Common causes:
- Missing AI Core binding → check `active: true` in `.mtaext`
- Missing destination → verify destination name matches `LLM_AGENT_MCP_DESTINATION`
- Missing entitlements → check subaccount entitlements in BTP Cockpit

### "Agent initialization failed"

- AI Core model not deployed → deploy model in AI Launchpad
- Wrong model name → check `LLM_AGENT_MODEL` matches deployed model ID

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
