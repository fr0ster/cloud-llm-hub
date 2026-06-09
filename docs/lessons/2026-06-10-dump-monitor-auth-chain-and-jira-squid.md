---
date: 2026-06-10
branch: main
subaccount: ai-applications-6efrmk2a
space: dev
tags: [deploy, credentials, mta, cf]
---

# abap-dump-monitor: the cloud-llm-hub → ABAP → Jira auth chain

Getting the `abap-dump-monitor` example working end-to-end on ai-applications
meant clearing **four** independent auth/routing traps, each of which surfaced
only after the previous one was fixed. Documented so the next person spends
minutes, not an evening.

## TL;DR

discover → analyze → push-to-Jira now works. The four fixes:

1. **ABAP creds:** send `x-sap-login`/`x-sap-password` (tech user) per request.
2. **Stale hub URL:** the `CLOUD_LLM_HUB` destination kept a dead srv route.
3. **Jira search 406:** widen `Accept`, drop Content-Type on GET.
4. **Jira create XSRF:** Bearer PAT + a **non-browser** User-Agent.

## 1. cloud-llm-hub is fail-closed for on-premise destinations

The monitor only sent `Authorization` (hub OAuth) + `X-SAP-Destination`. For an
**OnPremise** (or NoAuthentication) destination, `srv/mcp-manager.ts` ignores the
BTP destination's own auth and **requires** `x-sap-login`/`x-sap-password`
headers — else `401 SAP_CREDENTIALS_REQUIRED`. S4HANA_E19 is on-prem, so the
headless monitor must send a technical user. Fix: `srv/sap-auth.ts` reads
`SAP_LOGIN`/`SAP_PASSWORD` and adds the headers; wired through `mta.yaml`.

Note on the clientid: dumps need `MCP_Analyst` (system tier); the analyst
consumer key is sufficient. `MCP_Developer` is only needed for the Frame Source
(GetClass / "high" tier) preview.

## 2. `existing_destinations_policy: ignore` hides a stale destination

The `CLOUD_LLM_HUB` destination is created via `mta.yaml` init_data with
`existing_destinations_policy: ignore` — so redeploys **never** update it. It had
been created at the monitor's first deploy with the old default srv route
(`epam-systems--…-sn-…`), which died when the main app moved to a named srv
route. Symptom: `discoverer … 404 … route does not exist`. The `.mtaext`
value is irrelevant here — fix the destination directly (cockpit or the
destination-service REST API: `PUT /destination-configuration/v1/instanceDestinations`).

## 3. EPAM Jira sits behind a Squid that 406s "unusual" requests

`POST /rest/api/2/search` → `406 Not Acceptable` (text/html) from the proxy.
It is **not** method-related (GET 406s too) — it is `Accept` negotiation. Fix:
`Accept: application/json, */*`, and only send `Content-Type` when there is a
JSON body (a Content-Type on a body-less GET also trips it).

## 4. A browser User-Agent makes Jira enforce XSRF on writes

After search worked, `POST /rest/api/2/issue` → `403 "XSRF check failed"` — even
with Bearer auth and `X-Atlassian-Token: no-check` (the proxy strips the header).
Root cause: the **browser `Mozilla/…` User-Agent** added for the Squid made
Jira's XSRF filter treat each POST as a browser form submission. Fixes, together:

- Auth as **Bearer PAT** (`Authorization: Bearer <PAT>`), not Basic. Watch out:
  a BasicAuthentication destination makes Cloud SDK populate `authTokens[0]` with
  a *Basic* token, so an authTokens-first check silently keeps using Basic — read
  the Password field directly for the Bearer path.
- Use a **non-browser** User-Agent (`abap-dump-monitor/1.0`). The Squid only
  wants *some* UA; a non-browser one keeps POSTs XSRF-exempt.

## Prevention rules

- Headless service → on-prem ABAP via cloud-llm-hub: it **must** send
  `x-sap-login`/`x-sap-password`; destination BasicAuth is ignored for OnPremise.
- After changing srv routes, audit **every** consumer destination, not just the
  approuter — `existing_destinations_policy: ignore` ones won't self-heal.
- Against a proxied Jira: widen `Accept`, send a **non-browser** UA, auth PATs as
  Bearer, and verify with a real write (create), not just a read (search).
