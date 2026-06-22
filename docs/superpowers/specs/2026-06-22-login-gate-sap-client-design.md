# Login gate: per-session SAP client (mandant) selection

**Date:** 2026-06-22
**Status:** draft
**Scope:** `app/chat/webapp/index.html` only (client-side). No server change.

## TL;DR

Add an optional **SAP Client** field to the chat login gate so the user can
connect to a specific mandant (e.g. `600`) instead of always using the
destination's configured default client. The backend already accepts the
`X-SAP-Client` header per request — the chat UI is the only gap.

## Problem

- The server fully supports per-request client override via the `X-SAP-Client`
  header. It sets `sapConfig.client`, and `CloudSdkAbapConnection` forces the
  client into both the `X-SAP-Client` header **and** the
  `sap-usercontext=sap-client=<n>` cookie (the header alone is ignored by ABAP,
  which would otherwise route to the system default client). See
  `srv/lib/request-connection.ts:79,113`, `srv/mcp-manager.ts:127`,
  `srv/connections/CloudSdkAbapConnection.ts:97-106`.
- The chat UI login gate collects only destination + login + password. It never
  sends `X-SAP-Client`, so from the chat you always get the destination's
  configured client with no way to pick a number.

## Goal

Let the user optionally type a specific client number in the login gate. Blank =
unchanged current behaviour (use the destination's default client).

## Non-goals

- No server change — backend already handles `X-SAP-Client`.
- No dropdown of "available clients" (we don't enumerate clients per system).
- No `X-SAP-Client` block/validation on the server side.

## Design

All changes in `app/chat/webapp/index.html`.

### 1. Gate markup

Add a field after the SAP Password block (~line 284):

```html
<div style="margin-bottom:12px">
  <label ...>SAP Client (optional):</label>
  <input id="sap-client" inputmode="numeric" maxlength="3"
         placeholder="e.g. 100 — blank = destination default" ...>
</div>
```

Reuse the existing input styling (monospace, dark theme) for visual
consistency with the other gate fields.

### 2. State

New module-scoped variable alongside the existing credential vars (~line 330):

```js
let sapCredsClient = '';
```

### 3. `submitLoginGate()` (~line 384)

- Read `sap-client`, `.trim()`.
- **Validation:** if non-empty, must match `/^\d{3}$/`; otherwise
  `fail('SAP client must be 3 digits, e.g. 100.')` and stop (same pattern as the
  existing destination/login/password guards).
- Store into `sapCredsClient`.
- Confirmation line includes the client when set:
  - with client: `Connected to SB1 (client 600) as DEVELOPER.`
  - blank: `Connected to SB1 as DEVELOPER.` (unchanged).

### 4. `getSapCredHeaders()` (~line 426)

When `sapCredsClient` is set, add `'X-SAP-Client': sapCredsClient` to the
returned headers. (Client is numeric, so no ISO-8859-1 header concern.)

### 5. Reset on logout / re-gate

`sapCredsClient` is cleared wherever `sapCredsLogin` / `sapCredsPassword` are
reset (login gate is per-session, like the destination). When the gate reopens
mid-session on `SAP_CREDENTIALS_REQUIRED`, the field starts empty.

## Decisions

- **Optional**, blank = destination default → zero behaviour change for users
  who don't fill it.
- **3-digit numeric validation** — SAP client is always `000`–`999`.
- **Show the chosen client** in the `Connected…` line for confirmation.

## Testing

The chat UI is a static HTML/JS file with no unit-test harness. Verify
manually:

1. Blank client → request works exactly as before (destination default client).
2. Client `600` (a non-default client the user has access to) → request runs
   under client 600; confirmation line shows `(client 600)`.
3. Invalid input (`60`, `abc`, `6000`) → inline error, gate does not proceed.
4. Logout → re-open gate → client field empty.

## Rollback

Single-file, UI-only change — revert the commit. No data/migration impact.
