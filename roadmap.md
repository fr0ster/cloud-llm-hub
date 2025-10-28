# Cloud-LLM-Hub Roadmap

## 1. Foundation Setup
- [x] Define the vision: a cloud-hosted hub orchestrating multiple MCP servers, an LLM agent, and optional UI.
- [x] Establish the GitHub repository structure (`infra/`, services/, agents/, `docs/`).
- [ ] Draft initial architecture decision records (ADRs) covering security, deployment, and integration strategy.
- [ ] Create baseline continuous integration (GitHub Actions) for linting and tests.

## 2. Infrastructure & Security
- [ ] Provision Cloud Foundry (or selected cloud) organization/space, service accounts, and quotas.
- [ ] Design the authentication layer (approuter + XSUAA or equivalent OAuth provider).
- [ ] Document how clients without header-based auth (Cline, Copilot) can connect (e.g., SSE or stream-http proxy with shared secret).
- [ ] Provide a reference proxy implementation and security checklist.
- [ ] Ensure infrastructure patterns cover both SSE and stream-http tool invocations end-to-end.

## 3. MCP Integration Layer
- [ ] Add existing MCP servers as submodules (for example, `mcp-abap-adt`) with defined interface contracts.
- [ ] Build an orchestrator service that routes requests to target MCP backends via HTTP/SSE.
- [ ] Ensure the orchestration layer consistently supports both SSE and stream-http response modes.
- [ ] Define a tool registry schema supporting runtime discovery, health checks, and permission metadata.

## 4. LLM Agent Enablement
- [ ] Decide on the agent architecture: prompt routing, context management, tool invocation patterns.
- [ ] Select hosting/runtime (container vs. serverless) and logging/monitoring stack.
- [ ] Implement a base agent capable of calling registered MCP tools and returning structured outputs.

## 5. UI & Client Integrations
- [ ] Create a minimal web dashboard for health status, tool catalog, and token management.
- [ ] Publish integration guides for Cline, GitHub Copilot, and custom clients (including auth/proxy instructions).
- [ ] Provide example scripts for SSE proxying and HTTP client interactions.

## 6. Deployment Automation
- [ ] Introduce a CAP-based deployment project (optional) or a standalone MTA pipeline.
- [ ] Implement make deploy-cf, make smoke-test, and rollback strategies.
- [ ] Document environment configuration: required environment variables, secrets, and service bindings.

## 7. Observability & Hardening
- [ ] Add structured logging, metrics, and alerting (e.g., Prometheus or Cloud Foundry log drains).
- [ ] Conduct security reviews: token rotation, rate limiting, audit logging.
- [ ] Pen-test the SSE proxy and MCP access patterns; remediate findings.

## 8. Documentation & Handover
- [ ] Prepare onboarding documentation for adding new MCP integrations and agent plugins.
- [ ] Produce incident runbooks (authorization failures, CF outages).
- [ ] Curate a backlog for future enhancements: additional MCPs, advanced LLM workflows, richer UI components.