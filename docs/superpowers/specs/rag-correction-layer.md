# RAG Correction Layer

Status: draft
Created: 2026-04-21

## Problem

Cloud LLM Hub runs on SAP BTP where the only persistent memory available to the agent is the RAG vector store — no local filesystem, no git workspace. During tutorial-style multi-step runs (e.g. Book Catalog RAP BO), every step's output is indexed into RAG so that subsequent steps can retrieve prior context.

Observed failure mode from Phase 4 execution logs (`~/prj/RAP Book documents/Phase 4/hallucinations/`):

- Failed attempts, transient errors (lock conflicts, syntax errors on inactive objects), and deprecated approaches are indexed with the same weight as verified successes.
- When a human corrects the LLM ("use package `$TEST_JK01_BOOK`, not `ZDEMO2_BOOK_CATALOG`"), the correction stays only in chat history. It does not propagate into RAG, so the next retrieval pulls the old wrong pattern.
- Multiple spec versions and fragmented instructions coexist; the retriever returns the first relevant match, which may be stale.
- No checkpoint marker distinguishes "step completed and verified" from "step attempted and abandoned".

Result: the LLM re-learns the same mistakes each retrieval, and human corrections have no durable channel.

## Constraints

- Cloud-only: all state lives in RAG. No filesystem, no git available to the agent at runtime.
- Must work uniformly for UI-driven chat (human in the loop) and agent-driven execution (no human between steps).
- Existing stack: `@mcp-abap-adt/llm-agent` VectorRag, `DefaultPipeline`, MCP transport.

## Design

### 1. RAG namespaces

Three logical namespaces, each a separate collection or tag prefix in the vector store:

- `knowledge/` — curated, stable knowledge: specs, skills, best practices, support cases. Slow-changing, human-curated.
- `execution/{session_id}/` — per-session execution trace. Only verified steps land here.
- `corrections/` — corrections from human or agent. Higher retrieval weight than `knowledge/` when queries overlap.

### 2. Indexing gates

Not every tool call result is indexed. A result reaches `execution/{session_id}/` only when:

- The underlying SAP operation returned success (e.g. `ActivateObject` status ok, `CreateClass` returned active object).
- No transient error present (lock, transport busy, network, syntax error on inactive object) — these are filtered out entirely.

Failed attempts are logged to the session transcript but not indexed. A semantic lesson derived from a failure may be added to `corrections/` explicitly (see below).

### 3. MCP tools

Four tools, same API surface for agent and UI:

- `rag.add(namespace, content, tags, source_ref) -> id`
  - `namespace`: one of `knowledge`, `execution/{session_id}`, `corrections`.
  - `tags`: `['verified']`, `['deprecated']`, `['correct']`, etc.
  - `source_ref`: free-text reference to origin (tool call id, user message, prior rag id).
- `rag.deprecate(id, reason) -> void`
  - Adds `[deprecated]` tag and reason. Entry remains for postmortem, excluded from retrieval by default.
- `rag.correct(old_id, new_content, reason) -> new_id`
  - Marks `old_id` as `[superseded]`, creates new entry in `corrections/` referencing old via `source_ref`.
- `rag.search(query, namespace?, include_deprecated=false) -> results`
  - Base retrieve with namespace filter and deprecation filter on by default.

Scope rules:
- Agent may `deprecate` / `correct` only entries it created within the same `session_id`.
- Human (via UI) may operate on any entry.

### 4. Retrieval ordering

On `rag.search`:
1. Filter out `[deprecated]` and `[superseded]` unless explicitly requested.
2. Rank: `corrections/` > `knowledge/` > `execution/{current_session}/` > `execution/{other_sessions}/`.
3. Return top-K with namespace and tags visible to the agent prompt so it can reason about source.

### 5. UI surface

Each assistant message in the chat UI gets three buttons:
- `✓ Verified` → `rag.add('execution/{session}', message, tags=['verified'])`.
- `✗ Wrong` → opens small modal for reason, then `rag.deprecate(last_indexed_id, reason)`.
- `Edit` → opens editor with original content, then `rag.correct(last_indexed_id, new_content, reason)`.

Buttons invoke the same MCP tools an agent would call — no duplicate codepath.

### 6. Auto-verification

Where the SAP system itself can confirm success, no human click is required:

| Tool | Success signal | Action |
|---|---|---|
| `ActivateObject` | status `ok` | `rag.add('execution/..', summary, tags=['verified'])` |
| `CreateClass` / `CreateTable` / `CreateCDS` | object readable via `Get*` | `rag.add(..., ['verified'])` |
| `CheckObject` | no errors | `rag.add(..., ['verified'])` |
| Any tool returning transient error | — | do not index |

### 7. Session lifecycle

- `session_id` comes from chat session or agent run id.
- Namespace `execution/{session_id}` is retained until TTL (default: 30 days) or explicit delete.
- On session end, a summary entry may be promoted from `execution/` to `knowledge/` by a human ("this tutorial prog worked, keep its lessons").

## Open questions

- Embedding store backend: VectorRag currently uses a single collection — do we need one collection per namespace, or metadata-filtered retrieval in one collection? Depends on provider (SAP AI Core Vector Engine vs external).
- `corrections/` weighting: should it override `knowledge/` always, or only when tagged against same `source_ref`?
- Who bootstraps `knowledge/` on deploy: MTA build step? Manual admin upload?
- Rate-limit on `rag.add` from agent to prevent runaway indexing.

## Out of scope (for this spec)

- Migrating existing non-namespaced RAG content.
- Multi-tenant isolation beyond what XSUAA already provides.
- RAG analytics / admin UI (separate concern).
