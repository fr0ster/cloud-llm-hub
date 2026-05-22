# Why Cloud LLM Hub is not just an ABAP MCP server

A plain MCP server exposes tools. Cloud LLM Hub exposes an agent whose job is
**intelligent context management** — deciding what the model actually sees for the
current turn, instead of stuffing the prompt with everything. RAG and semantic search
are the engine that makes this possible.

## The differentiator: context management

1. **Semantic tool selection.** Cloud LLM Hub holds ~149 ABAP MCP tools. Dumping all of
   them into the model prompt is noisy, expensive, and degrades reasoning. The Hub
   embeds tool definitions, semantically searches them against the current turn, and
   injects only the relevant subset.
2. **RAG with semantic retrieval.** Project standards, design notes, naming conventions,
   prior reviews, reusable prompts, support findings — all live in per-project RAG
   collections. For each turn, the Hub retrieves top-k records by embedding similarity.
3. **Role-based pre-filtering.** Before semantic selection, tools outside the caller's
   role (Reader / Analyst / Developer / Full) are removed. The model literally cannot
   propose a tool the caller is not entitled to use.

That whole pipeline is what makes the platform an AI agent rather than a wrapper around
`mcp-abap-adt`.

## vs. VSCode + ABAP MCP Server

VSCode + MCP gives one developer a local IDE that can call ABAP tools. There is no
shared knowledge layer, no semantic tool selection, no semantic record retrieval, no
role-based filtering — the IDE either floods the model with the whole tool list or
relies on the model picking blindly. Project context lives in the developer's head or
in pasted snippets; the next developer starts from zero.

Cloud LLM Hub centralises context management:

- RAG collections accumulate team knowledge instead of evaporating between sessions.
- Tool selection is semantic, not "send everything".
- Role tiers enforce authorisation at the tool inventory level.
- One service serves many SAP systems, many client types, many consuming services —
  with the same context pipeline.

## Short answer

An MCP server gives you ABAP tools. VSCode + MCP gives one developer those tools in an
IDE. Cloud LLM Hub gives you **intelligent context management** — semantic tool
selection, RAG retrieval, role-based filtering — on top of those tools, available to
the whole organisation through any AI client.
