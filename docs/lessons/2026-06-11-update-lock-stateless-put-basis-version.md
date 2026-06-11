---
date: 2026-06-11
branch: main
subaccount: nvcr (cloud-llm-hub-4wmgo71p)
space: cloud-llm-hub
tags: [mcp-abap-adt, cross-subaccount, deploy]
---

# UpdateClass "not locked (invalid lock handle)" — stateless PUT after lock, version-dependent

ABAP class **update** failed on some SAP systems with
`Resource CLASS <NAME> is not locked (invalid lock handle: <handle>)`
while **create** and **read** worked, and the **same code** updated fine on
other systems. Turned out to be a stateful-session bug in `@mcp-abap-adt`,
masked by newer ABAP releases.

## TL;DR
- The UPDATE PUT was sent **stateless** (no `x-sap-adt-sessiontype: stateful`).
- **Old BASIS** (DS4 / 7.55) rejects the lock for a stateless request → 423.
- **New BASIS** (D24 / 7.58, E19 / 8.16) tolerates it → looked fine.
- Fix is upstream (`fr0ster/mcp-abap-adt#106`); consumed here via a dep bump.

## Version correlation (the key clue)
| System | SAP_BASIS | Update |
|--------|-----------|:---:|
| DS4 | **755** | ❌ 423 |
| D24 | 758 | ✅ |
| E19 | 816 | ✅ |

Perfect correlation with BASIS release — not load balancing, not "weird system".

## Root cause (proven, not guessed)
Temporary request-level instrumentation in `CloudSdkAbapConnection` logged the
cookies + sessiontype per ADT call on the failing DS4 flow:

- LOCK → POST, `sessionType=stateful`, `x-sap-adt-sessiontype: stateful` → 200, handle.
- UPDATE → **PUT**, `sessionType=stateless`, **no** stateful header → **423**.
- UNLOCK → POST, stateful → 200.
- The **session cookie `SAP_SESSIONID_<SID>_<client>` was identical** on every
  request (same `sap-adt-connection-id`). The session is **not** lost.

So the only difference was the **missing stateful header on the PUT**.
`@mcp-abap-adt/adt-clients` `AdtClass.update()` toggled `setSessionType('stateless')`
between lock and update, violating `updateClass()`'s own "requires stateful"
contract. `AdtClassLegacy` already kept stateful for the whole chain.

A "sticky stateful" guard in our connection (ignore stateless downgrade while a
lock is active) made the DS4 update succeed — confirming the cause before any
upstream change.

## Fix
Upstream in `@mcp-abap-adt` (#106): keep the connection stateful through the
whole `lock → check → update → unlock` chain; stateless only after unlock.
Consumed here by bumping **`@mcp-abap-adt/core` 6.11.3 → 7.0.1** and
**`@mcp-abap-adt/adt-clients` 5.4.3 → 5.4.4**. Verified end-to-end: DS4 (755)
now updates+activates with the bumped deps and **no** local workaround; D24 (758)
unaffected. The core 7.x major bump left our consumer surface unchanged (tsc clean).

## Prevention rules
- When an ABAP write works on some systems but not others, **check the BASIS
  release first** and capture the **actual session headers** (cookie +
  `x-sap-adt-sessiontype`) per request — don't theorize about load balancers.
- Lock→write→unlock must stay in **one stateful session**; never send the write
  PUT stateless. Older BASIS enforces this; newer tolerates it.
- The fix belongs in `@mcp-abap-adt` (adt-clients), not in cloud-llm-hub — bump
  the dependency, don't carry a workaround.
