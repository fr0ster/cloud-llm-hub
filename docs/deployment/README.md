# Deployment Documentation

Deploy and verify Cloud LLM Hub on SAP BTP.

## Documents

- [**Installation Summary**](INSTALLATION_SUMMARY.md) — effort estimation for stakeholders
- [**Installation Plan**](INSTALLATION_PLAN.md) — step-by-step from scratch (~45 min), prerequisites, entitlements
- [**Deploy Guide**](DEPLOY_GUIDE.md) — MTA extension setup, build, and deploy
- [**Quick Deploy**](QUICK_DEPLOY.md) — one-command deployment
- [**Testing After Deployment**](TESTING_AFTER_DEPLOYMENT.md) — health checks and smoke tests

## Deployment Configurations

Choose a `.mtaext.template` that matches your LLM provider, copy it to the project root as `.mtaext`, fill in your values, and deploy.

| Template | LLM Provider | AI Core | Use Case |
|----------|-------------|---------|----------|
| [`mcp-only`](templates/mcp-only.mtaext.template) | None | No | Pure MCP proxy — Cline/Claude Desktop connect to SAP |
| [`mcp-sap-ai-core`](templates/mcp-sap-ai-core.mtaext.template) | SAP AI Core | Yes | Full SmartAgent with AI Launchpad models |
| [`mcp-openai`](templates/mcp-openai.mtaext.template) | OpenAI / Azure / Ollama / vLLM | No | SmartAgent with any OpenAI-compatible API |
| [`mcp-anthropic`](templates/mcp-anthropic.mtaext.template) | Anthropic API | No | SmartAgent with direct Claude API |
| [`llm-only`](templates/llm-only.mtaext.template) | SAP AI Core | Yes | LLM chat without MCP/SAP connectivity |
| [`staging`](templates/staging.mtaext.template) | SAP AI Core | Yes | Parallel staging instance with separate URL |

### New subaccount setup

```bash
# 1. Copy template
cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext

# 2. Edit values (API keys, destinations, hostname)
vi .mtaext

# 3. Create a deploy branch
git checkout main
git checkout -b deploy/<subaccount-name>
git add -f .mtaext
git commit -m "deploy: <subaccount-name> configuration"
git push origin deploy/<subaccount-name>
```

## Deploying from branches

Each subaccount has a dedicated `deploy/*` branch with its `.mtaext` configuration. Deploy workflow:

```bash
# 1. Switch to deploy branch and sync with main
git checkout deploy/<subaccount-name>
git rebase main

# 2. Build and deploy
npx mbt build
cf deploy mta_archives/cloud-llm-hub_*.mtar -e .mtaext

# 3. Return to main
git checkout main
```

### Active deploy branches

| Branch | Subaccount | Mode |
|--------|-----------|------|
| `deploy/acme-prod` | acme-subaccount | MCP + AI Core |
| `deploy/acme-prod-stg` | acme-subaccount (staging) | LLM-only |
| `deploy/acme-sandbox` | acme-sandbox | MCP + AI Core |

### Parallel Deployments (staging)

For staging instances in the same subaccount, use `mta-staging.yaml` with separate module names:

```bash
git checkout deploy/<subaccount-name>-stg
npx mbt build -f mta-staging.yaml
cf deploy mta_archives/cloud-llm-hub-staging_*.mtar -e .mtaext.staging
```

## Quick Links

- [Back to Documentation Index](../README.md)
