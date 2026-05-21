# Skill — Code Documentation Generation

> Load this skill into a RAG collection before starting the
> `code-doc-generation` tutorial. The agent reads it to know how to behave
> across the four phases.

## Hard rules

1. **No fabrication.** Every value, table row, line of logic must be backed by an actual
   piece of code or metadata. If the source isn't in the cache, say so — never invent.
2. **Cite evidence.** Each spec section ends with at least one citation (line range,
   include name, quoted snippet, or MCP-tool call result).
3. **Customer namespace only in section 7.** Section 7 (custom program objects) lists
   only objects in the **same namespace** as the documented object. Standard SAP and
   other Z-namespaces are excluded — they belong elsewhere (sections 5/6) or nowhere.
4. **One question per prompt.** When the user asks "answer question 5", answer question 5
   only. Don't pre-answer 6, 7, 8. Overloaded prompts cause hallucination.
5. **Use the cache.** If a tool call's result is already saved (under `examples/<target>/
   .cache/…` or in a RAG artifact), reuse it. Only call MCP again when the cache is
   missing or marked stale.
6. **No final spec until phase 4.** Phases 1–3 produce documents/artifacts only.
   The full spec is assembled in phase 4. If the user asks for a "complete document" in
   phase 2 or 3, push back: *"We're still gathering evidence — phase 4 will assemble."*

## RAG contract

| Phase | Save with id    | Contains                                       |
|-------|-----------------|------------------------------------------------|
| 1     | `doc-task`      | Target object + neutralised spec template + constraints |
| 2     | `analysis-plan` | The 10 questions, with the MCP tools picked per question |
| 3     | `evidence-§N`   | One artifact per spec section: raw findings + citations  |
| 4     | `tech-spec`     | The final assembled documentation, fitted to the template |

- Use `rag_add` to save a new artifact. Use `rag_correct` to update one (do not create a
  second version under a new id).
- After each `rag_add` / `rag_correct`, return the `RAG OP: …` confirmation card.

## How to answer a question (phase 3)

1. Look up the cache first. If hit, quote from it.
2. If miss, call the smallest tool that answers the question (e.g. `ReadProgram` not
   `GetProgFullCode` if you only need the header).
3. Save the raw output to cache.
4. Extract the answer. Reference the cache file path.
5. Append the answer to the relevant `evidence-§N` artifact via `rag_correct`.

## How to handle ambiguity

- If the object name matches multiple types (e.g. PROG and FUGR exist with the same
  literal name), list all candidates and **ask the user** which to document. Do not pick.
- If a referenced object doesn't exist in the system (`SearchObject` returns nothing),
  record it under "open questions" — do not invent contents.
- If a source line could mean two things (e.g. a `CALL FUNCTION` with a dynamic name),
  state both possibilities and flag for follow-up.

## Tool budget guidance

- Reads (`ReadProgram`, `GetTable`, `GetCds`, `DescribeByList`) are cheap — use freely.
- Source-search (`SearchSource`) is expensive — pick one focused term per call. Don't
  combine two terms with `AND`-shape queries (timeout-prone).
- Avoid `GetProgFullCode` unless line-by-line transcription is required. Prefer
  `ReadProgram` + targeted `SearchSource` for sections.

## What "done" looks like

- Section 1 has every field filled (or marked `[UNKNOWN]`).
- Section 2 has at least one paragraph backed by a code/comment quotation.
- Sections 3-7 are populated tables with citations.
- Section 8 walks through the runtime flow with line references.
- Section 9 lists every gap honestly.
- No `[PLACEHOLDER]` left in the final document.
