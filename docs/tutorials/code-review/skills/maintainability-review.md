---
name: maintainability-review
description: Stage 5 of code review — maintainability & modern ABAP check
---

# maintainability-review

Stage-5 skill. One ABAP target → maintainability and modern-ABAP findings.

## Goal

Find style, structural, and idiomatic issues that erode readability and future maintenance. None of these block the program from running; they accumulate as technical debt.

## Rule set

- **Obsolete syntax** — `CONCATENATE`/`SPLIT` vs string templates `|...|`; `OCCURS 0`; `HEADER LINE` itabs; `MOVE ... TO ...` instead of assignment.
- **Magic numbers / literals** that should be constants or `zfi_constants` entries.
- **FORM longer than 100 lines** without clear sub-structure.
- **Dead code** — declared and never assigned/read variables; FORMs called by no one in the read source; commented-out code blocks.
- **Missing or wrong types** on `PARAMETERS` (`TYPE C` with explicit length when a domain exists).
- **Mixed inline / explicit data declarations** (`DATA: lv_x.` then `DATA(lv_y) = ...` in the same block).
- **Missing ABAP Doc** on public FMs / FORMs with parameters.
- **Type-unsafe patterns** where a type-safe alternative exists (RTTS, ABAP CDS, exception classes vs `EXCEPTIONS` clauses).
- **Inconsistent naming** within the program (mixed `lv_` / no prefix / wrong prefix).

## Severity policy

Default to MEDIUM or LOW. CRITICAL and HIGH belong in the other three categories. MEDIUM if the issue actively impedes reading; LOW if it's a habit/style concern.

## Prompt pattern

Same shape as the other check skills — runs **after** Stage 0 ([abap-read-source](abap-read-source.md)) has loaded the source, with the maintainability rule set substituted. Do NOT bundle the read procedure into this prompt. See `examples/ZDEMO_REPORT/curl/req-maintainability.json` (local, gitignored) for a worked example.

## Worked example

`examples/ZDEMO_REPORT/05-maintainability.md` — 16 LOW findings, mostly obsolete syntax (CONCATENATE / SPLIT), magic separator literals, long F01 include FORMs.

## Related

- `performance-review.md` — modern ABAP idioms often improve perf as a side effect; if the issue is *only* about scaling, route to performance.
- `cleancore-review.md` — obsolete syntax can also be a CleanCore concern; if the construct is forbidden in S/4HANA Cloud, route to CleanCore (HIGH) instead of maintainability (LOW).
- `aggregation.md` — Stage 6.
