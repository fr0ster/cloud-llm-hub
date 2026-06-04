---
date: 2026-06-04
branch: main
subaccount: ai-applications-6efrmk2a, cloud-llm-hub-4wmgo71p (nvcr)
space: dev
tags: [mta, cf, credentials, cross-subaccount, deploy, aicore]
---

# Proxy routing, SAP mandant, and CSRF-retry lockout

A day-long debug of "proxy can't reach ABAP" that turned out to be **five independent
issues** stacked on the per-request-credentials model (PRs #125/#129). Each masked
the next. Documented so the next person spends minutes, not a day.

## 1. The proxy must target the BARE srv route, NOT the approuter

**Went wrong:** `mcp-abap-adt-proxy` requests returned `SAP_CREDENTIALS_REQUIRED`
even though the proxy `defaultHeaders` carried `x-sap-login`/`x-sap-password`.

**Why:** the SAP **approuter strips custom `x-sap-*` headers** when forwarding to
the srv backend. Via the approuter the srv never sees the SAP creds → fail-closed.
Hitting the srv route directly preserves them.

**Fix / rule:** proxy `targetUrl` = the **srv** app route
(`<subaccount>-cloud-llm-hub-srv...`), never the approuter (`<subaccount>-cloud-llm-hub...`).
The srv route is intentionally public for this. The approuter is for the browser
XSUAA flow only.

## 2. srv had no explicit route → generic, confusing, unstable host

**Went wrong:** the srv got the CF-default route
`epam-systems--inc---payg--partner-account--sn-<random-guid>` on every subaccount
— looked like a *different* account (cost hours of "why is ai-applications pointing
at epam?"), and the random guid changes across redeploys, breaking the proxy.

**Fix:** `mta.yaml` srv module → `parameters.routes: - route: ${APPROUTER_HOST}-srv.${CF_LANDSCAPE}`
so the srv host reflects the subaccount (`ai-applications-6efrmk2a-cloud-llm-hub-srv`).
Delete the orphaned org-name route after redeploy.

## 3. CSRF retry-on-401 LOCKED the ABAP user (every ~5 min)

**Went wrong:** an ABAP user (`okyslytsia`) kept getting locked minutes after every
unlock.

**Why:** `CloudSdkAbapConnection.fetchCsrfToken` retried **every** failure up to
`RETRY_COUNT` (4 attempts), including `401`. One bad-credential request = 4 failed
ABAP logons → lock after 1-2 requests; any client still sending wrong creds re-locked
it. The server itself never used a service user (verified), so the locker was always
a client-side wrong/stale credential, amplified ×4.

**Fix / rule:** never retry CSRF on `401/403` (auth failures are not transient) —
fail fast on the first attempt. Retry only network/5xx. Verify in logs: "after 1
attempts".

## 4. SAP mandant: the `X-SAP-Client` header is IGNORED by ABAP

**Went wrong:** destination had `sap-client=600` (E96), it was read correctly and
sent as `X-SAP-Client: 600`, yet ABAP routed to the default client (100) → 401.

**Why:** ABAP selects the client from the **`sap-usercontext` cookie**, not the
`X-SAP-Client` header (confirmed in upstream `@mcp-abap-adt/connection`).

**Fix:** `CloudSdkAbapConnection` seeds + re-enforces
`sap-usercontext=sap-client=<client>` on the CSRF fetch and every request. Client
comes from the destination's `sap-client` or the new per-request `x-sap-client` header.

## 5. Destination name typos = `DESTINATION_RESOLUTION_FAILED` (502)

**Went wrong:** nvcr returned 502 for all requests. Config said `DS24`; the real
destination was `D24`. `getDestination("DS24")` → not found → 502.

**Fix / rule:** the destination name in `LLM_AGENT_MCP_DESTINATION` / `x-sap-destination`
must match the BTP destination **exactly**. When a 502 `DESTINATION_RESOLUTION_FAILED`
appears, list the destination service's actual destinations before assuming a binding
problem. Deleted destinations linger in the gate dropdown until a srv restart (5-min
in-memory cache; `refreshDestinations` does not prune).

## Architecture takeaway

Destination = **network path only** (URL + ProxyType + Cloud Connector tunnel —
irreducible for onprem). Identity (login/password/**client**) = **per-request
headers**. Stored creds/`sap-client` on the destination caused issues #3 and #4;
target state is `Authentication=NoAuthentication` with everything per-request.
