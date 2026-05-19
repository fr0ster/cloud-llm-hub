---
name: using-searchsource
description: Drive SearchSource through SmartAgent without truncation or timeouts by spelling out every parameter in the prompt
trigger: about to ask the SmartAgent to call SearchSource for a completeness-critical scan
---

# using-searchsource

`SearchSource` does what you expect when its arguments are explicit. It fails silently when the planning LLM is left to pick defaults — the defaults are too tight for real customer-namespace packages and trigger truncation or hit loss without any error.

This skill is about how to ask SmartAgent to call SearchSource so the result is actually complete.

## The rule

**Always spell out the parameters in the prompt.** Don't rely on planning-LLM defaults. The agent will pass through what you write.

Minimum complete set, with values that worked end-to-end on a `Z001`-sized customer namespace in the 2026-05-19 run:

```
query: "<one specific keyword>"
packages: ["<package>"]
include_subpackages: true
object_types: ["PROG","FUGR","CLAS"]
max_objects: 5000
concurrency: 8
max_hits_per_object: 10
emit_no_hits: false
```

Wall-clock: ~7 minutes on a 819-object / 60676-source package. Result: complete, no truncation.

## Why each one matters

| Parameter | Default (too tight) | Suggested | Why |
|---|---|---|---|
| `max_objects` | likely <1000 | **5000+** | Otherwise `truncated.by_object_cap=true` on any real customer package; results are silently a lower bound. |
| `max_hits_per_object` | 1 (observed) | **10** | Defaulting to 1 means objects with multiple hits (e.g. an SFTP wrapper that references the credential string twice) lose all but the first. Caused the `ZDEMO_FG2:55` loss in the run. |
| `emit_no_hits` | true (suspect) | **false** | If true, every scanned object becomes a record — 60k+ entries for `Z001`. Response becomes unmanageable. |
| `object_types` | unset / broad | **["PROG","FUGR","CLAS"]** | Drops DDIC types, structures, etc. Scan time roughly proportional to type count. |
| `concurrency` | low | **8** | Higher = faster scan, bounded only by SAP backend session limits. |
| `include_subpackages` | false (suspect) | **true** | Customer code is usually split across sub-packages; without this you scan only the root. |
| `packages` | — | array, plural | The parameter is plural for a reason — pass it that way. |

## Prompt pattern

```
You have the tool `SearchSource`. Use it ONCE with these EXACT arguments — do not change them, do not add a `query2`, do not lower `max_objects`:

- query: "<keyword>"
- packages: ["<package>"]
- include_subpackages: true
- object_types: ["PROG","FUGR","CLAS"]
- max_objects: 5000
- concurrency: 8
- max_hits_per_object: 10
- emit_no_hits: false

After the call, output:

**SearchSource result:**
- total_hits: <N>
- scanned: { packages: <P>, objects: <O>, sources: <S> }
- truncated: { by_object_cap: <bool>, by_max_objects: <bool> }

**Hits grouped by object_name:**
- <object_name> (<object_type>, include=<include_or_self>): line <L> — <snippet>

Do not call SearchSource more than once.
```

The "do not change them" / "do not add a `query2`" / "do not lower `max_objects`" guards matter — without them the planning LLM sometimes paraphrases the args back to its own defaults.

## Picking the `query` keyword

Avoid AND-queries (`query` + `query2`). They appear to scan slowly enough that real customer packages time out at 600s with no partial result. Until that's fixed upstream, prefer one specific keyword.

The right keyword is the rarest unambiguous string that proves the hypothesis. Examples:

- "Find all SFTP-via-OS callers in `Z001`" → `PRIVATE_KEY_PATH` (unique to the SFTP credential bundle in this estate).
- "Find all callers of a Z function module `ZDEMO_MD_GET_FROM_SFTP`" → the FM name itself.
- "Find all places using kernel `CALL 'SYSTEM'`" → `CALL 'SYSTEM'` literal (rare in customer code).

If two keywords are both required (rare), run two single-keyword scans and intersect client-side.

## Completeness checklist

A scan is "complete" only when:

- `truncated.by_object_cap` is **false**
- `truncated.by_max_objects` is **false**
- `scanned.objects` ≤ `max_objects` you passed
- The keyword is the most-specific unambiguous marker for the hypothesis
- You spelled out every parameter (no planning-LLM defaults)

If any of those fails, the hits are a lower bound — say so in the analysis.

## Never run SearchSource calls in parallel

Do not fan out multiple `SearchSource` calls against the same SAP destination at the same time. Run them sequentially.

**Why:** Each `SearchSource` with `concurrency: 8` already spawns 8 parallel scan workers on the SAP side. Two such calls in parallel = 16 workers; four = 32. The SAP backend saturates and every call times out — confirmed in the 2026-05-19 run. Wall-clock measurement: 4 calls in parallel all timed out at 600s; the same scan combined into one sequential call returned complete in 443s.

**How to apply:**

- One `SearchSource` in flight per destination at a time. Wait for completion before issuing the next.
- If you have N specific FM names to search for and they share a substring, **prefer one combined substring scan** over N individual exact-match scans. Example: search `_FROM_SFTP` to catch both `ZDEMO_MD_*_FROM_SFTP` and `ZDEMO_FG2_*_FROM_SFTP` wrapper FMs in one pass.
- Light tools (`ReadProgram`, `GetInclude`, `SearchObject`, `GetIncludesList`) are fine in parallel — they don't trigger the full-source scan and don't saturate the backend the way `SearchSource` does. The rule is specifically for `SearchSource` and other full-scan operations.

## Dividing a big scan into smaller ones

If a single scan still times out (e.g., on truly huge packages) or you need an AND-shape:

1. **Split by `object_types`.** One call for PROGs, another for FUGRs, another for CLAS. Sum client-side.
2. **Split by sub-package.** Enumerate sub-packages first, then run one scan per sub-package in parallel. Each scan is bounded by its own object count, so timeouts become localized.
3. **Pick a narrower keyword first.** If `PRIVATE_KEY_PATH` is too slow, try its rarer variant (`PRIVATE_KEY_PATH_E`) or a co-occurring rare string.
4. **Use `exclude`.** Drop sub-trees you know don't contain the answer (test packages, etc.).
5. **Reverse-search artifacts found in step 1.** Once you know the names of FM wrappers etc., search for their names — that scan is much smaller because the keyword is rare.

## When this isn't enough

If, with every parameter spelled out, the result is still truncated, missing hits, or times out — that's a real bug in the SmartAgent layer or the MCP server. Track in the upstream issue, do not paper over with workarounds in user-facing prompts.

## Related

- `lessons/searchobject-vs-searchsource.md` — keep the two search tools in separate prompts.
- `lessons/agent-tool-loop-needs-once-guard.md` — when the planning loop re-invokes SearchSource pointlessly.
- `mcp-abap-adt#89` — upstream issue tracking the timeout, default-clamp, and chunking work.
