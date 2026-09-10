# Plan — ABAP Cloud session lifecycle (2026-08-31)

## TL;DR

Cloud (`ProxyType: Internet`) destinations are a supported scenario, but `CloudSdkAbapConnection`
implements only the **on-premise** session mechanism. On an ABAP Cloud system it never creates a
security session, so there is nothing for an edit-lock to bind to and nothing to release. Reads
work; mutating chains are the exposure. Fixing it means adopting `@mcp-abap-adt/connection` v5's
session strategies — a coordinated upgrade, not a drop-in.

## The gap, as measured

| | On-premise (works) | ABAP Cloud (gap) |
|---|---|---|
| Session created by | the logon = the establishing call | `POST /sap/bc/adt/core/http/sessions`, `x-sap-security-session: create` — **we never send this** |
| Session released by | `GET /sap/public/bc/icf/logoff` — implemented (#206) | `DELETE` on the published address — **not implemented** |
| Result today | session opened and returned | **no session exists at all** |

Per upstream's measurement, an ABAP Cloud system that never receives the create request answers
with `sap-usercontext` and `sap-XSRF_*` and no session. Our `closeSession()` sends the ICF logoff
only when a server-issued `SAP_SESSIONID` is present, so on such a system it correctly sends
nothing — there is nothing to send it about.

**Consequence:** an ADT lock has no session to be bound to. Read-only flows are unaffected.

## Why this is not hypothetical

- `srv/lib/request-connection.ts` has a dedicated cloud path (destination JWT /
  OAuth2SAMLBearerAssertion principal propagation)
- unit tests cover a cloud destination without caller credentials
  (`test/unit/destination-requires-credentials.test.ts`, `test/unit/request-connection.test.ts`)
- deployment docs offer SAP BTP ABAP Environment over an Internet destination

## Goal

Mutating ADT flows behave on ABAP Cloud the way they do on-premise: a session exists for the lock
chain, and it is returned when the work finishes.

## Non-goals

- Connection pooling. Related (same lifecycle surface) but a separate decision — see below.
- Changing anything about the on-premise path, which is verified working.
- Auto-detecting the system type. Upstream's rule stands: the cloud endpoint answers on-premise
  too, so the type must be **declared**, never inferred from the server, the credential, or the
  host name. Note `systemType` in `mcp-manager.ts` is derived from `destination.proxyType`, but it
  selects which tools to expose — it must not be reused as a session-mechanism switch without a
  deliberate decision that `proxyType` is an acceptable declaration.

## The version constraint — and what upstream now looks like

```
installed here:  @mcp-abap-adt/connection  1.10.2
published:       @mcp-abap-adt/connection  8.0.1
                 @mcp-abap-adt/core        8.13.0  (still depends on connection ^1.10.0)
```

**The v5 design this plan was written against is gone.** In 5.0.0 a session was
opened and closed by a `SessionStrategy` the connection selected and drove, talking
through a narrow `ISessionTransport`. By 8.0.1 that is folded into the wire itself:
`IAdtTransport.open()/close()`, required rather than optional. Its own doc comment
says so —

> This used to be a `SessionStrategy` the connection selected and drove: a second
> wire abstraction beside this one, in the class every wire shares, describing a
> mechanism only some of them have.

So "adopt the v5 strategies" is no longer a thing that can be adopted.

## Options, re-scored against 8.0.1

### A. Implement the two requests directly in `CloudSdkAbapConnection`

A create on connect and a `DELETE` on close, behind a declared flag. Was the
fallback; is now the only route that does not wait on `core`.

- No dependency movement — `core@8.13.0` still pins `connection ^1.10.0`
- Duplicates upstream logic, but upstream has now rewritten that logic once
  already, so tracking it was never free either

### B. Move to `connection` 8.x and implement `IAdtTransport`

The destination we would want, and closer to our shape than v5 was: our transport
IS Cloud SDK `executeHttpRequest`, and 8.x asks a wire to own open/close rather
than layering a second abstraction over it.

- Blocked until `core` accepts `connection` 8.x — check on each `core` release
- A seven-major jump, so read the changelog rather than assuming continuity

**Leaning:** A when ABAP Cloud writes are actually needed; B once `core` moves.
Do not vendor v5 — that API no longer exists upstream.

## Steps

1. Confirm the gap on a real ABAP Cloud system — see Verification. **Do not build before this.**
2. Decide how the system type is declared, and where that declaration lives (destination config, an
   explicit env mapping, or an accepted `proxyType` reading).
3. Implement the chosen option behind that declaration, leaving the on-premise path untouched.
4. Unit tests mirroring `test/unit/cloudsdk-session-release.test.ts`: a create on connect, a
   `DELETE` on close, and no on-premise regression (ICF logoff still fires for a server-issued
   cookie, and never for a generated one).
5. Live-verify a full mutating chain on the cloud system.
6. Update `docs/contributors/CONNECTION_ARCHITECTURE.md` — replace the "Known gap" block with what
   the code does.

## Verification

The honest blocker: **we have no ABAP Cloud system in the current landscape.** Every destination in
use (`S4HANA_DEV`, `S4HANA_QAS`) is on-premise via Cloud Connector. Step 1 needs either a BTP ABAP
Environment trial or a customer system.

Until then this plan stays a plan. Building the cloud path against no cloud system would repeat the
mistake that produced the gap in the first place: shipping session handling that was never observed
against the system it targets.

## Relationship to connection pooling

Pooling was analysed separately (one consumer, sessions keyed by system + login, normalise on
return, log off on eviction). It shares this surface, and both want the same thing from the
connector: an explicit, testable session lifecycle instead of "opened as a side effect, closed on
teardown". If the v5 upgrade happens for either reason, the other gets cheaper.

They remain independent decisions. Pooling is an optimisation; this is a correctness gap.

## Open questions

- Is ABAP Cloud actually in scope for **writes**, or only for reads? If reads only, this drops to
  documentation and the plan can be closed.
- ~~Does a newer `core` accept `connection` 5.x?~~ **Checked 2026-08-31: no.** `@mcp-abap-adt/core`
  latest is 8.13.0 — the version we already run — and it still depends on `@mcp-abap-adt/connection`
  `^1.10.0`. So option B is blocked upstream until `core` moves, which makes A the only route that
  does not require waiting on another package. Worth re-checking whenever `core` publishes.
