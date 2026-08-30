# Tutorial: ABAP Code Review via AI Pair-Work

> Every prompt and skill in this tutorial is an example, not a copy-paste template. This is one already-designed process for one worked example: ABAP code review of a legacy SFTP report.

Read first: [AI Pair-Programming Principles](../AI_PAIR_PROGRAMMING_PRINCIPLES.md).

Sister tutorial: [codebase-analysis](../codebase-analysis/README.md). Code-review reuses the same per-stage discipline, but each "stage" is an independent **defect-category check** rather than a sequential evidence build-up.

## TL;DR

You will review one ABAP object across four independent defect categories, aggregate findings with severity, and produce a manager-grade report. The worked example is `ZDEMO_REPORT` in package `Z001`.

Pipeline:

```text
informal review request
  -> Stage 0 -> chat context             (full ABAP source loaded — main + every include)
  -> Stage 1 -> 01-target.md             (target object, scope of review, severities, tooling)
  -> Stage 2 -> 02-security.md           (security check — auth, secrets, injection)
  -> Stage 3 -> 03-performance.md        (performance check — SQL, loops, indexes)
  -> Stage 4 -> 04-cleancore.md          (S/4HANA CleanCore compliance check)
  -> Stage 5 -> 05-maintainability.md    (modern-ABAP, dead code, modularization)
  -> Stage 6 -> 06-summary.md            (aggregated findings + severity ranking)
  + manager  -> report.pptx              (slide deck — one page per category + verdict)
  + retro    -> RETRO.md                 (tokens, wall-clock, lessons)
```

**Stages 2-5 run in parallel** — they read the same source but apply independent rule sets. No shared state, no dependency chain. Safe to fan out (light tools only: `ReadProgram`, `GetIncludesList`, `GetInclude`, `GetFunctionModule`). Do not use `SearchSource` here — it's package-wide scan, not per-object review.

**Stage 0 is mandatory and runs in its own turn.** Earlier versions of this tutorial bundled the read procedure into each per-category prompt. The model — under the weight of the rule set — skipped the read and produced findings invented from training-data ABAP. Splitting the read out into the [analyzing-an-abap-report](skills/analyzing-an-abap-report.md) skill, fired before the first per-category prompt, fixes that failure mode.

## Anti-pattern we critique

Asking "review this code" as one mega-prompt yields shallow lists where critical findings get diluted by stylistic noise. Four problems:

- **Mixed severity.** Critical security issues end up next to nit-picks about whitespace. Reviewer fatigues.
- **Inconsistent rules.** "Review this" doesn't bind the LLM to one rule set; output drifts based on which category the model decides to emphasize.
- **No completeness claim.** Single-prompt review can miss whole categories silently.
- **No tutorial yield.** Each "review this" prompt produces a one-off — no reusable check skill for next time.

This tutorial decomposes the review into four pinned check categories with their own rule sets, then aggregates.

## Anonymization

This is a private customer repository. Real names (Z* objects, package names, SM69 commands) are preserved in examples for credibility. If you ever copy the artifacts to a public repo or share with a third party, anonymize first.

## Setup (one-time per session)

Upload the following skill files to a `user`-scope RAG collection in the chat UI and enable it. The chat session will pick them up automatically — no extra prompt boilerplate needed.

- `skills/analyzing-an-abap-report.md` — Stage 0. Tells the model to read main + every include with the right MCP tools before any analysis.
- Stage 1 has no skill file yet — follow the prompt in the Stage 1 section below and use
  `examples/ZDEMO_REPORT/01-target.md` as the reference for the expected output.
- `skills/security-review.md`, `skills/performance-review.md`, `skills/cleancore-review.md`, `skills/maintainability-review.md` — Stages 2–5.
- `skills/markdown-review-output.md` — Stage 6.

The skills are small (frontmatter-heavy). Upload them once per tutorial run; they live alongside any other RAG content you already use.

## Progress

- [ ] Setup: skills uploaded to RAG collection and enabled.
- [ ] Stage 0: full source loaded into chat session via the `analyzing-an-abap-report` skill.
- [ ] Stage 1: target formalized; `01-target.md` written and reviewed.
- [ ] Stage 2: security check complete; `security-review.md` reviewed.
- [ ] Stage 3: performance check complete; `performance-review.md` reviewed.
- [ ] Stage 4: cleancore check complete; `cleancore-review.md` reviewed.
- [ ] Stage 5: maintainability check complete; `maintainability-review.md` reviewed.
- [ ] Stage 6: aggregated; severity-ranked summary written; recommended actions captured.

## Work rhythm

- Stage 0 runs **once per chat session**, in its own turn (e.g. `Read full code with every include for code review of ZDEMO_REPORT`). It must not be merged into a per-category prompt — bundling re-triggers the original failure mode.
- Stage 1 is sequential and gates everything below it. Stages 2-5 are independent — fan out, then merge.
- Fresh chat per check (each check has its own rule set; cross-talk leaks rules). Two ways to deliver Stage 0's source to each fresh per-category chat:
  - **Chat-UI flow** — upload [analyzing-an-abap-report](skills/analyzing-an-abap-report.md) to a RAG collection once. Every fresh chat then runs Stage 0 in its own first turn (one Stage 0 call per per-category chat). The skill ensures the read happens before the per-category prompt.
  - **Curl-batch flow** (see `examples/.../curl/run-checks.sh`) — Stage 0 fires ONCE up front and extracts the source verbatim into a local `source.txt`. Each per-category call is then stateless and inlines `source.txt` in the user message. Justified by the server-side chat-history trim policy: the assistant text of a previous turn is cut to a few hundred chars before the next turn sees it (`srv/openai-handler.ts:trimHistoryForContext`), so source can't be staged via session history in a multi-turn batch.
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

## Stage 0: Load the full source

Use [analyzing-an-abap-report](skills/analyzing-an-abap-report.md). One turn: `Read full code with every include for code review of <OBJECT>`. Verify the inventory message lists the main program plus every include the next stages will rely on. If anything came back as inaccessible, stop and fix access before continuing — partial reads produce confidently wrong findings.

## Stage 1: Formalize the review target

Write `01-target.md` (no skill file for this stage — use `examples/ZDEMO_REPORT/01-target.md` as the format reference). Output: target object name + type, scope (main + how deep into includes), check categories included, severity scale, available SAP tools, what's out of scope.

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

Use [aggregation](skills/markdown-review-output.md) to merge the four `0N-*.md` files into `06-summary.md`. Output: severity histogram, per-category counts, top-5 highest-severity issues, owner-prioritized backlog.

Then build `report.pptx` for the manager and `RETRO.md` for next time.

## What this tutorial does not teach

- Refactoring or fixing the findings.
- Picking modernization targets (CDS view replacement, RAP migration).
- Cross-program reviews — this is one-object scope. For "review N objects", repeat the pipeline.
