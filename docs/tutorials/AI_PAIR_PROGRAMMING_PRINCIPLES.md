# AI Pair-Programming Principles

How to work with an AI as a pair on a long-horizon task — and how to build a **process** you can re-run, not a one-off chat trace. Domain-independent.

## TL;DR

- **Principles:** interactive small-step pair-work + extracting a re-usable process/skill is as important as solving the task.
- **Method (in order):** formalize the task → design the process → execute the stages (refine skills at every checkpoint) → verify the goal.
- **Goal-verification decides routing.** Pass → done. Fail → return to a named earlier stage. No fixed branching rules.

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

## Pair-work as badminton

Pair-programming with AI is a shuttlecock game. Two players, alternating turns.

- The **user** serves first — describes the task in plain language.
- The **AI** returns — formalizes, drafts, calls tools, proposes.
- The **user** reviews — keeps what holds, rejects what does not, asks for a correction.
- The **AI** returns again, sharper. And so on.

Neither side plays alone. Each exchange sharpens the result. The user always serves first; the AI never takes the lead role.

The four-step method above is the *rulebook* of the game. The badminton is *how* the two players run through it on every step.

## Properties of any process built this way

- **Interactivity.** Small reviewable steps, never a single mega-prompt.
- **Mutual completeness verification.** Reader checks AI outputs for completeness; AI checks reader inputs for completeness (within what's possible). Both sides have a job.
- **Iteration without prescription.** Returning to an earlier stage is normal. *Which* earlier stage is decided by the failing goal-check, not by a pre-baked rule.
- **No copy-paste of skills or prompts.** Skills and prompt patterns are **examples**. The reader adapts them for each run.
- **Skill extraction at every stage.** Every checkpoint asks the skill question, even if no new skill file ships. Process notes count.

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
| AI drifts past the current stage | Scope creep — starts work that belongs in a later stage | Name the current stage in the next prompt. Park out-of-stage suggestions for the right later step. |
| Solving the task without refining the process or any skill | Experience walks out the door | Every checkpoint: *"what did I change in the process or skills?"* If nothing — re-read the run. |
| Hard-coding the stage list as if it were universal | Different tasks need different stages | The method's step 2 is per-task. Don't pretend a stage list is universal. |
| Editor locks on the live system desync the AI | AI reports "active" / "created" but the object is still locked by your IDE editor (Eclipse/ADT, ABAP-in-Eclipse, …). Cuts both ways: false-positive "active" and false-negative "cannot be changed". | Close all related editors in your IDE before letting the AI run activation/modification tools. Treat one "success" claim as a hypothesis — confirm with a separate read/list checkpoint. |
| Letting the AI loop on the same symptom for more than two rounds | First try produced working output, the second "fix" breaks it — the AI walks you backwards through its own mistakes. *"Saving time with AI" turns into AI digging a hole for you.* | After two unsuccessful AI retries on the same symptom, **stop iterating and apply the fix manually** (read the spec, edit the object directly, then tell the AI *"I fixed X manually, continue from step Y"*). Reset the loop with human authority. |

