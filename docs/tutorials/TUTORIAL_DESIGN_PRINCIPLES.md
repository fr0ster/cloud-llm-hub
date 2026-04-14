# Tutorial Design Principles: AI as a Partner, Not a Servant

> AI is your pair programming partner. You bring domain knowledge and make decisions. AI brings technical execution and catches blind spots. Neither works well alone.

## Core Philosophy

**AI-assisted development is collaboration, not delegation.** The user is always the architect, the reviewer, and the decision maker. AI proposes, implements, and checks — but never decides.

## Tutorial Structure: 4 Phases

Every AI-assisted development tutorial follows 4 iterative phases. Each phase has a feedback loop. Transition to the next phase only after explicit user approval.

### Phase 1: Business Requirements

**Roles:** User = domain expert, AI = business analyst

**Loop:**
1. User describes the idea in natural language
2. AI formalizes: entities, relationships, business rules, use cases
3. User evaluates, makes corrections
4. AI reformulates with corrections
5. Repeat until user says "business description is ready"

**Exit criteria:** Formal business description that fully covers the idea, without technical details.

**What the user learns:** How to articulate requirements clearly enough for AI to understand. How to review AI's interpretation and catch misunderstandings early.

### Phase 2: Technical Specification

**Roles:** User = architect (makes decisions), AI = technical writer

**Loop:**
1. User specifies: technologies (RAP, Fiori Elements), principles (strict mode, draft, managed), constraints (what is undesirable/dangerous)
2. AI transforms the business description into a technical specification: ABAP objects, field types, CDS structure, BDEF configuration, UI annotations
3. User evaluates, points out issues
4. AI adjusts the specification
5. Repeat until user says "specification is ready"

**Exit criteria:** Complete technical specification with a list of all objects, DDL, and dependencies.

**What the user learns:** How to guide AI's technical decisions. How to set constraints (no SQL injection, no expensive LLM calls, no heavy DB operations). How to evaluate whether AI's technical choices are sound.

### Phase 3: Implementation Plan

**Roles:** User = project manager, AI = lead developer

**Loop:**
1. AI proposes a plan: creation order, activation groups, checkpoints
2. User evaluates, adds requirements (e.g., "create domains separately first")
3. AI refines the plan
4. Repeat until user says "plan is ready"

**Exit criteria:** Numbered plan where each step has: what to create, DDL/source code, how to verify, how to activate.

**What the user learns:** Why order matters. Why checkpoints between layers prevent cascading failures. How to structure work for AI execution.

### Phase 4: Step-by-Step Implementation

**Roles:** User = reviewer/tester, AI = developer

**For simple objects (domains, data elements, tables):**
1. User gives prompt from the plan
2. AI creates the object
3. User verifies ("read the created object")
4. Activation

**For complex objects (CDS views, BDEF) — interactive loop:**
1. User gives prompt with DDL
2. AI creates/updates the object
3. AI (or user) runs syntax check
4. If errors: AI analyzes → proposes fix → user approves → AI applies → check again
5. Repeat until check is clean
6. Only then — activate (group activation where needed)

**Checkpoint between layers:** After each layer (tables -> CDS -> BDEF -> service) — full verification that all objects are active and error-free.

**Exit criteria:** Working application with UI.

**What the user learns:** The create-check-fix-activate cycle. That complex objects rarely work on the first attempt. That syntax check before activation saves time. That AI can diagnose errors but the user decides how to fix them.

## Key Principles

### For the User

1. **AI does not make decisions — it proposes.** Every phase has explicit "ready" from the user.
2. **Review everything.** AI-generated DDL may have subtle errors (wrong mapping, missing authorization, incorrect keys). Always verify.
3. **Complex objects are iterative.** Create -> check -> fix -> check -> activate. This is not a failure — this is the normal workflow.
4. **Never activate without checking first.** Group activation is expensive and hard to undo.
5. **Use prefix for isolation.** On shared systems, always filter by your prefix. Never "activate all inactive objects" without a filter.
6. **Give AI context, not just commands.** "Create a BDEF" is worse than "Create a BDEF for managed BO with draft, strict(2), authorization master, 4 entities with these specific mappings".

### For Tutorial Authors

1. **Show the feedback loop, not just the happy path.** Real development has errors. Show how to handle them.
2. **Document known AI mistakes.** Every step should list what the AI typically gets wrong and how to fix it — this becomes training data for future skill improvements.
3. **Include the skill file.** AI needs domain knowledge (RAP rules, BDEF constraints, draft table key rules) to perform well. Without it, it will make the same mistakes every time.
4. **Test every prompt.** Run each tutorial prompt against the real system. Document the actual response, including errors. Update the tutorial based on reality, not theory.
5. **Checkpoints are mandatory.** Between every layer, verify. In the tutorial, show the verification prompt and expected result.
6. **Evolve from tutorial to skill.** Every error pattern discovered during tutorial testing should be added to the skill file. The skill file is the distilled knowledge; the tutorial is the learning journey.

## Anti-Patterns

| Anti-Pattern | Why It's Bad | What to Do Instead |
|---|---|---|
| "AI, create everything" | AI will make errors in complex objects that cascade | One layer at a time, verify between layers |
| "Activate all inactive objects" | May activate other users' objects on shared systems | Always filter by prefix |
| Skipping syntax check | Activation failure leaves locked/inconsistent objects | Check before every activation |
| Accepting AI output without review | Subtle errors (wrong mapping, missing keys) corrupt data | Read back every created object |
| Giving commands without context | AI guesses wrong about patterns, conventions, constraints | Provide DDL, specify strict mode, list requirements |
| Retrying the same failed prompt | Same input = same error | Diagnose the error first, then adjust the prompt |
