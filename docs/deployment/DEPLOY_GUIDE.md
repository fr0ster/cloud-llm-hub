# Deployment Guide

## Prerequisites

1. SAP BTP account with Cloud Foundry space
2. MTA Build Tool installed (`npm install -g mbt`)
3. Cloud Foundry CLI installed

## Setup

### 1. Create MTA Extension File

```bash
# Copy template
cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext

# Edit .mtaext with your actual values
# Replace all YOUR_* placeholders
```

### 2. Configure Parameters in `.mtaext`

Edit `.mtaext` and set:

- **LLM_AGENT_MODEL**: Your LLM model name (e.g., `gpt-4o-mini`, `claude-3-5-sonnet`, `deepseek-chat`)
- **LLM_AGENT_TEMPERATURE**: Temperature (0.0 - 2.0, default: `0.7`)
- **LLM_AGENT_MAX_TOKENS**: Max tokens (default: `2000`)
- **LLM_AGENT_MCP_DESTINATION**: BTP Destination name for ABAP connection

Example:
```yaml
modules:
  - name: cloud-llm-hub-srv
    properties:
      LLM_AGENT_MODEL: "gpt-4o-mini"
      LLM_AGENT_TEMPERATURE: "0.7"
      LLM_AGENT_MAX_TOKENS: "2000"
      LLM_AGENT_MCP_DESTINATION: "DEV_ABAP_SYSTEM"
```

## Build and Deploy

### Option 1: Using npm scripts (Recommended)

The repository already ships these — do not redefine them:

```bash
npm run build      # npx cds b
npm run build:mta  # npx mbt build -t gen/mta_archives --mtar cloud-llm-hub.mtar
npm run deploy     # cf deploy gen/mta_archives/cloud-llm-hub.mtar -e .mtaext --abort-on-error --delete-services -f
```

Run `build:mta` then `deploy`. Note that `deploy` already passes `-e .mtaext`, so the extension
descriptor must exist at the repository root.

### Option 2: Manual commands

#### 1. Build the MTA archive

`mta.yaml` runs `npx cds build --production` in its `before-all` step, so a separate `cds build`
is not needed here.

```bash
mbt build -t gen/mta_archives --mtar cloud-llm-hub.mtar -e .mtaext
```

#### 2. Deploy to Cloud Foundry

```bash
cf deploy gen/mta_archives/cloud-llm-hub.mtar -e .mtaext --abort-on-error --delete-services
```

## Troubleshooting

### Error: "property is not provided"

Make sure you:
1. Created `.mtaext` from template
2. Filled in all required values
3. Used `-e .mtaext` flag in `mbt build` command

### Error: "field not found in type mta.EXT"

Check that parameters are under `properties:` in the module section:

```yaml
modules:
  - name: cloud-llm-hub-srv
    properties:        # ← Important!
      LLM_AGENT_MODEL: "your-model"
```

## Files

- `docs/deployment/templates/*.mtaext.template` - Templates, one per scenario (committed to Git)
- `.mtaext` - Your config (NOT committed, in .gitignore)
- `mta.yaml` - MTA descriptor (committed to Git)

## Persistent RAG on HANA

User and session RAG collections (and session history) can live in SAP HANA Cloud through the
`hana-vector` provider. This is opt-in: with no HANA settings the hub behaves as before.

**1. Service.** An HDI container (`hana` service, plan `hdi-shared`) on your HANA Cloud instance. Create
it once, for example `cf create-service hana hdi-shared hdi-llm`. The MTA binds this existing container
(step 3); it does not create one.

**2. Tables.** The shared layout needs two tables, `RAG_DOCUMENTS` and `RAG_COLLECTIONS`, shipped as
`.hdbtable` files by `@mcp-abap-adt/hana-vector-rag`. Deploy them into the container:

```bash
npm ci
cf login ...                              # target the space that holds the container
tools/deploy-hdi-tables.sh hdi-llm        # service name, default hdi-llm
tools/deploy-hdi-tables.sh --dry-run      # print the steps without calling cf
```

The script pushes a throwaway `@sap/hdi-deploy` app bound to the container, waits up to 5 minutes for
`Deployment to container ... done` in its logs, then deletes the app (retrying while an unbind is in
progress). It exits non-zero on failure. The vector column is fixed at `REAL_VECTOR(1536)`.

