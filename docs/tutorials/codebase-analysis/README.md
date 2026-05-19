# Tutorial: Codebase Analysis via AI Pair-Work

> Every prompt and skill in this tutorial is an example, not a copy-paste template. This is one already-designed process for one worked example: ABAP/SFTP analysis before migration.

Read first: [AI Pair-Programming Principles](../AI_PAIR_PROGRAMMING_PRINCIPLES.md).

## TL;DR

You will analyze how a codebase uses a target mechanism, produce evidence-backed findings, and leave reusable skills behind. The worked example is SFTP in an ABAP system via `mcp-abap-adt`.

Pipeline:

```text
informal stakeholder ask
  -> Stage 1  -> 01-task.md            (formal task, goal, measurement)
  -> Stage 2  -> 02-methods.md         (per-seed verdict with source evidence)
  -> Stage 2b -> 02b-methods-deep.md   (open-ended method enumeration per "yes" seed)
  -> Stage 2c -> 02c-code-extracts.md  (verbatim ABAP snippet per distinct mechanism)
  -> Stage 3  -> 03-usage-map.md       (where every consumer lives, evidence-backed)
  -> Stage 4  -> 04-analysis.md        (where/how/why per business domain + completeness)
  -> Stage 5  -> 05-result.md          (goal answer + migration handoff)
  + manager  -> report.pptx            (slide deck — concrete consumers, code, proposal)
  + retro    -> RETRO.md               (token cost, wall-clock, failure modes, lessons)
  + log      -> session-log.md         (UI-style render of every agent interaction)
```

