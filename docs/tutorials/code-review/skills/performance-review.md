---
name: performance-review
description: Stage 3 of code review — performance check (SQL, loops, indexes)
---

# performance-review

Stage-3 skill. One ABAP target → performance findings.

## Goal

Find code that will not scale: SQL antipatterns, loop hotspots, missing indexes, repeated work that could be cached.

## Rule set

- **`SELECT *` without a specific field list** on a wide table — MEDIUM unless the table is known-small.
- **SELECT inside LOOP** (especially LOOP AT itab + nested SELECT) — HIGH.
- **Nested LOOP AT itab** without `BINARY SEARCH` or hashed table — HIGH if both itabs grow.
- **Missing `WHERE` clause** on SELECT against a large transactional table — HIGH.
- **`SELECT SINGLE`** without all key fields specified — MEDIUM. Ambiguous result.
- **`READ TABLE` without BINARY SEARCH** on a sorted/standard table that grows — MEDIUM.
- **Repeated calls** to the same DB / function inside a loop where memoization would work — HIGH/MEDIUM depending on call cost.
- **`FOR ALL ENTRIES`** without an `IS NOT INITIAL` guard on the driver table — HIGH (empty driver = full table read).
- **`DELETE` / `MODIFY` / `INSERT` inside LOOP** without proper safeguard / batching — MEDIUM.
- **String building by repeated `CONCATENATE`** inside a loop where a single string template / `INTO TABLE` would work — LOW (perf-relevant only at high iterations).

## Prompt pattern

Same shape as `security-review.md` but with the perf rule set substituted. See `examples/ZDEMO_REPORT/curl/req-performance.json`.

## Severity ladder

- HIGH — SELECT in LOOP, missing WHERE on big table, nested loops on growing data.
- MEDIUM — SELECT *, missing key fields, READ TABLE without binary search, MODIFY in LOOP.
- LOW — micro-inefficiency (string concat in small loop), missing FOR ALL ENTRIES batching on small set.

## Worked example

`examples/ZDEMO_REPORT/03-performance.md` — 4 findings (2 HIGH, 2 MEDIUM).

## Related

- `cleancore-review.md` — sibling skill.
- `maintainability-review.md` — sibling skill. Modern ABAP idioms often improve perf as a side effect, but if the issue is purely about scaling, it belongs here.
- `aggregation.md` — Stage 6.
