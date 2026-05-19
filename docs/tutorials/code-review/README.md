# Tutorial: ABAP Code Review via AI Pair-Work

> Every prompt and skill in this tutorial is an example, not a copy-paste template. This is one already-designed process for one worked example: ABAP code review of a legacy SFTP report.

Read first: [AI Pair-Programming Principles](../AI_PAIR_PROGRAMMING_PRINCIPLES.md).

Sister tutorial: [codebase-analysis](../codebase-analysis/README.md). Code-review reuses the same per-stage discipline, but each "stage" is an independent **defect-category check** rather than a sequential evidence build-up.

## TL;DR

You will review one ABAP object across four independent defect categories, aggregate findings with severity, and produce a manager-grade report. The worked example is `ZDEMO_REPORT` in package `Z001`.

Pipeline:

```text
informal review request
  -> Stage 1 -> 01-target.md            (target object, scope of review, severities, tooling)
  -> Stage 2 -> 02-security.md          (security check — auth, secrets, injection)
  -> Stage 3 -> 03-performance.md       (performance check — SQL, loops, indexes)
  -> Stage 4 -> 04-cleancore.md         (S/4HANA CleanCore compliance check)
  -> Stage 5 -> 05-maintainability.md   (modern-ABAP, dead code, modularization)
  -> Stage 6 -> 06-summary.md           (aggregated findings + severity ranking)
  + manager  -> report.pptx             (slide deck — one page per category + verdict)
  + retro    -> RETRO.md                (tokens, wall-clock, lessons)
```

**Stages 2-5 run in parallel** — they read the same source but apply independent rule sets. No shared state, no dependency chain. Safe to fan out (light tools only: `ReadProgram`, `GetIncludesList`, `GetInclude`, `GetFunctionModule`). Do not use `SearchSource` here — it's package-wide scan, not per-object review.

## Anti-pattern we critique

Asking "review this code" as one mega-prompt yields shallow lists where critical findings get diluted by stylistic noise. Four problems:

- **Mixed severity.** Critical security issues end up next to nit-picks about whitespace. Reviewer fatigues.
- **Inconsistent rules.** "Review this" doesn't bind the LLM to one rule set; output drifts based on which category the model decides to emphasize.
- **No completeness claim.** Single-prompt review can miss whole categories silently.
- **No tutorial yield.** Each "review this" prompt produces a one-off — no reusable check skill for next time.

This tutorial decomposes the review into four pinned check categories with their own rule sets, then aggregates.

## Anonymization

This is a private customer repository. Real names (Z* objects, package names, SM69 commands) are preserved in examples for credibility. If you ever copy the artifacts to a public repo or share with a third party, anonymize first.

## Progress

- [ ] Stage 1: target formalized; `target-formalization.md` reviewed.
- [ ] Stage 2: security check complete; `security-review.md` reviewed.
- [ ] Stage 3: performance check complete; `performance-review.md` reviewed.
- [ ] Stage 4: cleancore check complete; `cleancore-review.md` reviewed.
- [ ] Stage 5: maintainability check complete; `maintainability-review.md` reviewed.
- [ ] Stage 6: aggregated; severity-ranked summary written; recommended actions captured.

## Work rhythm

- Stage 1 is sequential and gates everything. Stages 2-5 are independent — fan out via curl batch, then merge.
- Fresh chat per check (each check has its own rule set; cross-talk leaks rules).
- Carry the target's source once. Don't re-read in every check; the read is implicit at Stage 2-5 start.
- Severity scale fixed at Stage 1, applied consistently across checks. CRITICAL → HIGH → MEDIUM → LOW → INFO.

## Things AI does wrong in this kind of review

| Symptom | What to do |
|---|---|
| AI mixes categories in one finding | Reject. One category = one stage = one prompt. |
| AI gives a finding without source citation | Force `location:line — snippet` format per finding. |
| AI invents an SAP API that doesn't exist | Pin the SAP version / namespace / available tools in `01-target.md`. |
| AI flags a deprecation but doesn't say what to replace with | Require a "Recommendation" line per finding. Empty = drop finding. |
| AI labels everything CRITICAL | Pin the severity scale + concrete examples per level in the skill file. |
| AI says "the program is well-structured" without evidence | Reject. Same evidence rule as findings — applies to praise too. |

## Stage 1: Formalize the review target

Use [target-formalization](skills/target-formalization.md) to write `01-target.md`. Output: target object name + type, scope (main + how deep into includes), check categories included, severity scale, available SAP tools, what's out of scope.

Do this once. Stages 2-5 all read from this file.

## Stages 2-5: Run the four category checks

Each check has its own skill file with the exact rule set and the prompt pattern.

- [security-review](skills/security-review.md) — `02-security.md`. Authority checks, hardcoded secrets, injection vectors, FM-call safety.
- [performance-review](skills/performance-review.md) — `03-performance.md`. SQL hygiene, loops, indexes, `SELECT *`, nested SQL, SY-SUBRC handling.
- [cleancore-review](skills/cleancore-review.md) — `04-cleancore.md`. S/4HANA CleanCore compliance — non-released API access, modifications, allowed namespaces.
- [maintainability-review](skills/maintainability-review.md) — `05-maintainability.md`. Modern ABAP idioms, dead code, magic numbers, FORM length, modularization.

Each check follows the same shape:

```text
**Findings:**
1. <SEVERITY> — <short title>
   - **Location:** <file:line>
   - **Snippet:** <verbatim ABAP>
   - **Why:** <one-sentence rule violation>
   - **Recommendation:** <concrete fix or replacement API>
```

## Stage 6: Aggregate and rank

Use [aggregation](skills/aggregation.md) to merge the four `0N-*.md` files into `06-summary.md`. Output: severity histogram, per-category counts, top-5 highest-severity issues, owner-prioritized backlog.

Then build `report.pptx` for the manager and `RETRO.md` for next time.

## What this tutorial does not teach

- Refactoring or fixing the findings.
- Picking modernization targets (CDS view replacement, RAP migration).
- Cross-program reviews — this is one-object scope. For "review N objects", repeat the pipeline.
