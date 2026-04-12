# Cloud LLM Hub — Customer Installation Effort Step by Step

Scenario: install `cloud-llm-hub` for a customer with MCP enabled and an external OpenAI-compatible provider.

## Subaccount Prerequisites

Before deployment starts, the following should already exist in the customer subaccount:

- **Cloud Foundry is enabled for the target subaccount and space.**  
  The application is deployed as an MTA to Cloud Foundry. Org and space must be created and accessible.
- **Required entitlements and service quotas are assigned** (see [Required BTP Entitlements](#required-btp-entitlements) below).  
  All listed services must have sufficient quota in the subaccount before deployment.
- **A destination to the target SAP system exists and is reachable from BTP.**  
  Destination name, authentication type (e.g. BasicAuthentication, OAuth2SAMLBearerAssertion), and target URL must be agreed with the customer.
- **Cloud Connector is configured if the SAP backend is on-premise.**  
  Virtual host mappings and exposed backend paths must be set up. Without this, the destination exists but connections will fail.
- **Identity and authorization setup is ready.**  
  An IDP trust configuration must exist for the subaccount. Role collections `MCP_Connector` and `MCP_Admin` will be created during deployment and need to be assigned to users.
- **External OpenAI-compatible provider details are available.**  
  The following parameters must be prepared and will be set in `.mtaext` during configuration:
  - `LLM_AGENT_PROVIDER`: `openai`
  - `LLM_AGENT_BASE_URL`: provider base URL (e.g. `https://api.openai.com/v1`)
  - `LLM_AGENT_API_KEY`: API key or secret for the provider
  - `LLM_AGENT_MODEL`: model identifier (e.g. `gpt-4o`, `claude-sonnet-4-20250514`)
- **Installer has the required BTP permissions.**  
  Space Developer role in the target CF space. Access to create/update service instances, manage destinations, and assign role collections.

## Required BTP Entitlements

The following entitlements must be assigned to the subaccount before deployment.

- **Cloud Foundry Runtime** — plan: `MEMORY` (or free tier).  
  Comment: application runtime for `cloud-llm-hub-srv` and approuter modules. At least 512 MB recommended.
- **Authorization and Trust Management (XSUAA)** — plan: `application`.  
  Comment: provides OAuth 2.0 authentication and role-based authorization. Without it the app cannot verify user identity or enforce role checks.
- **Destination Service** — plan: `lite`.  
  Comment: used to resolve SAP backend destinations at runtime. The app reads destination configuration from BTP, so this service must be bound.
- **Connectivity Service** — plan: `lite`.  
  Comment: required for on-premise SAP system access via Cloud Connector. Can be omitted if all target backends are internet-facing.

> **Note:** SAP AI Core entitlement is not required for this scenario. It is only needed when `LLM_AGENT_PROVIDER=sap-ai-sdk`.

## Step-by-Step Effort

| Step | Action | Time | Why this time is needed |
|------|--------|------|-------------------------|
| 1 | Review prerequisites and customer inputs | **1-2 h** | Before any deployment, someone must check whether BTP access, destination name, SAP endpoint, provider URL, API key, and required roles are actually available. This prevents losing time on avoidable failed deploy cycles. |
| 2 | Prepare installation configuration | **0.5-1 h** | `.mtaext` must be adjusted for the customer landscape: provider, base URL, model, MCP destination, approuter host, and AI Core deactivation. This is simple work, but it must be done carefully because one wrong parameter can break startup. |
| 3 | Validate SAP destination and connectivity assumptions | **0.5-1.5 h** | Even when the destination already exists, it must be checked against the intended SAP system, authentication mode, and routing path. For on-prem systems, this often includes confirming Cloud Connector assumptions before deployment. |
| 4 | Build the application artifact | **0.5 h** | The project must be built into the deployable MTA archive. This is usually short, but it is still a required execution step and may expose missing local or project-side issues. |
| 5 | Deploy to BTP Cloud Foundry | **0.5-1 h** | The deployment itself is not just one command; it includes monitoring deployment progress, verifying service bindings, and checking that backend and approuter come up correctly. |
| 6 | Assign and verify roles | **0.5-1 h** | Installation is not usable until the user can actually authenticate and access the required MCP/agent capabilities. This step is necessary to avoid a technically deployed but unusable system. |
| 7 | Run backend smoke tests | **0.5-1 h** | After deploy, the backend must be checked for health, MCP readiness, and LLM endpoint behavior. This verifies that both SAP-side and LLM-side connectivity are working, not only that the app is running. |
| 8 | Run end-to-end UI/chat validation | **0.5-1 h** | The installation is only complete when the user-facing flow works: login, destination selection, MCP tool availability, and chat execution against SAP. This catches issues that do not appear in low-level health checks. |
| 9 | First troubleshooting and one redeploy cycle | **1-2 h** | In real customer landscapes, the first run often reveals one misconfiguration: wrong destination name, wrong provider URL, role issue, route issue, or connectivity issue. A realistic estimate must include the first correction cycle. |
| 10 | Handover note and closure | **0.5 h** | Someone must record the final deployed URL, active model/provider settings, destination used, and any customer-side follow-up items. Without this, the installation is harder to support after handover. |

## Recommended Total

| Situation | Total effort |
|----------|--------------|
| Ready customer landscape | **6-8 h** |
| First installation in a new customer landscape | **12-16 h** |

## Why Not Estimate Only 2 Hours

`1.5-2 h` is close to the happy-path technical deploy only.

The customer should pay for the full installation responsibility:

- prepare correct configuration
- deploy
- verify backend
- verify UI and chat
- fix the first real issue found during validation
- hand over a working setup
