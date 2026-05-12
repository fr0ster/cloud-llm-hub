# Book Catalog Tutorial — Implementation Analysis

## What we built

A complete SAP RAP application — Book Catalog with 4 entities (Author, Book, Edition, Rating), draft support, Fiori Elements UI annotations, and OData V4 service. 72 ABAP objects in total.

## How we did it

I described the application idea in plain language: "a book catalog with authors, books, editions, and ratings." Then, working with the AI through cloud-llm-hub chat interface, we went through 4 phases:

1. **Business Requirements** — AI formalized my idea into structured requirements with entities, attributes, relationships, and use cases. 3 iterations to refine.
2. **Technical Specification** — AI translated requirements into ABAP objects: domains, data elements, tables, CDS views, BDEFs, services. I reviewed and corrected field types, key structures, and mappings.
3. **Implementation Plan** — AI created an 80-step ordered plan respecting ABAP object dependencies. I validated the layer structure and checkpoint strategy.
4. **Implementation** — AI executed the plan step by step, creating each object via MCP tools. I verified results and fixed issues as they appeared.

Phases 1-3 produced documents (markdown files). Phase 4 produced 72 live ABAP objects on the SAP system.

## Numbers

| Metric | Value |
|--------|-------|
| ABAP objects created | 72 |
| API prompts (Phase 4) | 77 |
| Total input tokens | ~6.1M |
| Total output tokens | ~62K |
| Estimated API cost | ~$19 |
| Wasted tokens | ~1.1M (18%) |
| Wasted cost | ~$3.50 |

## What went wrong and why

### 1. Draft table structure — 11% waste (~670K tokens)

The biggest problem. Draft tables required 3 iterations:

- **v1:** Created with snake_case field names (matching persistent tables) and `draftuuid` as a key field. This is how the AI generated them from the technical specification.
- **v2:** Renamed all fields to CamelCase (matching CDS view aliases). BDEF activation requires draft tables to use CDS alias names, not persistent table field names.
- **v3:** Removed `draftuuid` from key fields. The draft framework manages this field via the `sych_bdl_draft_admin_inc` include — defining it as a user key conflicts with the framework.

**Root cause:** The technical specification (Phase 2) described draft tables with the same field names as persistent tables. The AI followed the spec. The spec was wrong because I didn't know the draft table naming rules when I approved it.

**Prevention:** The skill file now documents these rules explicitly. With correct skill rules, draft tables should be created correctly on the first attempt, saving ~$2 and 8 prompts.

### 2. LLM hallucinations — 5% waste (~310K tokens)

The AI fabricated successful responses without actually calling MCP tools. This happened in two scenarios:

- **Long sessions (10+ messages):** After accumulating conversation history, the AI "pattern-matched" earlier successful responses instead of executing tools. It would report "all domains created successfully" with correct-looking tables — but no objects were actually created.
- **Large batches (5+ objects):** When asked to create 6 domains in one prompt, the AI created the first 2-3 and then fabricated results for the rest.

**Detection:** Real tool calls use 40-100K+ prompt tokens (the MCP server context is large). Hallucinated responses use ~4K tokens. If the response has less than 10K prompt tokens, it's fake.

**Prevention:** Start a fresh session for each layer. Create maximum 3-4 objects per prompt. Always verify by reading objects back in a new session.

### 3. Service binding type — minor waste (~210K tokens)

The MCP tool `CreateServiceBinding` always creates OData V4 Web API (category 1) instead of OData V4 UI (category 0). We tried twice to get the right type — both times failed. This is an ADT API limitation, not a prompting issue.

**Resolution:** Created issues in upstream repos. For now, the binding type must be changed manually in ADT after creation.

## What the skill file prevents

Before Phase 4 testing, the skill file (v1.0.0) had basic rules from previous tutorial testing. After Phase 4, it was updated to v2.0.0 with:

- Exact draft table naming rules (CamelCase fields, no draftuuid key, include syntax)
- Hallucination detection indicators and batch size limits
- BDEF activation approach (individual ActivateBehaviorDefinition, not group ActivateObjects)
- Service binding limitation documentation
- Token budget estimates per object type
- Common error messages with fixes

With v2.0.0 skill rules applied from the start, the estimated optimal cost would be ~$15.77 instead of $19.24 — saving ~18%.

## Comparison: AI vs manual development

| | AI-assisted | Manual (estimate) |
|---|---|---|
| Time | ~3 hours (4 phases) | ~2 weeks (80 hours) |
| Cost | ~$19 API | ~$2,000 salary |
| Iterations | 77 prompts, 18% waste | Unknown rework cycles |
| Result | 72 objects, all active | Same |

The AI approach is ~100x cheaper and ~25x faster, even with 18% waste. The key enabler is the skill file — it encodes lessons learned so future implementations avoid the same mistakes.
