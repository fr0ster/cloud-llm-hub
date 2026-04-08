# Cloud LLM Hub — Installation Summary

For effort estimation. Full details: [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md).

## Prerequisites

| Requirement | Who | Lead time |
|-------------|-----|-----------|
| BTP Subaccount (CF enabled) + entitlements | Global Account Admin | 1-5 days |
| SAP AI Core instance + LLM models deployed | AI Core Admin | 1-2 hours |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min - 2 hours |
| Cloud Connector (on-prem only) | Basis Admin | 2-4 hours |
| SAP system user + ICF services `/sap/bc/adt` | Basis Admin | 1-4 hours |

> **All prerequisites must be validated before starting.** A missing prerequisite discovered mid-installation forces a pause (often waiting for another team), then restart from rebuild + redeploy. This can turn a 2-hour job into a multi-day effort.

## Installation (7 steps, ~2 hours hands-on)

1. Clone repo, `npm install`
2. Create `.mtaext` with model, destination, approuter params
3. Create BTP Destination to SAP system (manual, BTP Cockpit)
4. Build MTA (`npx mbt build`)
5. Deploy (`cf deploy`)
6. Assign role collections to users
7. Verify: health check, MCP tools, test chat

## Total Effort

| Scenario | Hands-on | Wall-clock |
|----------|----------|------------|
| All prerequisites ready | 2 hours | 2 hours |
| Minor gaps, troubleshooting | 3-4 hours | 1 day |
| New subaccount + AI Core setup | 4-6 hours | 2-3 days |
| From scratch at new customer | 1-2 days | 1-2 weeks |