The 02b / 02c / pptx / RETRO / session-log additions came out of the 2026-05-19 worked example and folded back into the tutorial. Stage 2b unblocks "wrong-mechanism bias" (Stage 2's verdict is shaped by your rules; 2b is open-ended to surface variants). Stage 2c captures verbatim code per mechanism for the handoff. The deck + retro + log are deliverables shipping next to the artifacts.

## Anti-pattern we critique

A real customer asked the question through one dense prompt: a baseline program, a candidate list, a 60-line analysis recipe, "find skeleton-similar reports". Four things went wrong:

- **Wrong question.** "Skeleton similarity" instead of "how does this codebase implement SFTP".
- **Pre-baked seed list.** Constrained the agent and misled it toward pattern-matching, not mechanism discovery.
- **One mega-prompt, no checkpoints.** No chance to correct framing before the run finished.
- **No skill extracted.** Next similar task starts from scratch.

This tutorial decomposes that prompt into five staged checkpoints.

## On the worked example in `examples/`

The artifacts under `examples/` are from a real 2026-05-19 sFTP analysis run, with real customer object names (`Z*`, `ZDEMO_FT_*`, `ZDEMO_MD_*`, etc.) preserved. This repository is private and serves one customer; we don't carry an anonymization layer here. If you ever copy these examples to a public repo or share with a third party, anonymize first.

Why keep real names: the tutorial is more credible as evidence ("we actually ran this against a real estate and got these 19 objects"), not as theory.

## Progress

- [ ] Stage 1: task formalized; `task-formalization.md` reviewed.
- [ ] Stage 2: methods found; `method-discovery.md` reviewed.
- [ ] Stage 3: usage map complete within declared scope; `usage-traversal.md` and `source-code-search.md` reviewed.
- [ ] Stage 4: evidence-backed analysis complete; `usage-analysis.md` reviewed.
- [ ] Stage 5: goal verified and migration handoff written; `goal-verification.md` reviewed.

## Work rhythm

- One stage per session. Don't batch the whole pipeline.
- Fresh chat between stages — carry the artifact, not the history.
- You hold the checkpoint, not the AI.
- If lost, ask: *"which stage am I in, which artifact am I producing, what is the next single action?"*

## Things AI does wrong in this kind of analysis

| Symptom | What to do |
|---|---|
| AI lists usages without a tool-call trace | Reject. Require `[Executing <Tool>]` per claim. |
| AI batches seeds into one big response | Restart per-seed in a fresh chat. |
| AI infers business purpose from an identifier name | Force evidence column; empty → re-read source. |
| AI says "complete" without naming channels | Reject. Completeness needs declared scope + channels + blind spots. |
| AI proposes migration mid-analysis | Park the suggestion in running notes for the Stage 5 handoff. Stay in stage. |
| AI invents tool names | Pin available tools in `01-task.md`. |
| Same prompt gives different output on retry | Don't retry blindly. Start a fresh session from the saved artifact. |

## Stage 1: Formalize the analysis task

Use [task-formalization](skills/task-formalization.md) to turn the stakeholder ask into `01-task.md`: goal, measurement method, scope, constraints, tooling decisions, and out-of-scope list.

Do this before searching code. The purpose of Stage 1 is to make the analysis measurable, not to solve it.

Steps:

1. Rewrite the informal ask as a concrete analysis question.
2. Define what counts as a successful answer.
3. Declare the codebase scope and the evidence channels allowed for the run.
4. Pin available tools and known gaps.
5. List what is deliberately out of scope, especially replacement design.

Checkpoint: can a stranger tell when the analysis is done, what evidence is allowed, and what must not be solved yet?

Example: [01-task.md](examples/01-task.md).

## Stage 2: Determine SFTP methods

Use [method-discovery](skills/method-discovery.md) once per seed object. Do not batch seeds. Record yes/no/unclear verdicts with source evidence in `02-methods.md`.

Scope refinements must be explicit. If the scope change invalidates Stage 1, return to Stage 1.

Steps:

1. Start from the mechanism seeds named in `01-task.md`.
2. Open one seed per AI session and ask for a source-backed yes/no/unclear verdict.
3. Record the method, evidence, and reason for inclusion or exclusion.
4. Stop when every declared seed has a verdict.
5. Update scope only when the evidence shows Stage 1 was too broad, too narrow, or ambiguous.

Checkpoint: does `02-methods.md` name the methods that define the rest of the analysis, and does each method have source evidence?

Example: [02-methods.md](examples/02-methods.md).

## Stage 3: Find every usage site

Use two channels:

- [usage-traversal](skills/usage-traversal.md) for dependency / where-used traversal.
- [source-code-search](skills/source-code-search.md) for literal source-text search.

`03-usage-map.md` must state declared scope, channels used, search terms, and blind spots. "Complete" means complete within that scope and evidence set.

Worked-example upstream gap: [mcp-abap-adt#79 — Add SearchSource tool](https://github.com/fr0ster/mcp-abap-adt/issues/79) — filed during this run.

Steps:

1. For each method from Stage 2, run dependency / where-used traversal.
2. Run source-text search for method names, wrapper calls, and mechanism-specific literals.
3. Record every usage site with the channel that found it.
4. Mark duplicates and unresolved candidates instead of hiding them.
5. Write blind spots explicitly, including unavailable search tools or package boundaries.

Checkpoint: can the usage map explain both what was found and why the search can be called complete within the declared scope?

Example: [03-usage-map.md](examples/03-usage-map.md).

## Stage 4: Analyze usage

Use [usage-analysis](skills/usage-analysis.md) once per usage site. Classify where/how/why with evidence. For SFTP, useful axes are direction, business domain, perimeter/internal-wrapper, and recurring pattern.

Steps:

1. Take one usage site from `03-usage-map.md`.
2. Read enough surrounding source to understand the call context.
3. Fill where/how/why using evidence, not identifier guessing.
4. Classify repeated patterns only after multiple sites show the same shape.
5. Keep uncertain business purpose as unknown until the source proves it.

Checkpoint: can each conclusion point back to a usage site and source evidence?

Example: [04-analysis.md](examples/04-analysis.md).

## Stage 5: Form results and verify goal

Use [goal-verification](skills/goal-verification.md) to compare the result against `01-task.md` success criteria. `05-result.md` answers yes/no and provides migration-handoff input. No replacement design here.

Steps:

1. Restate the original goal and success criteria from `01-task.md`.
2. Summarize the method set from `02-methods.md`.
3. Summarize usage coverage and blind spots from `03-usage-map.md`.
4. Summarize where/how/why findings from `04-analysis.md`.
5. Decide whether the original analysis goal was met.
6. Move parked migration notes into a handoff section without designing the replacement.

Checkpoint: does `05-result.md` answer the original question and give the migration work enough evidence to start its own process?

Example: [05-result.md](examples/05-result.md).

## What this tutorial does not teach

- Building the SFTP replacement service.
- Choosing new ABAP SFTP APIs.
- Migrating adjacent mechanisms such as IDoc, OData, or EDI.
