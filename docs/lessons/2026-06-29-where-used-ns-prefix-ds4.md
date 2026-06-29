---
date: 2026-06-29
branch: main
subaccount: nvcr (DS4)
space: cloud-llm-hub
tags: [where-used, adt, xml-parsing, namespace-prefix, s4hana, getstructureslist, diagnosis]
---

# `GetStructuresList` lost all append structures on S/4 — a hard-coded XML namespace prefix silently dropped a 6 MB response

## What went wrong

`GetStructuresList(VBAK)` on **DS4** (an S/4 system) returned **0 append
structures**, even though VBAK has ~14 appends (visible in Eclipse). On E19
(ECC-style) the same call returned them fine. The destination, auth, and tunnel
were all healthy — the tool just reported no appends.

## Why (two compounding causes, one of them a red herring)

Append detection runs an ADT **where-used** search and keeps the `TABL/DS`
referencing structures whose source is `extend type <base> with …`.

1. **`/usageReferences/scope` 404s on S/4.** The where-used helper used the
   2-step Eclipse "scope" flow (`POST …/usageReferences/scope` → modify selected
   types → `POST …/usageReferences`). DS4 answers the `/scope` sub-resource with
   `404 "No suitable resource found"` for **every** object type. The original
   code let that abort the whole search → 0 appends, flagged
   `appends_unavailable`. **This was real but only half the story** — and it sent
   the first diagnosis down a dead end ("S/4 has no /scope").

2. **The real killer — a system-dependent XML namespace prefix.** After making
   the search fall back to an unscoped `/usageReferences` (which DS4 *does*
   support), the request returned **HTTP 200 with a 6 MB body / `numberOfResults=5970`** —
   and the parser still produced **zero** references. The result is namespaced
   under `http://www.sap.com/adt/ris/usageReferences`, but the *prefix* SAP binds
   to it is **system-dependent**: E19 emits `usagereferences:` (lower-case),
   DS4 emits `usageReferences:` (camel-case). The parser hard-coded
   `parsed['usagereferences:usageReferenceResult']`, so on DS4 the lookup was
   `undefined` → 0 — **silently**, on a perfectly good 200 response.

The breakthrough came only after capturing the **raw** ADT round-trip (a
temporary `POST /v1/debug/adt-raw` that fires an arbitrary ADT request through
the per-request connection and returns the unparsed status + body). It showed
`status 200, length 6166846, <usageReferences:usageReferenceResult numberOfResults="5970" …>`.
The user's framing was exactly right: **"0 may be the result of our own
transformation, not SAP."**

## Fix

In `@mcp-abap-adt/adt-clients` (`whereUsed.ts`), two PRs:

- **#58 (7.0.1)** — don't depend on `/usageReferences/scope`: post the search
  directly (Eclipse-style), fall back to unscoped on a 404/406 scope, and filter
  the requested types client-side so the consumer still gets a narrowed set.
- **#60 (7.1.0)** — parse **prefix-agnostically**: `removeNSPrefix: true` on the
  `XMLParser` for the result, and match any prefix in the scope-path regexes
  (`modifyWhereUsedScope`, `setIsSelected`, and the `usageScopeResult → scope`
  re-wrap, which also preserves the captured prefix + its `xmlns` so the body
  stays namespace-bound).

Then `@mcp-abap-adt/core@8.3.0` consumed `adt-clients@^7.1.0`, and cloud-llm-hub
bumped to it (#139, release v6.15.0). Live re-test on DS4: `GetStructuresList(VBAK)`
→ **14 appends** (incl. `ZZAVBAK`, `AD01VBAK`, `/ILE/TILVBAK`, `FSH_VBAK`).

## Prevention rules

- **Empty parse on a 2xx ≠ "the server returned nothing."** When a parsed result
  is empty but the HTTP call succeeded, capture and look at the **raw** response
  before theorising about the server. A tiny raw-passthrough endpoint pays for
  itself in minutes.
- **Never hard-code an XML namespace *prefix*.** The prefix is an arbitrary,
  system-dependent alias for the namespace URI — strip it (`removeNSPrefix`) or
  match it generically. The same payload can arrive as `ns:` or `Ns:` across SAP
  releases.
- **Don't stop at the first plausible root cause.** The `/scope` 404 was real and
  needed fixing, but it masked the namespace-prefix bug behind it. Verify the fix
  against live data, not just "the error went away."
- **Verify your own no-limit / no-truncation claims** against real data before
  asserting them — the count limit was genuinely server-side, but only a raw
  capture proved it.
