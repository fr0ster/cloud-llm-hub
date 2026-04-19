---
date: 2026-04-19
branch: feat/consumer-xsuaa-instances
subaccount: epam-sap-mcp-450kjhsb (consumer), ai-applications-6efrmk2a (source)
space: dev
tags: [xsuaa, aicore, cross-subaccount, credentials]
---

# XSUAA binding-secret is tied to a specific service key

## What went wrong

Pulled fresh AICORE credentials from the `ai-applications` subaccount (where the AI Core service instance lives) via a temporary `fresh-creds` service key, applied the extracted `clientsecret` to `cloud-llm-hub-srv` on epam-sap-mcp with `cf set-env AICORE_CLIENT_SECRET`, then deleted the `fresh-creds` key as cleanup. Restart produced `Token request failed: 401` → `Failed to fetch AI Core models` → destination init failed → `/v1/models` returned only the default active model.

## Why

xsuaa service instances with `credential-types: ["binding-secret"]` generate a unique `clientsecret` per `cf create-service-key` call. The secret is valid **only while that specific service key exists**. Deleting the key immediately invalidates the secret on the xsuaa side, regardless of where the value was propagated. The `fresh-creds` key's deletion killed the secret that had been freshly `set-env`-ed into epam-sap-mcp.

## Fix

Created a new persistent service key (`verify-key` — name needs a meaningful rename), extracted its `clientsecret`, applied via `cf set-env`, restarted `cloud-llm-hub-srv`. Confirmed: `/v1/models` returns 15 models, destination init succeeds. Left the key in place on ai-applications.

## Prevention rule

- Name service keys that are load-bearing with meaningful names (`epam-sap-mcp-consumption`, not `probe` / `test` / `fresh-creds`). Document them.
- When rotating: create NEW key → apply new secret everywhere → verify → THEN delete old key.
- If uncertain whether a key's secret was propagated anywhere, keep the key.
- Any AICORE / xsuaa secret extracted for cross-subaccount propagation makes its source key load-bearing — treat as a production dependency.
