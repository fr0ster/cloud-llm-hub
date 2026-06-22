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
- No new *classification* logic, but `classifyProbe` gains an identity-aware
  hint (see below) — the existing status enum is unchanged.

## Design

### Server — new CAP function `ProbeActiveDestination`

`srv/mcp-proxy.cds`:
```cds
function ProbeActiveDestination() returns DestinationDiagnostic;
```
Reuses the existing `DestinationDiagnostic` type (name, proxyType, status,
httpCode, latencyMs, rawMessage, hint).

**Dedicated single-shot probe (P1 — correctness of client + exactly one
attempt).** A bare `makeAdtRequest('GET')` sends the `X-SAP-Client` header but
NOT the `sap-usercontext` cookie (that cookie is only seeded by
`enforceClientCookie()` inside the CSRF/`connect()` paths), and the
`X-SAP-Client` header **alone is ignored by ABAP**, which then routes to the
system DEFAULT client — so the probe would silently test the wrong mandant.
Conversely `connect()` pre-fetches a CSRF token with its retry loop, which is
both unnecessary for a GET and violates the "exactly one attempt" requirement.

Therefore add a new method `CloudSdkAbapConnection.probe(path)` that does a
**single** `executeHttpRequest` GET with everything seeded up front, and does
NOT call `connect()` and does NOT retry:
```
probe(path):
  this.enforceClientCookie()                 // seed sap-usercontext = sap-client=<client>
  executeHttpRequest({ destinationName }, {
    method: 'GET', url: path,
    headers: { ...getAuthHeaders(),           // caller Basic auth
               'X-SAP-Client': client,
               Cookie: getCookieHeader() } }) // includes sap-usercontext
  → returns { httpCode, rawMessage }          // body/error body trimmed to 500
  // one attempt only — no retry on any status (incl. 401/403: lockout safety)
```

`srv/mcp-proxy.ts` handler `ProbeActiveDestination`:
- Read `X-SAP-Destination`, `x-sap-login`, `x-sap-password`, `x-sap-client`
  from `req.headers` (same header names as the chat path).
