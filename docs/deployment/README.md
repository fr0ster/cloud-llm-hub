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
| [`mcp-only`](mcp-only.mtaext.template) | None | No | Pure MCP proxy — Cline/Claude Desktop connect to SAP |
| [`mcp-sap-ai-core`](mcp-sap-ai-core.mtaext.template) | SAP AI Core | Yes | Full SmartAgent with AI Launchpad models |
| [`mcp-openai`](mcp-openai.mtaext.template) | OpenAI / Azure / Ollama / vLLM | No | SmartAgent with any OpenAI-compatible API |
| [`mcp-anthropic`](mcp-anthropic.mtaext.template) | Anthropic API | No | SmartAgent with direct Claude API |
| [`staging`](staging.mtaext.template) | SAP AI Core | Yes | Parallel staging instance with separate URL |

```bash
# 1. Copy template
cp docs/deployment/mcp-sap-ai-core.mtaext.template .mtaext

# 2. Edit values (API keys, destinations, hostname)
vi .mtaext

# 3. Build and deploy
npx mbt build && cf deploy mta_archives/cloud-llm-hub_*.mtar -e .mtaext
```

### Parallel Deployments

To run multiple instances (e.g., production + staging), each `.mtaext` must have a unique `ID` and `APPROUTER_HOST`. See [`staging.mtaext.template`](staging.mtaext.template) for an example.

## Quick Links

- [Back to Documentation Index](../README.md)
