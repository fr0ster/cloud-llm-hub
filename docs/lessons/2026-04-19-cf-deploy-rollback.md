---
date: 2026-04-19
branch: feat/consumer-xsuaa-instances
subaccount: epam-sap-mcp-450kjhsb
space: dev
tags: [cf, mta, deploy]
---

# `cf deploy --abort-on-error --delete-services` leaves failed-state services

## What went wrong

First `npm run deploy` attempt failed when xsuaa rejected our consumer descriptors (pre-fix syntax). Rollout aborted; `cloud-llm-hub-analyst-consumer` and `cloud-llm-hub-developer-consumer` remained in `create failed` state. The next deploy attempt after fixing the descriptor got confused — CF Deploy Service tried to UPDATE the failed-state instances rather than create fresh ones, producing different and harder-to-read errors.

## Why

`npm run deploy` uses `cf deploy ... --abort-on-error --delete-services -f`. The `--delete-services` flag only removes services that are **not** declared in the new MTA descriptor. Failed-state instances ARE declared (they just failed to materialize), so they are kept. `--abort-on-error` halts the rollout but does not clean up partial state.

## Fix

```bash
cf services | grep -E "failed"
cf delete-service <failed-service> -f
# for each
```

Then rebuild and redeploy.

## Prevention rule

- After ANY `cf deploy` failure, run `cf services | grep -E "failed"` and purge stale entries before the next attempt.
- Main xsuaa in `update failed` state is less urgent — the running service keeps its prior descriptor, so runtime continues on the old config until a successful deploy.
