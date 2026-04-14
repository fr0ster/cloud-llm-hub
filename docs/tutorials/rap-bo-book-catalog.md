# AI-Assisted Tutorial: Book Catalog Application

This tutorial teaches you how to build a complete SAP Fiori application through **pair programming with AI**. You bring the business idea and make all decisions. AI proposes, implements, and checks — but never decides for you.

> **Read first:** [Tutorial Design Principles](TUTORIAL_DESIGN_PRINCIPLES.md) — the methodology behind this tutorial.

**What you will build:** A Book Catalog application — authors, books, editions, reader ratings — with a polished Fiori UI.

**System:** SAP S/4HANA (on-premise) via cloud-llm-hub
**Skill:** Upload `skills/rap-bo-creation.md` to a RAG collection before starting
**Time:** 1-2 hours
**Prerequisites:** cloud-llm-hub chat UI with MCP connection to SAP

---

## Before You Start

### Load the RAP skill

1. Open MANAGE panel in cloud-llm-hub chat UI
2. Create collection "RAP Skills"
3. Upload `rap-bo-creation.md` (from SharePoint or `docs/tutorials/skills/`)
4. Enable the collection (checkbox ON)

### Choose your prefix

Format: `Z<II><NN>_` — initials (2 chars) + number (2 digits).

> Search for objects starting with ZDEMO01_ to verify my prefix is available.

If taken — increment: `ZDEMO02_`, `ZDEMO03_`, etc.

---

## Phase 1: Business Requirements

**Your role:** domain expert. **AI's role:** business analyst.

**Goal:** A clear, formal description of what the application does — in business terms, no technical details yet.

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

> The business requirements look complete. Generate a markdown file with the final business requirements document.

Save the generated file — you'll reference it in the next phases.

> Let's move to the technical specification.

---

## Phase 2: Technical Specification (Draft)

**Your role:** architect. **AI's role:** technical writer.

**Goal:** Transform business requirements into a **draft** technical specification — ABAP object types, field definitions, relationships, UI annotations.

> **This is a draft, not a final document.** During Phase 4 (implementation), you will discover issues — wrong field types, missing keys, incorrect mappings. That's expected. The specification will be refined as you build. However, **the more accurate the draft, the fewer corrections later** — so invest effort here. A well-thought-out draft with correct field types, key structures, and mappings will save significant time during implementation.

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

AI should produce something like:
- List of all ABAP objects (domains, data elements, tables, CDS views, BDEFs, services)
- Field definitions with types and lengths
- Entity relationships (composition vs association)
- Draft table structure (keys must match persistent!)
- BDEF structure (authorization, lock, draft actions, explicit mapping)
- UI annotations (search, filters, value help, text associations)

Things to check:
- **Draft table keys** — do they include ALL persistent table keys? (Common AI mistake: only mandt + uuid)
- **BDEF mapping** — is it explicit `{ CdsAlias = table_field; }` and not `corresponding`?
- **Draft actions** — all 5 present? (Edit, Resume, Activate, Discard, Prepare)
- **Authorization** — master on root, dependent on children?
- **BIMP class** — local handler with `get_instance_authorizations`?

If something is wrong:

> The draft tables should have matnr as key, not just mandt + uuid — persistent table keys must match. Also add draft action Discard — you have only 4 of 5 required draft actions.

Repeat until the specification is clean. Then:

> The draft specification looks good enough to start. Generate a markdown file with the complete technical specification — all objects, DDL definitions, field mappings, and UI annotations.

Save the generated file — this is your working document for Phase 4. You'll update it when implementation reveals issues.

> **Note:** Some errors will only surface during implementation when SAP validates the actual DDL. You'll come back and update the specification as needed. But the more thorough you are here — checking draft table keys, BDEF mappings, authorization declarations — the smoother Phase 4 will be.

> Let's create an implementation plan.

---

## Phase 3: Implementation Plan

**Your role:** project manager. **AI's role:** lead developer.

**Goal:** An ordered, step-by-step plan with checkpoints between layers.

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

> The plan looks good. Generate a markdown file with the numbered implementation plan — each step with what to create, DDL source where applicable, how to verify, and how to activate.

Save the plan file — you'll follow it step by step in Phase 4.

> Let's start implementation.

---

## Phase 4: Step-by-Step Implementation

**Your role:** reviewer and tester. **AI's role:** developer.

**Goal:** Execute the plan, one step at a time, with verification. Use the draft specification from Phase 2 as input for each step — DDL, field definitions, mappings come from there.

> **The specification is a living document.** When SAP rejects something during implementation (wrong key, missing mapping, incorrect type), fix it in the specification first, then in the code. This keeps the spec and reality in sync. By the end, your draft specification will have evolved into an accurate final specification.

### Detecting hallucinated responses

AI can fabricate successful results without actually executing tools. Watch for these red flags:

- **Low token count** — a real tool call uses 40,000–100,000+ prompt tokens. If the response shows ~4,000 prompt tokens, the AI likely answered from memory without calling any tool.
- **Missing `[SmartAgent: Executing ...]` lines** — every real tool call produces an execution trace. No trace = no execution.
- **Suspiciously fast response** — creating 6 objects should take 30–60 seconds of tool calls, not instant.

This tends to happen when the conversation grows long (12+ messages). The AI "remembers" the pattern from earlier responses and reproduces it without acting.

**Mitigation:**
- Start a fresh session periodically (after each layer or every ~10 messages)
- Always verify batch operations: after creating N objects, read each one back in a new session
- If token count is low, assume the response is fake and redo the step

### Simple objects: create and verify

For domains, data elements, tables — straightforward:

> Create domain Z##_D_TITLE in package TEST_##_BOOK with description 'Book Title', type CHAR length 200. Activate.

After creation:

> Read domain Z##_D_TITLE to verify it's correct and active.

### Complex objects: create-check-fix loop

For CDS views and BDEF — **never assume first attempt works:**

> Create interface CDS view Z##_R_BOOK with this DDL: [paste DDL from specification]
> Do NOT activate yet.

After creating all views in the group:

> Check CDS view Z##_R_BOOK for syntax errors.

If errors found:

> The check shows "association target not found" for _Author. Fix the association on-condition and update the view.

Repeat check-fix until clean, then:

> Activate all interface CDS views starting with Z##_R_ together.

### BDEF: the most iterative step

BDEF typically requires multiple rounds:

> Create behavior definition for Z##_R_BOOK with this source: [paste full BDEF from specification]
> Do NOT activate.

> Check behavior definition Z##_R_BOOK for syntax errors.

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

> Read the service binding Z##_BOOK and confirm it's published.

Then test in ADT preview:
1. Create an Author
2. Create a Book referencing that Author
3. Verify Author Name shows in Book list (not UUID)
4. Add an Edition and a Rating
5. Test search by title, filter by genre
6. Verify star rating display

---

## What You Learned

After completing this tutorial, you know how to:

1. **Formalize** business ideas into structured requirements with AI
2. **Review** AI-generated technical specifications and catch common mistakes
3. **Plan** implementation respecting ABAP object dependencies
4. **Execute** iteratively — create, check, fix, activate
5. **Handle** complex objects (CDS circular dependencies, BDEF strict mode)
6. **Verify** at every step instead of trusting AI output blindly

The key insight: **AI accelerates development but doesn't replace your judgment.** Every decision — from entity design to field mapping — is yours. AI is the fastest pair programmer you'll ever have, but only if you lead.
