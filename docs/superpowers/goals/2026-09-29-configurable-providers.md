# Goal: configurable providers and a local run

<!-- docs-check:proposed-env — this goal names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

> **Owned by the user.** This document changes only when the user explicitly
> says so or agrees to a proposed change. The spec, the plans and the code
> follow it; they never edit it.

## The task

The hub already takes its LLM provider from configuration. The embedder, the
RAG backends and the source of SAP destinations are hard-wired: in-memory
stores, an embedder derived from the LLM, destinations from BTP only. A local
run cannot give the agent SAP tools without BTP.

## Goals

1. Choose the LLM, the embedder, the RAG backend and the destination source in
   configuration, the same way the LLM provider is chosen today.
2. Run the full agent locally against a real SAP system, without BTP.
3. Run the local setup on Ollama and Qdrant.
4. Keep every existing deployment working unchanged when none of the new
   settings is used.

## Decisions

| Date | Decision |
|---|---|
| 2026-09-29 | Providers (LLM, embedder, RAG backend, destination source) are chosen in configuration, in environment variables, like `LLM_AGENT_PROVIDER`. |
| 2026-09-29 | A local run is the full agent against a real SAP system, without BTP, through destinations from the environment and the production connection class. |
| 2026-09-29 | The local default is Ollama for the LLM and the embeddings, and the local run uses Qdrant. |
| 2026-09-29 | Keyword search was a crutch. Persistent backends (Qdrant, HANA Vector) are vector-only. |
| 2026-09-29 | One mechanism for every store; the backend is chosen per store class. Tools and session stores default to in-memory for speed; tools may move to Qdrant if it is fast enough. |
| 2026-09-29 | RAG is wired once at startup from the deploy configuration; changes come with a redeploy. No hot switching, no runtime plugin loading. Not to be designed until the user asks. |
| 2026-09-29 | Collections are typically filled once and then read. This is the intended use, not an API restriction. |
| 2026-09-29 | Concurrency belongs to the backend server. The hub adds no writer election, incarnation checks or locks. In-memory writes are exclusive (MCP init) or already locked. |
| 2026-09-29 | Conflicting writes to one document: the last write wins. |
| 2026-09-29 | The MCP tool corpus does not change after the build. Its vectors are built at build/deploy time, and startup only loads them. |
| 2026-09-29 | The tool corpus has one current state, with no generations or history. The build step replaces it in place. |
| 2026-09-29 | Gaps in our own `@mcp-abap-adt/*` packages are fixed at the source, not worked around in the hub. |
| 2026-09-29 | The spec is frozen once approved. Changes after planning starts need the user's approval. |
| 2026-09-29 | The hub needs neither the low-level nor the compact tool groups; the read-only / read-write role grouping stays. |
| 2026-09-30 | The deployment decides which embedding model is used; the hub hard-wires none. The retrieval scoring mode (`hybrid` / `cosine`), the query prefix (embedder role) and translating the query to English before the search are configuration. |
| 2026-09-30 | Tool-retrieval quality comes from the tool descriptions in `@mcp-abap-adt/lib`, not from hub settings. |
