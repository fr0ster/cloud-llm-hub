# Active-destination probe under the caller's own SAP identity

**Date:** 2026-06-22
**Status:** draft
**Scope:** `srv/` (new CAP function + handler) and `app/chat/webapp/index.html` (status indicator + DIAG button behaviour).

## TL;DR

After login the chat session is fixed to ONE destination, yet the DIAG button
probes ALL destinations under each destination's OWN stored credentials. That
answers the wrong question — it never tells the user whether THEIR session
(this destination + their login/password + their client) actually works (e.g.
DEV shows `401` from stale destination creds while the user's own creds are
fine). Add a single-destination probe that runs under the caller's identity,
surface the result as an OK/ERROR status in the toolbar, and validate
credentials at login time.

## Problem

- `ProbeDestination` / `DiagnoseDestinations` use `executeHttpRequest({ destinationName })`,
  which authenticates with the **destination's** configured credentials and
  sap-client — not the caller's `x-sap-login` / `x-sap-password` / `x-sap-client`.
- The login gate's `Connected to … as …` line is cosmetic: `submitLoginGate()`
  stores the creds and prints the line without ever contacting SAP. The first
  real validation is the first chat message.
- Net effect: low signal. The user cannot tell, post-login, whether their
  connection is healthy, and a bad credential/client is only discovered on the
  first query.

## Goal

Tell the user whether **this destination, with my credentials and my client**,
is reachable — clearly (OK/ERROR + reason), at login and on demand.

## Non-goals

- No change to `DiagnoseDestinations()` (all-destinations) server function — it
  stays for any other caller. Only the post-login DIAG button stops using it.
- No hard login gate: an ERROR probe does NOT block entry (see Decisions).
- No new classification logic — reuse `classifyProbe` (already has the TLS
  branch).

## Design

### Server — new CAP function `ProbeActiveDestination`

`srv/mcp-proxy.cds`:
```cds
function ProbeActiveDestination() returns DestinationDiagnostic;
```
Reuses the existing `DestinationDiagnostic` type (name, proxyType, status,
httpCode, latencyMs, rawMessage, hint).

`srv/mcp-proxy.ts` handler:
- Read `X-SAP-Destination`, `x-sap-login`, `x-sap-password`, `x-sap-client`
  from `req.headers` (same header names as the chat path).
- If no destination header → 400.
- Build a connection under the **caller's** identity. Reuse the same resolution
  + override path as `srv/lib/request-connection.ts` (resolve destination, then
  apply basic-auth override from `x-sap-login`/`x-sap-password` and the
  `x-sap-client` override), rather than `executeHttpRequest({ destinationName })`
  which would use destination creds.
- Probe `GET /sap/bc/adt/discovery` (same endpoint `DiagnoseDestinations` uses),
  capture `httpCode` and `rawMessage` (response body / error body, trimmed to
  500 chars) with the same extraction `DiagnoseDestinations` uses.
- `const { status, hint } = classifyProbe(httpCode, rawMessage, proxyType)`.
- Return the `DestinationDiagnostic` for this one destination + measured
  `latencyMs`.

Reuse, don't duplicate: factor the probe-and-classify step shared with
`DiagnoseDestinations` into a small helper if it reads cleanly; otherwise keep
the handler self-contained and call the shared `classifyProbe`.

### UI — `app/chat/webapp/index.html`

1. **Validate on login.** At the end of `submitLoginGate()` (after creds are
   stored), call `ProbeActiveDestination()` with the chosen creds + client and
   reflect the outcome in the toolbar status:
   - `status === 'ok'` → green `OK` indicator.
   - otherwise → red `ERROR` + the short `status` / first line of `hint`.
   The cosmetic `Connected …` line stays, but is now backed by a real probe.
2. **DIAG button** (post-login) → call `ProbeActiveDestination()` again and show
   a single-destination detail view (status, httpCode, latencyMs, hint,
   rawMessage) — the same modal style as today, one row instead of a table.
   Stop calling `DiagnoseDestinations()` from this button.
3. The probe request carries `X-SAP-Destination` + `getSapCredHeaders()`
   (which now includes `X-SAP-Client`), exactly like the chat request.

### Status indicator

Render OK/ERROR in the existing toolbar status area (`#status-text` / the
`.system-bar`). Reuse current colours (green `#00ff00`, red `#ff5555`). No new
layout — a short coloured token plus reason text.

## Decisions

- **Auto-probe on login.** Confirmed: run the probe right after gate submit and
  show OK/ERROR in the toolbar.
- **ERROR does not block entry.** The user can still open the chat and press
  DIAG to inspect; we only surface the status.
- **Keep `DiagnoseDestinations()`** server-side; only the button switches.
- **No retry storms.** The probe is a single GET; it must NOT retry on 401/403
  (same lockout rule as CSRF) — `/sap/bc/adt/discovery` is a GET so a single
  attempt is enough.

## Data flow

```
login gate submit / DIAG click
  → fetch GET /odata/v4/mcp-proxy/ProbeActiveDestination()
       headers: X-SAP-Destination, x-sap-login, x-sap-password, x-sap-client
  → handler builds caller-identity connection → GET /sap/bc/adt/discovery
  → classifyProbe(httpCode, rawMessage, proxyType)
  → { status, httpCode, latencyMs, hint, rawMessage }
  → UI: toolbar OK/ERROR  (+ DIAG modal with details)
```

## Error handling

- Missing destination header → 400 with a clear message.
- Connection build failure (bad creds, cert, timeout) → caught, classified, and
  returned as a normal `DestinationDiagnostic` (status ≠ ok) rather than an HTTP
  500 — the probe always returns a result describing what happened.
- Approuter header pass-through: confirm `x-sap-*` headers reach the
  `/odata/v4/mcp-proxy/*` route (the `/v1/*` path already receives them; verify
  the OData path does too on staging).

## Testing

- `classifyProbe` — already unit-tested (incl. TLS branch).
- Handler — not unit-tested (depends on `executeHttpRequest` / live SAP); verify
  manually on acme-prod staging:
  1. TST (healthy) + user creds + client → `OK`.
  2. QAS → `ERROR` with the TLS/certificate hint.
  3. DEV with the user's own valid creds → `OK` (proves it uses caller creds,
     not the destination's stale creds that make `DiagnoseDestinations` show 401).
  4. Wrong client / wrong password → `ERROR` (auth), single attempt (no lockout).

## Rollback

Server function is additive; UI button change is a single revert. No data or
migration impact.
