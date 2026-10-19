# Backlog — Planned Improvements

## RAG Pipeline

- [ ] **Query expansion for custom collections** — LLM expands user query with synonyms/aliases before RAG search (e.g., "Чапаєв" → "Чапаєв Василій Іванович"). Trade-off: +2-5s per request. Consider async/cached expansion.
- [ ] **Custom IPipeline implementation** — HIGH PRIORITY. Replace workarounds in openai-handler with proper `IPipeline` from llm-agent 6.0. Currently our "pipeline" is scattered across openai-handler as hacks (pre-query, save/restore ragStores, inject into user message, translate conditionally). A proper IPipeline would:
  - Own the full request lifecycle (classify → translate → RAG query → assemble → tool-loop)
  - Search custom user RAG collections natively (not pre-query workaround)
  - Translate only for tools RAG, search user collections in original language
  - Skip classifier for tool selection (always search tools with translation)
  - Or: make classifier optional, default everything to "action"
  - Remove dependency on `shouldRetrieve` gating in hardcoded flow
- [ ] **ragRetrievalMode: always** — request in llm-agent to restore option for forced RAG retrieval regardless of classifier output. Alternative: custom IPipeline makes this unnecessary.
- [ ] **Embedder token tracking** — llm-agent embedders discard usage from embedding API response. Track and include in requestLogger summary alongside LLM tokens.
- [ ] **Orphan listing in llm-agent (upstream request)** — persistent collections log nothing for stores or rows that have no catalog record: the library offers no listing for them and the hub must not issue SQL. Ask `@mcp-abap-adt/llm-agent` for a way to list them, then log them at restore.

## Session / History

- [ ] **History recall on the vector path returns nothing (main-repo fix)** — the pipeline filters by namespace, turns carry none. The chat's `ragFilter` has `namespace: ${userId}:${destination}` (plus `exposition`, and the `history` stage adds `sessionId`); every store drops a record whose `metadata.namespace` differs, and `vector`-path turns carry only `owner` (no namespace, no sessionId). The persistent path is fixed (`SessionHistoryRag.query` filters by the owner's `userId`/`sessionId`); on `vector` the same replacement, or no `ragFilter` relying on `mine()`, changes behaviour with persistence off, so it ships separately with a CHANGELOG "Fixed" line.
- [ ] **Session-scoped RAG cleanup on CLR** — `IRag.clear()` for session history store when user clicks CLR.
- [ ] **Explicit "remember" command** — user says "запам'ятай це" → save to user-scoped facts store. Not auto-upsert from classifier.

## UI

- [ ] **Model selector from UI** — change LLM model without redeployment.
- [ ] **Document editing** — edit existing RAG document text in MANAGE panel (API exists, UI missing).

## Deployment

- [ ] **Auto-discover destinations** — map system codes from BTP Destination service properties instead of manual DESTINATION_MAPPING.
