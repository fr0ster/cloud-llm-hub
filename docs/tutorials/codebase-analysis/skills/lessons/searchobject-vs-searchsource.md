---
name: searchobject-vs-searchsource
description: When a prompt mentions both SearchObject and SearchSource, the model often picks SearchSource for the existence check and reports false `not-found`
trigger: Stage 2 / Stage 3 — verdict comes back `not-found` after a single tool call to `SearchSource`
---

# Lesson — `SearchObject` vs `SearchSource` tool confusion

## Trigger

Stage-2 response ends with:

> **Verdict:** not-found
> **Evidence:** `SearchSource` returned `{"results": [], "scanned": {...}}`

…but the object actually exists in the system (a prior run with `SearchObject` found it, or the user is sure).

## Why this happens

`SearchObject` and `SearchSource` are two different tools with similar names:

- `SearchObject(name)` — repository lookup. Confirms an object exists and returns its type and package. This is the right tool for "does X exist?".
- `SearchSource(query, query2?, package?)` — source-text search across a package. Requires a package scope and matches by code content. Not designed for "does this name exist".

When a Stage-2 prompt lists both tools, the model often picks `SearchSource` for the step-1 existence check, queries it with just the object name, gets an empty result, and emits `not-found`.

## How to apply in Stage 2 prompt

Make the existence check unambiguous:

> Step 1: call `SearchObject('{seed}')` to confirm the object exists and to get its type and package. Do not use `SearchSource` for this step — `SearchSource` is a source-text search across a package, not an existence check. If `SearchObject` returns 0 results, verdict is `not-found` and show its literal output. If `SearchObject` returns a hit, proceed.

Place the SearchObject instruction in a paragraph by itself, well before `SearchSource` is mentioned. Reinforce by repeating "SearchObject" at the point where the verdict rule about not-found is stated.

## How to detect this failure mode mechanically

Grep the response for the tool-marker sequence. If the only tool fired is `SearchSource` and the verdict is `not-found`, this is the bug. A genuine not-found from `SearchObject` will show `[SmartAgent: Executing SearchObject...]` as the first (and possibly only) marker.

## Worked example (2026-05-19 run)

`ZDEMO_FT_CAPARIO_PULL` (seed #4) and `ZDEMO_EDI_IN` (seed #10): English Stage-2 retry returned `not-found` after a single `SearchSource` call. Both objects exist (the earlier Ukrainian run had found them and read source). Retry with the explicit "use SearchObject, not SearchSource" instruction recovered them.
