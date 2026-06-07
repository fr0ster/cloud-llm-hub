---
date: 2026-06-07
branch: main
subaccount: ai-applications-6efrmk2a
space: dev
tags: [mta, cf, deploy]
---

# `${default-url}` points at a dead route once the srv module has an explicit route

The chat UI loaded but did nothing — every action silently failed. Root cause was a
one-line `mta.yaml` mismatch introduced when we gave `cloud-llm-hub-srv` a stable
named route (commit `a1faa99`).

## What went wrong

The approuter's `srv-api` destination resolved to
`https://epam-systems--inc---payg--partner-account--sn-000000000317bbaf5.cfapps.eu10-004.hana.ondemand.com`
— a host that does **not** exist in `cf routes`. The real srv route is
`ai-applications-6efrmk2a-cloud-llm-hub-srv`.

Symptom split that hid the bug:

- `/chat/webapp/*` → served from the approuter `localDir` → **HTTP 200**, UI loads.
- `/v1/*`, `/mcp/*`, `/` → forwarded through the `srv-api` destination → **dead host**, every API call fails.

So `curl` on the index page returned 200 and looked healthy, while the app was fully broken.

## Why

The srv module declares an explicit route:

```yaml
parameters:
  routes:
    - route: ${APPROUTER_HOST}-srv.${CF_LANDSCAPE}
```

but the destination consumed by the approuter took its URL from `${default-url}`:

```yaml
provides:
  - name: srv-api
    properties:
      srv-url: ${default-url}        # ← BUG
```

`${default-url}` resolves to the **CF default generated route** (the
`epam-systems--…-sn-<guid>` host). Once a module has an explicit `routes:` block,
that default route is **not created** — so the destination pointed at a host that
was never bound. Before `a1faa99` the srv used the default route, `${default-url}`
matched, and it worked; adding the named route broke the link without touching the
destination.

## Fix

Bind the destination to the same explicit named route the module declares:

```yaml
provides:
  - name: srv-api
    properties:
      srv-url: https://${APPROUTER_HOST}-srv.${CF_LANDSCAPE}
```

`${APPROUTER_HOST}` / `${CF_LANDSCAPE}` are the same vars used in the route line, so
the URL always tracks the real srv host (and per-subaccount `.mtaext` overrides,
including the `-staging` generated app, follow automatically).

## Prevention rule

When a module gets an explicit `routes:`, **stop using `${default-url}`** for any
`provides` URL that consumers depend on. Point it at the explicit route template
instead. After a deploy that changes routing, verify a real API call
(`/v1/...`), not just the static index page — a 200 on `/chat/webapp/index.html`
proves nothing about the srv destination.
