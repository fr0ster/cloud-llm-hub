# Deployment Documentation

Deploy and verify Cloud LLM Hub on SAP BTP.

## Documents

- [**Readiness Questionnaire**](READINESS_QUESTIONNAIRE.md) — send to the customer before scoping: BTP, LLM provider, AI usage permission, SAP access
- [**Reading the Questionnaire**](READINESS_ASSESSMENT.md) — internal: answer → blocker / scenario / effort
- [**Installation Summary**](INSTALLATION_SUMMARY.md) — effort estimation for stakeholders
- [**Installation Plan**](INSTALLATION_PLAN.md) — step-by-step from scratch (~45 min), prerequisites, entitlements
- [**Deploy Guide**](DEPLOY_GUIDE.md) — MTA extension setup, build, and deploy
- [**Quick Deploy**](QUICK_DEPLOY.md) — one-command deployment
- [**Testing After Deployment**](TESTING_AFTER_DEPLOYMENT.md) — health checks and smoke tests

## Architecture: one private fork per subaccount

This repository holds only generic code, templates and docs — nothing tied to a
system, subaccount or customer, and **nothing is deployed from it**. Every
deployment lives in its own **private fork**, one fork per BTP subaccount:

```
cloud-llm-hub (this repo, public)     code, templates, docs — never deployed
        │  fork (clone + upstream remote)
        ▼
<deployment>-fork (private)
├── main                              mirror of upstream main (release tags)
└── deploy/<subaccount>               main + ONE commit: .mtaext, DEPLOY.md, …
```

- The fork's `main` only tracks upstream; the deploy branch adds files on top of it.
- Updating: fetch upstream, move the fork's `main` to the release tag, merge `main`
  into the deploy branch (`tools/deploy.sh` does the merge), deploy.
- A deploy branch should only **add** files. Overriding a tracked file (for example
  an `xs-security*.json`) is possible, but then each upstream update may conflict.

### What goes where

| File | Location | In git? | Purpose |
|------|----------|---------|---------|
| `mta.yaml` | upstream | Yes | MTA structure, module definitions, generic parameter defaults |
| `mta.staging.generated.yaml` | fork checkout | No (gitignored) | Staging MTA — generated from `mta.yaml` at deploy time by `tools/make-staging-mta.js` (renames identifiers to `*-staging`); never edited or committed |
| `xs-security*.generated.json` | fork checkout | No (gitignored) | Staging XSUAA descriptors — generated alongside the staging MTA with the same `*-staging` rename |
| `.mtaext` / `.mtaext.staging` | fork deploy branch | Yes (force-added) | Per-subaccount config: CF landscape, host, model, destinations |
| `DEPLOY.md` | fork deploy branch | Yes | That deployment's record: routes, endpoints, secrets needed, install log |
| `.env` | fork checkout | No (gitignored) | Secrets: AICORE_* credentials |
| `default-env.json` | fork checkout | No (gitignored) | Local dev: VCAP_SERVICES from BTP |
| `tools/deploy.sh` | upstream | Yes | Deploy automation script |
| `docs/deployment/templates/` | upstream | Yes | Starter .mtaext and DEPLOY.md templates |

### Secrets handling

AI Core credentials are **never** stored in git. Two mechanisms:

1. **AI Core binding** (VCAP_SERVICES) — when `cloud-llm-hub-ai-core` service exists in the subaccount. Automatic, no .env needed.
2. **Environment variables** (.env → `cf set-env`) — when AI Core is in a different subaccount. The `.env` file in the fork checkout contains `AICORE_AUTH_URL`, `AICORE_CLIENT_ID`, `AICORE_CLIENT_SECRET`, `AICORE_BASE_URL`. The deploy script injects them via `cf set-env`.

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

Run everything in the fork's checkout, on its deploy branch.

### One-command deploy

```bash
# 1. Login to the subaccount this fork belongs to
cf target -o "<org>" -s dev

# 2. Deploy from the deploy branch
git switch deploy/<subaccount>
tools/deploy.sh             # production (.mtaext)
tools/deploy.sh staging     # staging (.mtaext.staging)
```

The script:
- verifies the CF target matches the deploy branch (APPROUTER_HOST vs CF org);
- merges the fork's `main` into the deploy branch;
- injects AICORE_* secrets from `.env` via `cf set-env` (only when there is no binding);
- builds the MTA and deploys it with the `.mtaext`.

### Manual deploy

```bash
git merge main
npx mbt build
cf deploy mta_archives/cloud-llm-hub_*.mtar -e .mtaext
```

## New deployment: create its fork

### 1. Create the private fork

Create an **empty private** repository wherever the deployment is hosted (GitHub,
GitLab, …) — no README, no licence — then:

```bash
git clone --origin upstream https://github.com/fr0ster/cloud-llm-hub.git <deployment>
cd <deployment>
git remote add origin <private-repo-url>
git switch --detach <release-tag> && git switch -C main   # start from a release
git push -u origin main
```

### 2. Add the deploy branch

```bash
git switch -c deploy/<subaccount>
cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext
vi .mtaext          # CF_LANDSCAPE (required), APPROUTER_HOST, destinations, model, …
cp docs/deployment/templates/DEPLOY.md.template DEPLOY.md
git add -f .mtaext DEPLOY.md
git commit -m "deploy: <subaccount> configuration"
git push -u origin deploy/<subaccount>
```

### 3. Add secrets (.env)

Create `.env` in the fork checkout with AI Core credentials (only when there is no binding):

```
AICORE_AUTH_URL=https://<subaccount>.authentication.<region>.hana.ondemand.com
AICORE_CLIENT_ID=sb-<service-key-id>
AICORE_CLIENT_SECRET=<secret>
AICORE_BASE_URL=https://api.ai.prod.<region>.aws.ml.hana.ondemand.com
```

### 4. Deploy, then fill in DEPLOY.md

Deploy as above, then record the actual routes (`cf apps`), endpoints, mode, provider,
model, SAP destinations, required secrets and the installation log in `DEPLOY.md`.

### Updating a deployment

```bash
git fetch upstream --tags
git switch main && git merge --ff-only <new-release-tag> && git push
git switch deploy/<subaccount> && tools/deploy.sh
```

## Quick Links

- [Back to Documentation Index](../README.md)
