---
date: 2026-07-26
branch: fix/adt-session-affinity
subaccount: ai-applications
space: dev
tags: [adt, stateful-session, cloud-connector, orphaned-lock, sap-sessionid, keep-alive, connectivity]
---

# Orphaned ADT edit-locks on domain writes — client must generate SAP_SESSIONID and pin one socket

## What went wrong

Creating an ABAP **domain** via the WebUI/chat (and MCP) intermittently failed with
**HTTP 400 "Session not found"** and left the object **created-but-locked** — an orphaned ADT
edit-lock (object INACTIVE, "User X is currently editing"). **Classes were unaffected.** It only
happened in cloud-llm-hub, not the standalone `@mcp-abap-adt` core (a separate local process).

## Why

An ADT mutating flow runs a **stateful chain** `validate → create → LOCK → update → unlock →
activate`, and every request must stay on **one connection to the one app-server instance behind
the connectivity proxy**. Two independent gaps broke that on the BTP connectivity path:

1. **SAP issues no `SAP_SESSIONID_<SID>_<CLIENT>` cookie there** (only `sap-contextid`). That
   routing/session cookie is the CLIENT's responsibility on this path — with none, the stateful
   session was never bound, so a follow-up request could land unbound.
2. SAP Cloud SDK's `executeHttpRequest` builds a **fresh HTTP agent per call over a shared socket
   pool**. On a **cold** chain (right after a restart / before the pool warms) LOCK went out on
   one socket/tunnel and the follow-up GET on another → the stateful session, bound to the first
   tunnel, was **"Session not found"** → the lock orphaned.

**Why domains and not classes:** adt-clients `updateDomain` is a **read-modify-write** — it does a
stateful **GET immediately after LOCK** (read current XML → patch → PUT). That post-LOCK GET is the
request that scattered. Class source update is a **direct PUT** (no read-GET), so it never hit the
gap. (During a create the domain read-GET is even redundant — `create` already returned the XML —
but that's upstream `@mcp-abap-adt` behaviour.)

**Diagnostic dead-ends (recorded so nobody repeats them):** it is NOT a timeout (the failing GET
returns a fast HTTP 400, ~57 ms, not `ECONNABORTED`); NOT `closeSession`/safe-stop (it fires at
end-of-request cleanup, ~18 s later); NOT app-server load-balancing scatter across many instances
(there is exactly **one** instance per proxy); NOT the honesty-controller. Cookie-preserve on CSRF
refresh helped only warm. A CONNECT tunnel (`HttpsProxyAgent`) is rejected by the SAP HTTP proxy
("HTTPS proxying is not supported. Use HTTP instead"). The breakthrough came from **per-request
trace logging** (session type, gap, Set-Cookie names, the SAP_SESSIONID value per request, fail
status) — not theorising.

## Fix

All in `srv/connections/CloudSdkAbapConnection.ts` (PR #190):

1. **Generate a stable, unique `SAP_SESSIONID_<SID>_<CLIENT>`** (base64url — cookie-safe; suffix
   derived from the server's `sap-XSRF_<SID>_<CLIENT>`) and send it on every request. Generated
   **once and never changed for the connection's lifetime** (one connection = one session = one
   value); a real server-issued value always wins.
2. **Pin the connector to ONE keep-alive socket** — a per-connection `maxSockets: 1` keep-alive
   **`httpAgent`**, passed to every `executeHttpRequest`. One destination = one session = one
   connector = one connection → the whole chain rides one socket → one tunnel → the one instance,
   so the session holds **even cold**. (Requests on a connector are sequential, so one socket never
   bottlenecks.) Destroyed in `reset()`. **Override only `httpAgent`** — on-prem ADT is plain HTTP;
   overriding `httpsAgent` would drop the SDK's destination TLS (TrustAll / trust store / mTLS) for
   HTTPS destinations, so that one is left to the SDK.
3. **Remove the 400-"Session not found" retry** — retrying a stateful write that may already have
   executed just **piles up locked objects**. Never retry a stateful ADT request by default.
4. Keep the cookie-preserve on CSRF refresh (drop only `/csrf|xsrf/`, keep `sap-contextid` +
   `SAP_SESSIONID`); add a lean `SESSION_LOST` WARN that fires only on the anomaly, logging the
   destination + session context to pinpoint any residual case in production.

Validated on E19: cold (immediately after restart), rapid, and spaced domain creates all report
**0 "Session not found"**, objects created + activated.

## Prevention rule

- On the BTP connectivity path the **client owns the ADT HTTP session identity** — generate a
  stable `SAP_SESSIONID_<SID>_<CLIENT>` and hold **one keep-alive socket per connector** for the
  whole stateful chain. One destination = one session = one connector = one connection.
- **Never blind-retry a stateful ADT write** (create/lock/update) on a session error — it orphans
  or duplicates locked objects. Prevent the scatter instead.
- When a session "disappears" mid-chain, add **per-request logging** (session type, cookies sent,
  Set-Cookie received, timing) before theorising — the symptom (scatter / timeout / cleanup / cookie
  loss) is only distinguishable from the wire.
