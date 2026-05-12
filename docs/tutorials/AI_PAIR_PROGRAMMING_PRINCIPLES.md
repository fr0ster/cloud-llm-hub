# AI Pair-Programming Principles

How to work with an AI as a pair on a long-horizon task — and how to build a **process** you can re-run, not a one-off chat trace. Domain-independent. Concrete tutorials in this repository instantiate these principles for specific tasks.

## TL;DR

Two non-negotiable principles. A four-step method for building a concrete process. Five properties any such process must have.

- **Principles:** interactive small-step pair-work + extracting a re-usable process/skill is as important as solving the task.
- **Method (in order):** formalize the task → design the process → execute the stages (refine skills at every checkpoint) → verify the goal.
- **Goal-verification decides routing.** Pass → done. Fail → return to a named earlier stage. No fixed branching rules.

## Tutorials in this repo

Each maps these principles to a concrete task.

- [`rap-bo-creation`](rap-bo-creation/README.md) — fixed-recipe RAP Business Object walkthrough.
- [`rap-bo-book-catalog`](rap-bo-book-catalog/README.md) — phase-based AI-assisted RAP BO build with RAG artifacts.
- [`codebase-analysis`](codebase-analysis/README.md) — analyzing how a codebase implements a target mechanism in preparation for migration; SFTP-in-ABAP as worked example.
- *Planned:* migration tutorial — takes `codebase-analysis` output and proposes unification. Fourth tutorial; not yet drafted.

## Core principles

### 1. Work interactively with AI as a pair

Reader drives, AI proposes. Every meaningful step is a small interaction that produces a reviewable artifact. No "paste this prompt and ship the result" — same prompt, different output every time. Reader judges, AI drafts. Neither side defers.

Concrete obligation in a tutorial: every section ends with a reviewable artifact or a decision-point. Silent AI authority is a bug.

### 2. Extracting the process is as important as solving the task

The artifact you produce solves one instance. The **process and the skills** you extract solve the next instance, and the one after. A run that leaves no refined process or skill behind has burned experience that walks out the door with you.

Concrete obligation in a tutorial: each stage checkpoint asks *"what did you change in your process notes or in a local skill copy?"* — and if the answer is *"nothing"*, that's a yellow flag for re-reading the run.

## Method for building a process

Use this to design a process for any new long-horizon task. Linear, in order.

### 1. Formalize the task

**Output:** process goal (plain language, measurable) + method for measuring goal achievement.
**Why:** without it every later step risks answering the wrong question.

### 2. Design the process

**Output:** stage list, per-stage artifact, per-stage evaluation principle.
**Why:** stages are task-specific. **The principles do not prescribe stages; they prescribe that you must design stages.**

### 3. Execute the stages

**Output:** the per-stage artifact each stage produces.
**Why:** refine skills at every checkpoint, not as a separate pass. If a stage refined nothing, ask why before advancing.

### 4. Verify goal achievement

**Output:** explicit yes / no, reasoning mapped to the measurement method from step 1.
**Why:** yes → done. No → verification names the earlier stage to return to, based on which evidence was missing or wrong. **No pre-baked "if X return to Y" rules.**

## Two reader roles

The method above is for someone **building** a process from scratch.

In this repository's tutorials, the author has **already** executed steps 1-2 (formalize and design) once when writing the tutorial. The reader either:

- **Runs the pre-built process.** They walk through Stages 1..N of the tutorial, doing step 3 (execute) and step 4 (verify) for their own concrete task data. Step 2 (design) is the author's; reader inherits it.
- **Builds their own process.** They take the tutorial as a worked example and design their own stages for a different task, doing all four steps themselves.

Tutorials in this repo are written for the first reader role.

## Properties of any process built this way

- **Interactivity.** Small reviewable steps, never a single mega-prompt.
- **Mutual completeness verification.** Reader checks AI outputs for completeness; AI checks reader inputs for completeness (within what's possible). Both sides have a job.
- **Iteration without prescription.** Returning to an earlier stage is normal. *Which* earlier stage is decided by the failing goal-check, not by a pre-baked rule.
- **No copy-paste of skills or prompts.** Skills and prompt patterns are **examples**. The reader adapts them for each run.
- **Skill extraction at every stage.** Every checkpoint asks the skill question, even if no new skill file ships. Process notes count.

## Readability and focus rules

Tutorial **text style**. Must be scannable in seconds. B1-level English.

- One goal per section.
- Action before explanation.
- Prompts are copyable and separated from commentary.
- Checklists for progress, named stage checkpoints.
- Tell the reader when to pause, verify, or start a fresh chat.
- Repeat critical safety rules near the step that needs them.

## Anti-patterns

| Anti-pattern | Why bad | Do instead |
|---|---|---|
| Asking the wrong (derived) question | Whole run answers something the stakeholder never asked | Step 1 — formalize the task. Verify the question matches stakeholder intent before scoping the rest. |
| One mega-prompt for the whole task | AI batches, invents, drops, duplicates | Atomic units per prompt, verify each. |
| Mass operations across shared resources | Touches other people's in-progress work | Scope to your own prefix / namespace / workspace. |
| "Done" / "complete" without evidence | AI fabricates success claims | Demand a tool-call trace per claim. For "complete" — declared scope + channels + blind spots. |
| Copy-paste the same prompt expecting the same output | AI is non-deterministic; outputs drift | Treat prompts as templates. Steer with constraints. Expect variation. |
| Chaining stages without review | Errors compound; later stages inherit bad assumptions | Reader approves between stages. AI never chains. |
| Retrying a failed prompt verbatim | Same input ≈ same failure | Diagnose. Adjust the prompt. Or start a fresh session if the context is polluted. |
| AI drifts past the current stage | Scope creep — proposes migration mid-analysis | Name the current stage in the next prompt. Park out-of-stage suggestions in the appropriate later artifact. |
| Solving the task without refining the process or any skill | Experience walks out the door | Every checkpoint: *"what did I change in the process or skills?"* If nothing — re-read the run. |
| Hard-coding the stage list as if it were universal | Different tasks need different stages | The method's step 2 is per-task. Don't pretend a stage list is universal. |

## For tutorial authors

Authoring **discipline**, separate from the text-style rules above.

- Test every prompt on a real target system; document the actual errors you see.
- Promote recurring errors from the tutorial into the skill files. Tutorial = path. Skill = distilled rules.
- Show the loop, not the happy path. Real runs have errors, ambiguous evidence, truncated results, blind spots.
- One stage ≈ one focused session for the reader (typically under two hours).
- Ship one starter skill per stage. Mark it as a starter — not a final answer — that the reader edits during their run.
- Tutorial-specific mechanics (artifact ids, RAG channels, tool names) live in the tutorial folder. **Not here.**
- An anti-pattern bubbles up here only when it generalizes across tutorials.
