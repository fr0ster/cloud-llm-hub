# Task: Integrate RAG in cloud-llm-hub using LangChain

## Summary
Implement a PoC RAG flow in `cloud-llm-hub` using LangChain: vectorize query, retrieve relevant context, enrich prompt, and return LLM response.

## Context
`llm-agent` is the current branch/component in use, but RAG integration should be implemented at `cloud-llm-hub` level and be extractable into `llm-agent` later.

## Scope
1. Implement minimal RAG flow with LangChain (retrieval + context enrichment + generation).
2. Vectorize user query and retrieve relevant chunks from a vector store.
3. Inject retrieved context into the LLM prompt used by chat flow.
4. Return answer enriched with retrieved context (and source metadata if available).
5. Add basic logs: retrieval latency, generation latency, retrieved chunk count.
6. Add short PoC run instructions.

## Resource Evaluation (within this task)
1. Evaluate required runtime/resources for vector storage in BTP CF.
2. Primary option: SAP HANA vector capabilities.
3. If HANA vector is not available, provide one deployable fallback option for BTP CF with short rationale.

## Required Configuration
- `EMBEDDING_MODEL_ID`
- `VECTOR_STORE_PROVIDER`
- `VECTOR_STORE_INDEX`
- `RAG_TOP_K`
- `RAG_CHUNK_SIZE`
- `RAG_CHUNK_OVERLAP`

## Acceptance Criteria
1. A test query is vectorized and used for retrieval.
2. Retrieved context is injected into LLM input in `cloud-llm-hub`.
3. Chat response is generated with RAG context (not plain LLM-only call).
4. Resource evaluation note is delivered:
   - HANA vector option
   - one BTP CF fallback option
5. Basic run/check instructions are documented.

## Pre-architecture Questions
Detailed list of mandatory questions before architecture and implementation:
- `docs/llm-proxy/RAG_PREARCH_QUESTIONS.md`
