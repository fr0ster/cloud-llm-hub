# Backlog — Planned Improvements

## RAG Pipeline

- [ ] **Query expansion for custom collections** — LLM expands user query with synonyms/aliases before RAG search (e.g., "Чапаєв" → "Чапаєв Василій Іванович"). Trade-off: +2-5s per request. Consider async/cached expansion.
- [ ] **Persistent vector store** — Qdrant or HANA Cloud Vector Engine for collections that survive restarts. Currently in-memory only.
- [ ] **Custom IPipeline implementation** — HIGH PRIORITY. Replace workarounds in openai-handler with proper `IPipeline` from llm-agent 6.0. Currently our "pipeline" is scattered across openai-handler as hacks (pre-query, save/restore ragStores, inject into user message, translate conditionally). A proper IPipeline would:
  - Own the full request lifecycle (classify → translate → RAG query → assemble → tool-loop)
  - Search custom user RAG collections natively (not pre-query workaround)
  - Translate only for tools RAG, search user collections in original language
  - Skip classifier for tool selection (always search tools with translation)
  - Or: make classifier optional, default everything to "action"
  - Remove dependency on `shouldRetrieve` gating in hardcoded flow
- [ ] **ragRetrievalMode: always** — request in llm-agent to restore option for forced RAG retrieval regardless of classifier output. Alternative: custom IPipeline makes this unnecessary.
- [ ] **Embedder token tracking** — llm-agent embedders discard usage from embedding API response. Track and include in requestLogger summary alongside LLM tokens.

## Session / History

- [ ] **Session-scoped RAG cleanup on CLR** — `IRag.clear()` for session history store when user clicks CLR.
- [ ] **Explicit "remember" command** — user says "запам'ятай це" → save to user-scoped facts store. Not auto-upsert from classifier.

## UI

- [ ] **Model selector from UI** — change LLM model without redeployment.
- [ ] **Document editing** — edit existing RAG document text in MANAGE panel (API exists, UI missing).

## Deployment

- [ ] **Persistent disk for RAG** — CF volume service or external storage for CollectionRegistry JSON persistence.
- [ ] **Auto-discover destinations** — map system codes from BTP Destination service properties instead of manual DESTINATION_MAPPING.
