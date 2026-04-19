---
date: 2026-04-19
branch: feat/consumer-xsuaa-instances
subaccount: epam-sap-mcp-450kjhsb
space: dev
tags: [xsuaa, deploy, btp]
---

# XSUAA `grant-as-authority-to-apps` syntax rules

## What went wrong

Four consecutive `cf deploy` attempts failed with distinct xsuaa descriptor validation errors while introducing consumer xsuaa instances (`cloud-llm-hub-analyst-consumer`, `cloud-llm-hub-developer-consumer`) that inherit scopes from the main xsuaa.

## Why — rules xsuaa enforces

1. In the **provider** `xs-security.json`, inside a scope entry, `grant-as-authority-to-apps` accepts a **plain xsappname string** only:
   - ❌ `"$XSAPPNAME(application,cloud-llm-hub-analyst-consumer-${space-guid})"` — no `$XSAPPNAME(...)` wrapper allowed
   - ❌ `"cloud-llm-hub-analyst-consumer-${space-guid}"` — `$` is mbt parameter syntax, not allowed inside descriptor JSON
   - ❌ `"cloud-llm-hub-analyst-consumer-{space-guid}"` — braces `{ }` are invalid characters; xsuaa does NOT resolve `{space-guid}` in this field
   - ✅ `"cloud-llm-hub-analyst-consumer-8c9611f6-8016-455c-b91a-fba631e443c1!t654728"` — fully resolved xsappname including the auto-assigned tenant suffix `!tNNN`

2. In the **consumer** `xs-security.json`, `authorities` follows the format `<xsappname>.<scope>` with the same rules — no wrapper, no `{space-guid}` placeholder, must include `!tNNN`.

3. Placeholder `{space-guid}` (no `$`) is resolved by xsuaa **only inside the `xsappname` field**. It is NOT resolved inside `authorities` or `grant-as-authority-to-apps` because `{` and `}` are outside the allowed character set there.

4. xsuaa stores every xsappname with an auto-assigned subaccount-level tenant suffix `!tNNN` (e.g. `!t654728` for epam-sap-mcp-450kjhsb). Cross-reference fields MUST include it; without it the grant silently fails and the consumer token only carries the default `uaa.resource` scope.

## Fix

- Provider `xs-security.json`: `"grant-as-authority-to-apps": ["<full-resolved-consumer-xsappname-with-!t654728>"]`
- Consumer descriptors: `"authorities": ["<full-resolved-provider-xsappname-with-!t654728>.<Scope>"]`

Commits: `13e50e6`, `c631858`, `6a9232f` on `feat/consumer-xsuaa-instances`.

## Prevention rule

- When wiring cross-app xsuaa scope grants, use fully resolved xsappnames including `!tNNN` on both sides. Obtain the tenant suffix from a service key's `xsappname` field.
- Before declaring the wiring functional, ALWAYS fetch a client_credentials token from the consumer xsuaa, decode the JWT payload, and confirm `scope[]` contains the expected `<provider-xsappname>!tNNN.<scope>` entry. If it shows only `uaa.resource`, the grant silently failed.
