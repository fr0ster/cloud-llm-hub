# Video Prompts — Simplest RAP BO (single-entity Book)

Four short prompts for filming the AI-pair-programming flow on the **simplest**
RAP BO: one root entity, no compositions, no associations. Follows the tutorial
pipeline `idea → business-requirements → tech-spec → impl-plan → active objects`
and the method in [`AI_PAIR_PROGRAMMING_PRINCIPLES.md`](../AI_PAIR_PROGRAMMING_PRINCIPLES.md).

One goal per prompt · Phases 1–3 produce documents only · Phase 4 is layer-by-layer with review between.

## Before recording (environment, not a prompt)
- cloud-llm-hub chat with MCP connection to SAP.
- **RAP Skills** collection enabled (`skills/*.md`).
- Working collection **`simple-book-bo`** created and enabled.
- `AI_PAIR_PROGRAMMING_PRINCIPLES.md` available to the agent (in RAG).
- Object prefix `ZDEMO01_`, package `TEST_RAG_APP` (sub-package under `$TMP`; adjust to your system).

---

## Prompt 1 — Phase 1: Formalize
```
Read AI_PAIR_PROGRAMMING_PRINCIPLES.md and follow it; we're at Phase 1 (documents only). Formalize this into a business-requirements doc and, after my review, save it as `business-requirements` in `simple-book-bo`: a single flat list of books — each with title, author name (plain text, not a separate entity), genre, publication year, price — full CRUD + draft, search by title/author, filter by genre/year, no sub-entities or related objects.
```
✔ Before next: `rag_add OK`, id `business-requirements`.

## Prompt 2 — Phase 2: Technical Specification
```
Phase 2, documents only: from `business-requirements` in `simple-book-bo`, draft and save a `tech-spec` for a single-entity RAP managed BO with draft (Fiori Elements, OData V4, strict 2, prefix ZDEMO01_, package TEST_RAG_APP, custom domains/data elements, explicit BDEF mapping, all 5 draft actions, search Title/Author, filter Genre/Year) covering every ABAP layer.
```
✔ Before next: `rag_add OK`, id `tech-spec`; draft-table keys match, explicit BDEF mapping, 5 draft actions.

## Prompt 3 — Phase 3: Implementation Plan
```
Phase 3, documents only: from `tech-spec` in `simple-book-bo`, produce and save a numbered dependency-ordered `impl-plan` (package→domains→data elements→persistent table→draft table→interface CDS→projection CDS→metadata extension→interface BDEF+BIMP→projection BDEF→service definition→binding→publish) with a per-layer "verify active" checkpoint and a create-check-fix note for CDS/BDEF.
```
✔ Before next: `rag_add OK`, id `impl-plan`; every step has a verification.

## Prompt 4 — Phase 4: Implementation (kickoff)
```
Phase 4 (system tools allowed, package TEST_RAG_APP / prefix ZDEMO01_): implement `impl-plan` using `tech-spec` from `simple-book-bo` layer by layer (max 3–4 objects), do step 1 now and stop after each layer for my review, read every object back to prove active:true, create CDS/BDEF without activating then check-fix-activate, and stop for me to fix manually if you loop twice.
```
✔ Continue Phase 4 with short follow-ups: `Run plan step N` → `Verify all ZDEMO01_ objects from step N are active` → for CDS/BDEF `Check step N for syntax errors` → `Activate step N together`. After publish: test in Fiori preview (create / edit / delete / search / filter).
