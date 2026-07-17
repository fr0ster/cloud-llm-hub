# Video Prompts — Simplest RAP BO (single-entity Book)

Four short prompts for filming the AI-pair-programming flow on the **simplest**
RAP BO: one root entity, no compositions, no associations. Follows the tutorial
pipeline `idea → business-requirements → tech-spec → impl-plan → active objects`
and the method in [`AI_PAIR_PROGRAMMING_PRINCIPLES.md`](../AI_PAIR_PROGRAMMING_PRINCIPLES.md).

One goal per prompt · Phases 1–3 produce documents only · Phase 4 is layer-by-layer with review between.

## Before recording (environment, not a prompt)
- cloud-llm-hub chat with MCP connection to SAP.
- `sap-abap` plugin installed from the `sap-skills` marketplace (every prompt below invokes
  `sap-abap:sap-abap` explicitly — the marketplace ships ~33 similar SAP plugins).
- **RAP Skills** collection enabled (`skills/*.md`).
- Somewhere for the agent to keep the phase documents so later phases can read them back — the conversation itself, a RAG collection, files: the agent's choice.
- `AI_PAIR_PROGRAMMING_PRINCIPLES.md` available to the agent.
- Object prefix `ZDEMO01_`, package `TEST_RAG_APP` (sub-package under `$TMP`; adjust to your system).

---

## Prompt 1 — Phase 1: Formalize
```
Use the `sap-abap` skill from the `sap-skills` marketplace (`sap-abap:sap-abap`) — that exact one, not `sap-abap-cds` or any other SAP skill. Read AI_PAIR_PROGRAMMING_PRINCIPLES.md and follow it; we're at Phase 1 (documents only). Formalize this into a business-requirements doc and, after my review, save it as `business-requirements` (persist it however you can read it back later): a single flat list of books — each with title, author name (plain text, not a separate entity), genre, publication year, price — full CRUD + draft, search by title/author, filter by genre/year, no sub-entities or related objects.
```
✔ Before next: `business-requirements` saved and retrievable for Phase 2.

## Prompt 2 — Phase 2: Technical Specification
```
Use the `sap-abap` skill from the `sap-skills` marketplace (`sap-abap:sap-abap`) — that exact one, not `sap-abap-cds` or any other SAP skill. Phase 2, documents only: from the `business-requirements` doc, draft and save a `tech-spec` for a single-entity RAP managed BO with draft (Fiori Elements, OData V4, strict 2, prefix ZDEMO01_, package TEST_RAG_APP, custom domains/data elements, explicit BDEF mapping, all 5 draft actions, search Title/Author, filter Genre/Year) covering every ABAP layer.
```
✔ Before next: `tech-spec` saved; draft-table keys match, explicit BDEF mapping, 5 draft actions.

## Prompt 3 — Phase 3: Implementation Plan
```
Use the `sap-abap` skill from the `sap-skills` marketplace (`sap-abap:sap-abap`) — that exact one, not `sap-abap-cds` or any other SAP skill. Phase 3, documents only: from the `tech-spec`, produce and save a numbered dependency-ordered `impl-plan` (package→domains→data elements→persistent table→draft table→interface CDS→projection CDS→metadata extension→interface BDEF+BIMP→projection BDEF→service definition→binding→publish) with a per-layer "verify active" checkpoint and a create-check-fix note for CDS/BDEF.
```
✔ Before next: `impl-plan` saved; every step has a verification.

## Prompt 4 — Phase 4: Implementation (kickoff)
```
Use the `sap-abap` skill from the `sap-skills` marketplace (`sap-abap:sap-abap`) — that exact one, not `sap-abap-cds` or any other SAP skill. Phase 4 (system tools allowed, package TEST_RAG_APP / prefix ZDEMO01_): implement `impl-plan` using `tech-spec` layer by layer (max 3–4 objects), do step 1 now and stop after each layer for my review, read every object back to prove active:true, create CDS/BDEF without activating then check-fix-activate, and stop for me to fix manually if you loop twice.
```
✔ Continue Phase 4 with short follow-ups: `Run plan step N` → `Verify all ZDEMO01_ objects from step N are active` → for CDS/BDEF `Check step N for syntax errors` → `Activate step N together`. After publish: test in Fiori preview (create / edit / delete / search / filter).
