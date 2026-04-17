# Deployment Documentation

Deploy and verify Cloud LLM Hub on SAP BTP.

## Documents

- [**Installation Summary**](INSTALLATION_SUMMARY.md) — effort estimation for stakeholders
- [**Installation Plan**](INSTALLATION_PLAN.md) — step-by-step from scratch (~45 min), prerequisites, entitlements
- [**Deploy Guide**](DEPLOY_GUIDE.md) — MTA extension setup, build, and deploy
- [**Quick Deploy**](QUICK_DEPLOY.md) — one-command deployment
- [**Testing After Deployment**](TESTING_AFTER_DEPLOYMENT.md) — health checks and smoke tests

## Architecture

```
main                           Code, templates, docs (never deploy from here)
├── .worktrees/                Local worktrees for deploy branches (gitignored)
│   ├── ai-apps/               deploy/acme-prod
│   ├── ai-apps-stg/           deploy/acme-prod-stg
│   └── acme-sandbox/          deploy/acme-sandbox
│
deploy/acme-prod         .mtaext for acme-prod subaccount
deploy/acme-prod-stg     .mtaext.staging for acme-prod staging
deploy/acme-sandbox            .mtaext for acme-sandbox subaccount
```

### What goes where

| File | Location | In git? | Purpose |
|------|----------|---------|---------|
| `mta.yaml` | main | Yes | MTA structure, module definitions, parameter defaults |
| `mta-staging.yaml` | main | Yes | Staging MTA with separate module names |
| `.mtaext` | deploy/* branch | Yes (force-added) | Per-subaccount config: model, destination, host |
| `.env` | worktree | No (gitignored) | Secrets: AICORE_* credentials |
| `default-env.json` | worktree | No (gitignored) | Local dev: VCAP_SERVICES from BTP |
| `tools/deploy.sh` | main | Yes | Deploy automation script |
| `docs/deployment/templates/` | main | Yes | Starter .mtaext templates |

### Secrets handling

AI Core credentials are **never** stored in git. Two mechanisms:

1. **AI Core binding** (VCAP_SERVICES) — when `cloud-llm-hub-ai-core` service exists in the subaccount. Automatic, no .env needed.
2. **Environment variables** (.env → `cf set-env`) — when AI Core is in a different subaccount. The `.env` file in the worktree contains `AICORE_AUTH_URL`, `AICORE_CLIENT_ID`, `AICORE_CLIENT_SECRET`, `AICORE_BASE_URL`. The deploy script injects them via `cf set-env`.

Priority at runtime: VCAP_SERVICES binding > AICORE_SERVICE_KEY > AICORE_* env vars.

## Deployment Configurations

Choose a template that matches your LLM provider:

| Template | LLM Provider | AI Core | Use Case |
|----------|-------------|---------|----------|
| [`mcp-sap-ai-core`](templates/mcp-sap-ai-core.mtaext.template) | SAP AI Core | Yes | Full SmartAgent with AI Launchpad models |
| [`mcp-openai`](templates/mcp-openai.mtaext.template) | OpenAI / Azure / Ollama / vLLM | No | SmartAgent with any OpenAI-compatible API |
| [`mcp-anthropic`](templates/mcp-anthropic.mtaext.template) | Anthropic API | No | SmartAgent with direct Claude API |
| [`mcp-only`](templates/mcp-only.mtaext.template) | None | No | Pure MCP proxy — Cline/Claude Desktop connect to SAP |
| [`llm-only`](templates/llm-only.mtaext.template) | SAP AI Core | Yes | LLM chat without MCP/SAP connectivity |
| [`staging`](templates/staging.mtaext.template) | SAP AI Core | Yes | Parallel staging instance with separate URL |

## Deploy workflow

### One-command deploy

```bash
# 1. Login to correct subaccount
cf target -o "<org>" -s dev

# 2. Go to worktree and deploy
cd .worktrees/acme-sandbox
../../tools/deploy.sh
```

The script automatically:
- Verifies CF target matches the deploy branch (APPROUTER_HOST vs CF org)
- Rebases deploy branch on main
- Injects AICORE_* secrets from .env via `cf set-env` (only when no binding)
- Builds MTA and deploys with .mtaext

For staging: `../../tools/deploy.sh staging`

### Manual deploy

```bash
cd .worktrees/ai-apps
git rebase main
npx mbt build
cf deploy mta_archives/cloud-llm-hub_*.mtar -e .mtaext
```

## New subaccount setup

### 1. Choose template and create deploy branch

```bash
# From main
git checkout main

# Create branch
git checkout -b deploy/<subaccount-name>

# Copy and edit template
cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext
vi .mtaext   # Set APPROUTER_HOST, destinations, etc.

# Commit and push
git add -f .mtaext
git commit -m "deploy: <subaccount-name> configuration"
git push origin deploy/<subaccount-name>
git checkout main
```

### 2. Create worktree

```bash
git worktree add .worktrees/<short-name> deploy/<subaccount-name>
```

### 3. Add secrets (.env)

Create `.worktrees/<short-name>/.env` with AI Core credentials (if no binding):

```
AICORE_AUTH_URL=https://<subaccount>.authentication.eu10.hana.ondemand.com
AICORE_CLIENT_ID=sb-<service-key-id>
AICORE_CLIENT_SECRET=<secret>
AICORE_BASE_URL=https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com
```

### 4. Deploy

```bash
cf target -o "<org>" -s dev
cd .worktrees/<short-name>
../../tools/deploy.sh
```

### 5. Create DEPLOY.md (required)

Each deploy branch **must** have a `DEPLOY.md` documenting:
- Subaccount details, XSUAA subdomain
- Routes (approuter + srv) and all endpoints
- Mode, provider, model configuration
- SAP destinations
- Required secrets in `.env`
- Branch-specific changes from main
- Installation log (problems encountered and solutions)

Copy template and fill in: `cp docs/deployment/templates/DEPLOY.md.template DEPLOY.md`

After deploy, update DEPLOY.md with actual routes from `cf apps` output.

## Active deploy branches

| Branch | Subaccount | Mode | AI Core | Notes |
|--------|-----------|------|---------|-------|
| `deploy/acme-prod` | acme-subaccount | MCP + AI Core | Binding | Production |
| `deploy/acme-prod-stg` | acme-subaccount | LLM-only | Binding | Staging, no MCP |
| `deploy/acme-sandbox` | acme-sandbox | MCP + AI Core | Via .env | Shared AI Core |
| `deploy/customer-b` | cloud-llm-hub-acme2 (US21) | MCP + OpenAI | Disabled | gpt-5.4-pro, CLD |

## Quick Links

- [Back to Documentation Index](../README.md)