- If no destination header → 400.
- **Guarantee caller identity (P1).** `request-connection` only overrides to
  basic auth `if (sapLogin && sapPassword)` — with a missing or half-supplied
  pair it silently falls back to the **destination's** auth, which would probe
  the wrong identity. So `ProbeActiveDestination` enforces:
  - exactly one of login/password present → **400** (partial credentials);
  - for destinations that require user credentials (onprem / NoAuthentication —
    same `requiresUserCredentials` test as `request-connection`) both are
    mandatory → **400** if absent.
  - both absent on a cloud/JWT destination is allowed (mirrors the chat path:
    resolved destination/JWT auth is the caller's identity there).
- Build the connection under the **caller's** identity exactly like
  `srv/lib/request-connection.ts` (resolve destination, apply basic-auth
  override from `x-sap-login`/`x-sap-password`, apply `x-sap-client` override).
  **Must pass `destinationName`** —
  `createConnection({ sapConfig, destinationName: resolved.destinationName })`.
  The factory selects `CloudSdkAbapConnection` (Cloud SDK + Cloud Connector,
  and the new `probe()`) ONLY when `destinationName` is set; omitting it yields
  the base direct connection, which has neither. Do NOT call `connect()`.
- `probe()` is `CloudSdkAbapConnection`-specific and not on the `IAbapConnection`
  interface, so type it explicitly — cast `conn as CloudSdkAbapConnection`
  before calling `conn.probe('/sap/bc/adt/discovery')` → `{ httpCode, rawMessage }`.
- `const { status, hint } = classifyProbe(httpCode, rawMessage, proxyType, 'caller')`
  (see identity-aware hints below).
- Return the `DestinationDiagnostic` for this destination + measured `latencyMs`.

### Identity-aware hints (P2) — `srv/lib/probe-classifier.ts`

`classifyProbe`'s auth hints currently assume the **destination's** stored
credentials ("credentials in the destination are stale" / "Check destination
User/Password or override via x-sap-login/x-sap-password"). For a caller-identity
probe that wording is wrong — it's the user's own login/password/client that was
rejected.

Add an optional 4th parameter `identity: 'destination' | 'caller'` (default
`'destination'`, so existing callers — `DiagnoseDestinations`, the handlers —
are unchanged). When `identity === 'caller'`, the `backend_auth_failed` branch
returns instead: *"Backend rejected your SAP login/password (or client number).
Re-check the credentials you entered and log in again."* All other branches
(TLS, timeout, SCC, 5xx, network) are identity-independent and unchanged.

### UI — `app/chat/webapp/index.html`

1. **Validate on login.** After `submitLoginGate()` has unlocked the chat
   (see "Never block the gate" below), it fires `void runActiveProbe()` to
   validate the chosen creds + client and reflect the outcome in `#sap-status`:
   - `status === 'ok'` → green `SAP: OK`.
   - otherwise → red `SAP: ERROR` + the short `status` / first line of `hint`.
   The cosmetic `Connected …` line stays, but is now backed by a real probe.
2. **DIAG button** (post-login) → call `ProbeActiveDestination()` again and show
   a single-destination detail view (status, httpCode, latencyMs, hint,
   rawMessage) — the same modal style as today, one row instead of a table.
   Stop calling `DiagnoseDestinations()` from this button.
3. The probe request carries `X-SAP-Destination` + `getSapCredHeaders()`
   (which now includes `X-SAP-Client`), exactly like the chat request.

**Probe call lifecycle (P2 — network/error path).** Both entry points (login,
DIAG) share one async helper, e.g. `runActiveProbe()`, that is fully defensive
and never throws to the caller. Each branch writes a **terminal** `#sap-status`
(no `finally` clearing step — that would wipe the result a branch just set):
- Before the fetch → `SAP: CHECKING…` (neutral/yellow).
- `try`: `fetch('/odata/v4/mcp-proxy/ProbeActiveDestination()', { headers,
  signal })` with an `AbortController` timeout (12 s) so the probe can never
  hang.
  - non-2xx (400 partial creds, 500, …) → `SAP: ERROR <http status>`.
  - 2xx → parse `DestinationDiagnostic`; `status==='ok'` → `SAP: OK`, else
    → `SAP: ERROR <status / first line of hint>`.
- `catch` (network failure / abort timeout / JSON parse) →
  `SAP: ERROR (probe unreachable)`. Never an unhandled rejection.

**Never block the gate (P1).** `submitLoginGate()` does its normal
`loginGateDone = true` → `hideLoginGate()` → `unlockInput()` → focus FIRST, and
only then fires `void runActiveProbe()` (fire-and-forget — not awaited). The
helper owns all its own errors, so a slow or failing probe can never delay or
block entry. The DIAG button calls the same helper directly.

### Status indicator (P1 — dedicated element)

`#status-text` is owned by `setStatus()` and is constantly overwritten with
agent lifecycle states (`CONNECTING`, `READY`, `<phase> Ns`, `ERROR`). It can
NOT hold the SAP probe result — the first chat message would wipe it.

Add a **separate** element to the toolbar `.system-bar`, e.g.
`<span id="sap-status">…</span>`, written only by the probe flow (login +
DIAG). `setStatus()` is left untouched, so agent state and SAP connectivity
state coexist. Reuse current colours (green `#00ff00` for `SAP: OK`, red
`#ff5555` for `SAP: ERROR <reason>`).

## Decisions

- **Auto-probe on login.** Confirmed: run the probe right after gate submit and
  show OK/ERROR in the toolbar.
- **ERROR does not block entry.** The user can still open the chat and press
  DIAG to inspect; we only surface the status.
- **Keep `DiagnoseDestinations()`** server-side; only the button switches.
- **No retry storms.** `probe()` makes exactly one `executeHttpRequest` GET and
  retries on NO status (401/403 lockout safety, and no point retrying TLS/5xx
  for a diagnostic). It deliberately bypasses `connect()`'s CSRF retry loop.

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

**Unit (mocked)** — the resolver and HTTP transport mock cleanly, exactly as
`test/unit/request-connection.test.ts` already does (mock
`resolveDestinationSapConfig` + `createConnection`/`probe`). Required cases:
- `classifyProbe` identity-aware hint: `(401, '', 'OnPremise', 'caller')`
  mentions the user's credentials/client, NOT the destination; default identity
  keeps the old wording (regression guard for existing callers).
- Probe handler uses the **caller's** Basic auth (from `x-sap-login`/`-password`),
  not the destination's resolved auth.
- Probe sends both the `X-SAP-Client` header AND the `sap-usercontext` cookie
  (assert `enforceClientCookie` ran / the cookie is present) for the caller's
  client number.
- **Exactly one attempt** — on a mocked 401/403 the transport mock is called
  once (no retry / lockout), and on 5xx as well (probe never retries).
- Missing `X-SAP-Destination` header → 400.
- Partial credentials (only login OR only password) → 400; cred-requiring
  destination with no creds → 400 (caller-identity guarantee).

**Manual (acme-prod staging)** — confirm end to end:
1. TST (healthy) + user creds + client → `SAP: OK`.
2. QAS → `SAP: ERROR` with the TLS/certificate hint.
3. DEV with the user's own valid creds → `SAP: OK` (proves caller creds are used,
   not the destination's stale creds that make `DiagnoseDestinations` show 401).
4. Wrong client / wrong password → `SAP: ERROR` (auth), single attempt.
5. After a chat message, `SAP: OK/ERROR` is still visible (separate element).

## Rollback

Server function is additive; UI button change is a single revert. No data or
migration impact.
