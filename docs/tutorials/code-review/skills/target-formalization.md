---
name: target-formalization
description: Stage 1 of code review — turn an informal "review this code" ask into a concrete `01-target.md` with object, scope, severity scale, available tools
---

# target-formalization

Stage-1 skill. Once-per-object. Output: `01-target.md` that the four parallel checks read from.

## Goal

A stranger reading `01-target.md` can tell:

- Which exact ABAP object is under review (name, type, package, destination).
- How deep the review goes (main only? includes? referenced function modules?).
- Which categories are in scope and which are not.
- What severity labels mean concretely.
- Which SAP tools the checks have access to.
- What is deliberately out of scope.

## Inputs you write down directly

You don't need an LLM call here. Capture these in `01-target.md`:

- Object name / type / package
- Destination
- Include depth (just main / +1 level / recursive)
- In-scope categories (security / performance / cleancore / maintainability)
- Severity scale (default: CRITICAL / HIGH / MEDIUM / LOW / INFO)
- Available MCP tools (probe once via raw MCP `tools/list`; filter for read-only)
- Out-of-scope items (refactor design, OS-side scripts, DDIC structure analysis)

## Severity scale defaults

| Severity | When to use |
|---|---|
| CRITICAL | Data loss risk, security breach, production outage. Block release. |
| HIGH | Functional / compliance defect, bypassable but real. Fix this quarter. |
| MEDIUM | Maintainability / perf issue that increases tech debt. Plan in. |
| LOW | Style / idiom issue. Fix during normal evolution. |
| INFO | Note for future awareness, not a defect. |

If you change defaults, document the new scale in `01-target.md` — every check skill reads it from there.

## Checkpoint

Before launching Stages 2-5: does `01-target.md` tell the four checks **the same thing** about scope and severity? If scope drifts between checks, aggregation in Stage 6 ends up comparing apples to oranges.

## Worked example

`examples/ZDEMO_REPORT/01-target.md` — full real-world target file.

## Related

- `security-review.md`, `performance-review.md`, `cleancore-review.md`, `maintainability-review.md` — the four parallel check skills that consume this artifact.
- `aggregation.md` — Stage 6, the only place severity counts are combined across categories.
