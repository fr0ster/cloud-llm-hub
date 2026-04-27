# AI-Assisted Tutorial: Book Catalog Application

This tutorial teaches you how to build a complete SAP Fiori application through **pair programming with AI**. You bring the business idea and make all decisions. AI proposes, implements, and checks — but never decides for you.

> **Read first:** [Tutorial Design Principles](TUTORIAL_DESIGN_PRINCIPLES.md) — the method behind this tutorial.

**What you will build:** A Book Catalog application — authors, books, editions, reader ratings — with a polished Fiori UI.

**System:** SAP S/4HANA (on-premise) via cloud-llm-hub
**Skill:** Upload `skills/rap-bo-creation.md` to a RAG collection before starting
**Time:** 1-2 hours
**Prerequisites:** cloud-llm-hub chat UI with MCP connection to SAP

### Progress checklist

Tick each box as you go — keeps you oriented across a multi-hour run.

- [ ] Setup: skill loaded, working RAG collection created, prefix chosen
- [ ] Phase 1 — Business Requirements saved as `business-requirements`
- [ ] Phase 2 — Technical Specification saved as `tech-spec`
- [ ] Phase 3 — Implementation Plan saved as `impl-plan`
- [ ] Phase 4 — All objects active, service binding published
- [ ] Final test in Fiori preview passes

---

## Before You Start

### What this tutorial is

Pair programming with AI to build a RAP BO from start to finish. You drive. AI writes documents, generates DDL, and runs MCP tool calls on your SAP system. This is not a one-click generator. It is a step-by-step way to learn what AI does well and where it fails.

### Ground rules

- **You decide the business model.** AI suggests; you approve.
- **Phases 1–3 produce documents only.** If AI runs a `Create…` tool during spec editing, stop — that's a phase confusion bug.
- **Phase 4 is layer by layer:** Domains → Data Elements → Tables → Draft Tables → CDS → BDEF+BIMP → Services. Activate each layer before starting the next.
- **3–4 objects per prompt, no more.** Bigger batches make the AI invent results (hallucinate).
- **Treat "Active" as a claim until proven.** Ask for a real `ReadDomain` / `ReadTable` call that shows `active: true` in the output. If the response has no `[SmartAgent: Executing …]` line, no tool ran.
- **Fix the spec as soon as you find a problem.** Your job is to spot the issue and approve the fix. How the agent applies it is described in the skill.

### Things AI does wrong

Two terms you will see often:

- **Spec/plan drift** — AI no longer follows what the spec or plan says (creates extra objects, skips ones, renames silently).
- **Phase confusion** — AI runs system-changing tools (`Create`, `Update`, `Activate`) while you are still editing a Phase 1–3 document. Phases 1–3 produce text only; Phase 4 produces objects.

| Symptom | What it means | Fix |
|---|---|---|
| "All N objects active" with no `[SmartAgent: Executing …]` lines | Hallucination | Ask AI to read each object back |
| AI creates more or fewer objects than the plan | Spec/plan drift | Quote the plan back, force the exact list |
| Objects appear in `$TMP` | AI quietly used `$TMP` after a transport error | Stop, fix the transport, redo in the correct package |
| `UpdateTable` runs while you're editing the spec | Phase confusion | Say "document only, not system" and revert |
| Same prompt gives different results | Long session — too much earlier text confuses the AI | Start a fresh session. Your saved artifacts in RAG are still up to date |
| Truncated file / 400 on spec regeneration | Single-shot too large | Regenerate section by section |
| Draft table: "Missing fields (CamelCase expected)" | snake_case field names | Use lowercased CDS alias names |
| CDS root-child relationship flipped | Composition vs association mis-read | Quote the spec, regenerate that view only |
| 40+ BDEF mapping warnings | `mapping for … corresponding` | Use explicit `{ CdsAlias = table_field; }` |

### Load the RAP skill

1. Open MANAGE panel in cloud-llm-hub chat UI
2. Create collection "RAP Skills"
3. Upload `rap-bo-creation.md` (from SharePoint or `docs/tutorials/skills/`)
4. Enable the collection (checkbox ON)

### Create the working RAG collection

The agent saves the artifacts of Phase 1–3 (business requirements, technical specification, implementation plan) into a RAG collection so later phases can retrieve and correct them. You create the collection once, before Phase 1.

1. Open MANAGE panel
2. New collection — id e.g. `book-catalog`, displayName "Book Catalog Artifacts", scope `user`
3. Enable the collection (checkbox ON)
4. In your very first prompt to the agent, tell it the name: *"Use the `book-catalog` collection for all artifacts of this tutorial."*

The agent then writes Phase 1–3 outputs into this collection via `rag_add` and corrects them via `rag_correct` when Phase 4 surfaces an issue. You do not need to interact with the collection manually — just keep it enabled.

### Choose your prefix

