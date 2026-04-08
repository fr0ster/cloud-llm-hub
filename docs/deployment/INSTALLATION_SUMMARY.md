# Cloud LLM Hub — Installation Summary

Quick reference for effort estimation. Full details in [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md).

## Prerequisites

| Requirement | Who provides | Lead time |
|-------------|-------------|-----------|
| BTP Subaccount with CF environment | BTP Global Account Admin | 1-5 days (if new) |
| Entitlements: AI Core (extended), XSUAA, Destination, Connectivity | BTP Global Account Admin | 1-3 days |
| SAP AI Core instance + LLM model deployed | AI Core Admin | 1-2 hours |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min - 2 hours |
| Cloud Connector configured (on-prem only) | Basis Admin | 2-4 hours |
| SAP system user + ICF services activated (`/sap/bc/adt`, `/sap/bc/http`) | Basis Admin | 1-4 hours |

> Lead times assume approvals are in place. In enterprise environments, procurement, security review, and change management processes can add days or weeks.

## Installation Steps

| # | Step | Time | Who |
|---|------|------|-----|
| 1 | Clone repo, `npm install` | 10 min | Developer |
| 2 | Create `.mtaext` from template, fill parameters | 15 min | Developer |
| 3 | Create BTP Destination to SAP system (manual in BTP Cockpit) | 15-30 min | Developer / BTP Admin |
| 4 | Build MTA archive (`npx mbt build`) | 5 min | Developer |
| 5 | Deploy to CF (`cf deploy`) | 10 min | Developer |
| 6 | Assign role collections to users in BTP Cockpit | 10 min | BTP Admin / Developer |
| 7 | Verify: obtain JWT, run health check, test MCP, test chat | 30 min | Developer |
| | **Total installation (happy path)** | **~2 hours** | |

## Optional Steps

| Step | Time | When needed |
|------|------|-------------|
| Connect Claude CLI (`ANTHROPIC_BASE_URL`) | 15 min | Using Claude CLI with SAP |
| Connect Cline / Goose / AI tools | 15 min | Using 3rd-party AI assistants |
| Add more SAP destinations | 15 min each | Multiple SAP systems |
| Custom approuter domain | 10 min | Friendly URL needed |

## Troubleshooting Buffer

Installation at a customer environment often requires additional time to diagnose issues that do not appear in a known-good environment:

| Issue | Typical time to resolve | Root cause |
|-------|------------------------|------------|
| ICF services not activated on customer SAP | 1-2 hours | Basis team needs to activate `/sap/bc/adt` services in SICF |
| Cloud Connector access control missing paths | 1-2 hours | CC admin needs to whitelist ADT/HTTP paths for the virtual host |
| Destination reachable in BTP but MCP tools fail | 1-3 hours | Firewall rules, proxy settings, missing SAP client, wrong auth |
| AI Core model not available in customer region | 1-4 hours | Model needs deployment in customer's AI Core tenant/resource group |
| Role collections visible but 403 on API calls | 30 min - 1 hour | Trust configuration, IDP mapping, role assignment propagation delay |
| App starts but agent fails silently | 1-2 hours | Check `cf logs`, usually missing AI Core binding or wrong model name |
| Works in dev but not in production subaccount | 2-4 hours | Different entitlements, network policies, or CC registration per subaccount |

> Budget at least 1 additional day for first-time deployment at a new customer to account for environment-specific issues.

## Total Effort Estimate

| Scenario | Hands-on time | Wall-clock time |
|----------|--------------|-----------------|
| Everything ready (entitlements, AI Core, destinations, CC) | **2 hours** | 2 hours |
| Prerequisites partly ready, minor troubleshooting | **3-4 hours** | 1 day |
| New subaccount, AI Core setup needed | **4-6 hours** | 2-3 days (waiting for admin) |
| Full from-scratch at new customer (subaccount + AI Core + CC + Basis) | **1-2 days** | 1-2 weeks |
