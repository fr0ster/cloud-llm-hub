# Tutorial Design Principles

## Read this first — what these tutorials are, and what they are not

**Not a step-by-step recipe.** You will not get identical output by copy-pasting the same prompts. AI is non-deterministic; SAP systems differ; prior context in your session shapes what happens next. Two people running the same tutorial will get two slightly different Business Objects.

**Not a push-button generator.** The goal is not "paste prompts, get BO". If that is what you want, write the BO by hand — it is faster.

**Yes, a structured rehearsal in pair programming with AI.** You learn how to drive AI: how to formulate requirements, how to catch hallucinations, how to react when AI invents fields, how to enforce package and activation discipline. The BO you build is the side effect; the skill you take away is the point.

## What stays the same, what varies

**Stable** across runs:
- The four phases and their order.
- The kinds of artefacts you produce (business requirements doc, technical spec, implementation plan, working application).
- The classes of mistake AI makes — hallucinated activation, silent `$TMP` fallback, spec drift, draft-table field-name errors. You learn to spot them regardless of their specific shape.

**Variable** across runs:
- Exact field names, types, and entity structures that AI proposes.
- The number of iterations in each phase.
- Which specific mistakes AI makes this time.
- Token cost and time to completion.

If you want a specific BO to appear, you must steer every phase. AI will not read your mind from Phase 1 and emit the same output as someone else. That is by design.

## Four phases

Phases 1-3 produce one saved artifact each. You approve before moving on. Never let AI chain phases on its own.

### Phase 1 — Business requirements

- **Your role:** domain expert.
- **AI's role:** business analyst, formalizing what you describe.
- **Output:** a markdown file listing entities, relationships, business rules, use cases.
- **Save as:** `business-requirements` in the working RAG collection.
- **Done when:** the file covers your idea end-to-end in plain business language, no ABAP terms.

### Phase 2 — Technical specification (draft)

- **Your role:** architect. You decide technology (RAP managed + draft, strict 2), naming, constraints.
- **AI's role:** technical writer, translating business rules into ABAP objects, DDL, mappings.
- **Output:** a markdown file — all domains, data elements, tables (persistent and draft), CDS views, BDEF, service layer.
- **Save as:** `tech-spec` in the working RAG collection.
- **Done when:** every field maps to a named data element (no base ABAP types in tables); every DE references a domain; domains have concrete type + length; compositions vs associations are correct; draft tables are declared for every persistent table.
- **Important:** this is a draft. Implementation (Phase 4) will reveal gaps. Accept that now — investing effort in the draft reduces later churn but does not eliminate it.

### Phase 3 — Implementation plan

- **Your role:** project manager.
- **AI's role:** lead developer.
- **Output:** a numbered plan — package → domains → data elements → tables → draft tables → CDS interface → CDS projection → MDE → BDEF + BIMP → projection BDEF → service definition → service binding. Each step names the objects, the DDL, the verification, and the activation.
- **Save as:** `impl-plan` in the working RAG collection.
- **Done when:** the plan lists every object from the spec, in dependency order, with explicit activation checkpoints between layers.

### Phase 4 — Implementation

- **Your role:** reviewer and gatekeeper.
- **AI's role:** executor.
- **Loop for simple objects (domain, data element, table):** prompt → create → read back → activate.
- **Loop for complex objects (CDS, BDEF):** prompt with explicit DDL → create → syntax check → fix → re-check → activate group.
- **Checkpoint between layers:** every object in the layer is verified active before starting the next layer.
- **Done when:** the service binding works in a browser.

**During Phase 4 the spec is alive.** When reality diverges from the draft — e.g. a field type you specified does not activate — correct the saved artifact with `rag_correct` first, then fix the SAP object. Later prompts retrieve the corrected version by the same artifact id.

## RAG artifact rules

Create one working RAG collection before Phase 1. The tutorial should say this in prerequisites.

| Phase | Artifact id | Save with | Correct with |
|---|---|---|---|
| 1 | `business-requirements` | `rag_add` | `rag_correct` |
| 2 | `tech-spec` | `rag_add` | `rag_correct` |
| 3 | `impl-plan` | `rag_add` | `rag_correct` |

Do not re-upload corrected artifacts manually and do not call `rag_add` again with the same id. `rag_correct` keeps the id stable and supersedes the old version.

## Readability and focus rules

Tutorials must be readable for B1-level English readers and workable for people with ADHD or anyone who loses focus in long sessions.

- Use short sections with one goal per section.
- Put the action before the explanation.
- Keep prompts copyable and separate from commentary.
- Add checklists for progress and checkpoints.
- Say when to pause, verify, or start a fresh session.
- Avoid long paragraphs unless they are reference material.
- Repeat critical safety rules near the step where the reader needs them.

## Anti-patterns

| Anti-pattern | Why it's bad | Do this instead |
|---|---|---|
| "AI, create everything" | AI invents, drops, or duplicates objects in large batches | 3–4 objects per prompt, verify each |
| "Activate all inactive objects" | Activates other users' work on shared systems | Filter by your prefix: "all inactive objects starting with `Z##_`" |
| Accepting "all active" without evidence | AI fabricates success claims | Require `[SmartAgent: Executing Read…]` trace |
| Copy-paste prompts expecting same output | AI is non-deterministic | Treat prompts as templates; steer with constraints |
| Chaining phases without review | Errors compound; later phases inherit bad assumptions | Explicit approval before each phase transition |
| Retrying the same failed prompt verbatim | Same input ≈ same failure | Diagnose first; adjust the prompt |

## For tutorial authors

- Test every prompt on a real system; document the actual errors you see.
- Promote recurring errors from the tutorial into the skill file — the skill is the distilled rules, the tutorial is the learning path.
- Show the loop, not the happy path. Real runs have syntax errors, activation failures, lock conflicts — make the reader ready for those.
- Keep scenarios small enough that one reader can finish in 1–2 hours.
