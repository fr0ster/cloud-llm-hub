# Cloud LLM Hub — Installation Summary

Quick reference for effort estimation. Full details in [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md).

## Prerequisites

| Requirement | Who provides | Lead time |
|-------------|-------------|-----------|
| BTP Subaccount with CF environment | BTP Global Account Admin | 1-2 days (if new) |
| Entitlements: AI Core (extended), XSUAA, Destination, Connectivity | BTP Global Account Admin | 1 day |
| SAP AI Core instance + LLM model deployed | AI Core Admin | 1-2 hours |
| BTP Destination to SAP system | Basis / BTP Admin | 30 min |
| Cloud Connector configured (on-prem only) | Basis Admin | 1-2 hours |
| SAP system user + ICF services activated | Basis Admin | 30 min |

> Lead times assume approvals are in place. Entitlement and subaccount requests may take longer depending on organization processes.

## Installation Steps

| # | Step | Time | Who |
|---|------|------|-----|
| 1 | Clone repo, `npm install` | 5 min | Developer |
| 2 | Create `.mtaext` from template, fill parameters | 10 min | Developer |
| 3 | Create BTP Destination to SAP system | 10 min | Developer / BTP Admin |
| 4 | `npx mbt build` | 2 min | Developer |
| 5 | `cf deploy` | 5 min | Developer |
| 6 | Assign role collections to users | 5 min | BTP Admin / Developer |
| 7 | Verify health + test chat | 5 min | Developer |
| | **Total installation** | **~45 min** | |

## Optional Steps

| Step | Time | When needed |
|------|------|-------------|
| Connect Claude CLI (`ANTHROPIC_BASE_URL`) | 5 min | Using Claude CLI with SAP |
| Connect Cline / Goose / AI tools | 5 min | Using 3rd-party AI assistants |
| Add more SAP destinations | 5 min each | Multiple SAP systems |
| Custom approuter domain | 5 min | Friendly URL needed |

## Total Effort Estimate

| Scenario | Time |
|----------|------|
| Everything ready (entitlements, AI Core, destinations) | **45 min** |
| New subaccount, entitlements needed | **1-2 days** (waiting for admin) + 45 min |
| First-time AI Core setup included | **2-3 hours** + 45 min |
| Full from-scratch (new subaccount + AI Core + Cloud Connector) | **1-2 days** + 3-4 hours hands-on |