Use the prefix convention from [`rap-bo-creation.md` → Naming Convention](rap-bo-creation.md#naming-convention) — `Z<II><NN>_` (your 2-char initials + 2-digit number). Verify it is unused:

> Search for objects starting with `ZDEMO01_` to confirm the prefix is free.

---

## Phase 1: Business Requirements

**Your role:** domain expert. **AI's role:** business analyst.
**Goal:** A clear, formal description of what the application does — in business terms, no technical details yet.
**Output:** A markdown document, saved to RAG as `business-requirements`.

### Start the conversation

Describe your idea in plain language:

> I want to create an application for managing a book catalog. It should store information about book authors, their literary works, published editions of each book, and reader ratings. Users should be able to browse books, search by title or author, filter by genre and year, and see average ratings. When viewing a book, they should see all its editions and reviews.

### Let AI formalize

> Please formalize this into a structured business requirements document. List all entities, their attributes, relationships, and use cases.

### Review and iterate

Read AI's proposal carefully. Things to check:
- Are all entities captured? (Did AI miss Editions? Ratings?)
- Are relationships correct? (Author has many Books, not the other way)
- Are business rules captured? (Rating is 1-5, ISBN is unique, etc.)
- Are use cases complete? (Create, search, filter, browse — what about edit? delete?)

If something is missing or wrong:

> Add a requirement: users should be able to edit and delete books. Also, the author name should be visible in the book list, not just a reference ID. And ratings should display as stars (1-5).

Repeat until you're satisfied. Then:

> The business requirements look complete. Save them to the `book-catalog` collection as `business-requirements`.

The agent calls `rag_add` and shows a `RAG OP: rag_add OK` card with id `business-requirements`. If it does not, ask explicitly: *"Use rag_add — collection `book-catalog`, id `business-requirements`."* From now on, later phases pull this artifact from RAG; you do not need to copy or re-paste it.

> Let's move to the technical specification.

---

## Phase 2: Technical Specification (Draft)

**Your role:** architect. **AI's role:** technical writer.
**Goal:** Transform business requirements into a **draft** technical specification — ABAP object types, field definitions, relationships, UI annotations.
**Output:** A markdown document, saved to RAG as `tech-spec`. The agent retrieves `business-requirements` from RAG to base the spec on.

> **This is a draft, not a final document.** During Phase 4 (implementation) you will find issues — wrong field types, missing keys, wrong mappings. That is expected. You will refine the specification while you build. But **the better the draft now, the fewer fixes later** — so spend time here. A careful draft with correct field types, keys, and mappings saves a lot of time during implementation.

### Set the technology and constraints

> Based on the business requirements, create a technical specification for SAP RAP implementation:
>
> Technology: SAP RAP managed BO with draft support, Fiori Elements UI, OData V4
> Mode: strict ( 2 )
> Naming: use prefix Z##_ for all objects, package TEST_##_BOOK
>
> Constraints:
> - Use explicit field mapping in BDEF (not corresponding)
> - Use custom domains and data elements for proper field labels
> - Author is a separate BO (association, not composition from Book)
> - Book owns Editions and Ratings (composition)
> - UI must show author name instead of UUID (text association)
> - Search on Title, Author Name, ISBN; filters on Genre, Year, Language
> - Star rating display for Score field

### Review the specification

The output must cover all ABAP layers — domains, data elements, persistent tables, draft tables, interface CDS, projection CDS, metadata extensions, BDEF, BIMP, service definition + binding — with field types/lengths, entity relationships, and UI annotations.

Walk the spec section by section against this checklist. If a row fails, ask the agent to fix that section, then re-check.

| Area | What to verify | Common AI mistake |
|---|---|---|
| Draft table keys | All keys from the persistent table are also keys here | Only `mandt + uuid` |
| BDEF mapping | Explicit `{ CdsAlias = table_field; }` per field | `corresponding` shortcut, mapping warnings |
| Draft actions | All 5 present: Edit, Resume, Activate, Discard, Prepare | One missing (often Discard) |
| Authorization | `master` on root, `dependent` on children | Both `master`, or both `dependent` |
| BIMP class | Local handler implements `get_instance_authorizations` | Plain empty class |
| Composition / association | Book composes Edition/Rating; Book → Author is association | Author composed from Book |

Example fix prompt:

> The draft tables only have mandt + uuid as keys — add matnr to match the persistent tables. Also add draft action Discard.

When the spec passes the checklist:

> The specification is ready. Save it as `tech-spec` in the `book-catalog` collection.

The agent calls `rag_add`. If it does not, prompt explicitly: *"Use rag_add — collection `book-catalog`, id `tech-spec`."*

> **Spec is a living document.** Phase 4 may surface issues SAP only catches when checking the real DDL. The agent will then call `rag_correct` on `tech-spec` — see the skill for that flow.

> Let's create an implementation plan.

---

## Phase 3: Implementation Plan

**Your role:** project manager. **AI's role:** lead developer.
**Goal:** An ordered, step-by-step plan with checkpoints between layers.
**Output:** A numbered markdown plan, saved to RAG as `impl-plan`. The agent retrieves `tech-spec` to drive each step.

### Ask for the plan

> Create a step-by-step implementation plan for the Book Catalog. Include:
> - Creation order respecting dependencies
> - Group activation points
> - Checkpoints between layers (verify all objects active before next layer)
> - For complex objects (CDS views, BDEF) — note that interactive create-check-fix cycle is needed

### Review the plan

The plan should follow the dependency order:
1. Package
2. Domains → Data Elements
3. Persistent Tables → Draft Tables
4. Interface CDS Views (create all, check, activate together)
5. Projection CDS Views (create all, check, activate together)
6. Metadata Extensions
7. Interface BDEF + BIMP (create, check iteratively, activate together)
8. Projection BDEF
9. Service Definition → Service Binding → Publish

Check that:
- Each step says WHAT to create and HOW to verify
- Complex steps (CDS, BDEF) have the check-fix loop noted
- Checkpoints exist between every layer
- Prefix filter is used for activation ("starting with Z##_")

> Add a checkpoint after domains to verify they're all active before creating data elements. Also note that CDS views have circular dependencies and need to be created without activation first, then activated together.

Repeat until the plan is solid. Then:

> The plan looks good. Save it as `impl-plan` in the `book-catalog` collection.

The agent calls `rag_add`. If it does not, prompt explicitly: *"Use rag_add — collection `book-catalog`, id `impl-plan`."*

> Let's start implementation.

---

## Phase 4: Step-by-Step Implementation

**Your role:** reviewer and tester. **AI's role:** developer.
**Goal:** Execute the plan, one step at a time, with verification. Use the draft specification from Phase 2 as input for each step — DDL, field definitions, mappings come from there.
**Output:** Real ABAP objects active in the SAP system. When the spec needs to change, the agent calls `rag_correct` on `tech-spec`; you do not retype anything.

> **The specification keeps changing.** When SAP rejects something during implementation (wrong key, missing mapping, wrong type), fix the specification first, then the code. This keeps the spec and the system in sync. By the end, your draft will have grown into an accurate final specification.

### Detecting fake responses

AI can pretend that a step succeeded without running any tool. Watch for these warning signs:

- **Low token count** — a real tool call uses 40,000–100,000+ prompt tokens. If the response shows about 4,000 prompt tokens, the AI probably answered from memory and did not call a tool.
- **No `[SmartAgent: Executing ...]` lines** — every real tool call shows this trace. No trace means no tool ran.
- **Reply is too fast** — creating 6 objects needs 30–60 seconds of tool calls, not instant.

This usually happens after long conversations (12+ messages). The AI copies the format of earlier replies and skips the tool call.

**How to avoid it:**
- Start a fresh session often (after each layer, or every 10 messages)
- After creating N objects, read each one back in a new session
- If the token count is low, treat the reply as fake and redo the step

> **You do not retype DDL, field types, or object names in Phase 4.** All of that is in the plan and the specification, which the agent already has in RAG. Your prompts only point to the plan step. The agent reads the plan, takes the object list and the spec for that step, and runs the tools.

### Simple objects: create and verify

For domains, data elements, and tables — one step at a time:

> Run plan step 2.

After creation:

> Verify all objects from step 2 are active.

### Complex objects: create-check-fix loop

For CDS views and BDEF — **never assume the first attempt works:**

> Run plan step 4. Do NOT activate yet.

After creating all views in the group:

> Check the views from step 4 for syntax errors.

If errors found, describe the error in plain words — the agent fixes it using the spec:

> The check shows "association target not found" for _Author. Fix it based on the spec.

Repeat check-fix until clean, then:

> Activate the views from step 4 together.

### BDEF: expect several rounds

BDEF usually needs more than one round:

> Run plan step 7. Do NOT activate.

> Check the BDEF from step 7 for syntax errors.

Common issues at this stage:
- Missing mapping fields → add to explicit mapping
- Authorization errors → verify master/dependent declarations
- Draft table mismatch → check key fields match persistent
- Missing draft action → add Discard, Prepare, etc.

Fix each error, re-check, repeat until clean. Then create BIMP and activate together.

### Checkpoints between layers

After each layer, verify:

> List all objects starting with Z##_ and check for inactive ones.

If inactive objects found:

> Activate all inactive objects starting with Z##_.

Only proceed to the next layer when everything is active.

### Final verification

After service binding is published:

> Confirm the service binding from the last plan step is published.

Then test in ADT preview:
1. Create an Author
2. Create a Book referencing that Author
3. Verify Author Name shows in Book list (not UUID)
4. Add an Edition and a Rating
5. Test search by title, filter by genre
6. Verify star rating display

---

## What You Learned

After this tutorial you know how to:

1. **Turn** business ideas into structured requirements with AI
2. **Review** AI-generated technical specifications and catch common mistakes
3. **Plan** implementation in the correct ABAP dependency order
4. **Build** step by step — create, check, fix, activate
5. **Handle** complex objects (CDS circular dependencies, BDEF strict mode)
6. **Verify** at every step instead of trusting AI output blindly

The key idea: **AI speeds up development but does not replace your judgement.** Every decision — from entity design to field mapping — is yours. AI is the fastest pair programmer you can get, but only if you lead.