**3. `.mtaext`.** `mta.yaml` declares the resource `cloud-llm-hub-hdi` as an inactive, optional
`org.cloudfoundry.existing-service` with a placeholder `service-name`, so nothing changes by default. An
extension descriptor cannot change a resource type, so the `.mtaext` only switches the resource on and
names the container from step 2. Every template in `docs/deployment/templates/` carries this block
commented out:

```yaml
resources:
  - name: cloud-llm-hub-hdi
    active: true
    parameters: { service-name: "hdi-llm" }
```

Then set the backend parameters in the same `.mtaext` (`LLM_AGENT_RAG_BACKEND: "hana-vector"`,
`LLM_AGENT_SESSION_RAG_BACKEND: "hana-vector"`, `LLM_AGENT_HANA_SERVICE: "hdi-llm"`). Remove `active: true`
from the block to turn the resource off again. Staging (`cloud-llm-hub-staging-hdi`) must use a container
of its own: with a shared catalog it would restore and serve production's collections and history.

If you want the MTA to **create** the container instead of binding an existing one, that is a change to
`mta.yaml` itself, not to `.mtaext`: set the resource's `type: com.sap.xs.hdi-container` with
`parameters: { service: hana, service-plan: hdi-shared }`, then deploy the tables (step 2) into the
container the MTA created.

**4. Secrets.** The embedder key (`LLM_AGENT_EMBEDDER_API_KEY`) is not an MTA parameter: put it in the
fork's `.env`, which `tools/deploy.sh` applies with `cf set-env`. HANA credentials come from the service
binding (`VCAP_SERVICES`), not from `.env`.

**5. Health check.** Keep the Cloud Foundry default port health check. If the first restore of collections
fails (HANA unreachable at boot), `/health` answers 503 while the hub retries in the background (30 s,
doubling to 5 min). Switching the app to an `http` health check on `/health` would turn that into a restart
loop, killing the instance that is about to recover. `mta.yaml` sets no `health-check-type`; do not add one.

**6. Dimension and other embedders.** The shipped tables are `REAL_VECTOR(1536)`, matching
`text-embedding-3-small`. Another embedder needs regenerated DDL; the hub then stops at startup with
`SHARED_LAYOUT_NOT_DEPLOYED` instead of running on a mismatched table. The startup log line
`Persistent collections` shows the dimension in force. Behaviour and error codes are in
[CONFIG_USAGE.md](../llm-agent/CONFIG_USAGE.md#persistent-rag-collections).

**Postgres.** `LLM_AGENT_RAG_BACKEND: "pg-vector"` with `LLM_AGENT_PG_URL` (and optionally
`LLM_AGENT_PG_SCHEMA`) in `.mtaext`; `LLM_AGENT_PG_USER` and `LLM_AGENT_PG_PASSWORD` only in `.env`.

HANA is reachable only from Cloud Foundry, so there is no local run against it; use PGlite, Qdrant or
the in-memory providers for local work.

## Multi-Destination Support (v2.2+)

After deployment, Cloud LLM Hub automatically discovers SAP ABAP destinations from BTP Destination Service.

### How It Works

1. Startup does **not** block on any destination — the app is ready immediately. `LLM_AGENT_MCP_DESTINATION` is only an optional "warm this first" hint (no longer privileged).
2. All SAP ABAP destinations are discovered automatically and initialized in the background (equally). The tool vectors are not computed here: `tools/deploy.sh` builds them before `mbt build`. A request to a not-yet-ready destination waits up to `LLM_AGENT_DESTINATION_INIT_WAIT_MS` (default 90s) then is served, instead of erroring.
3. The UI shows all destinations with live status indicators

### Discovery Heuristic

Destinations are included if they match:
- **ProxyType:** `OnPremise`
- **Authentication:** `BasicAuthentication`
- **Not excluded:** OData endpoints, `/srvd_a2x/` services, and technical names (`cloud-connector`, `connectivity`)

### Adding New Destinations

Simply create a new destination in BTP Destination Service with the criteria above. Cloud LLM Hub will discover it automatically (within 5 min cache TTL) — no redeployment needed.

### Per-Request Destination Override

Clients can switch destinations per request using the `X-SAP-Destination` header:

```bash
curl -X POST .../v1/chat/completions \
  -H "X-SAP-Destination: S4HANA_TST" \
  -H "Content-Type: application/json" \
  -d '{"messages": [...]}'
```

## Security

**Never commit `.mtaext`** — it contains sensitive configuration!

The `.mtaext` file is in `.gitignore` and will not be committed to Git.
