# Release readiness: models per role, token efficiency, docs MCP

Status: design, 2026-11-02. Everything here must close before the current release (minimum for assistants with
long-term memory and learning). Terminology: **assistant** (memory and learning, future), **agent** (planner,
executor, checker, analyst) described by a **profile**, **pipeline**.

## Why

A four-phase documentation task on POC (doc-task → analysis-plan → evidence → tech-spec, ~8.25M input tokens,
307 LLM calls, 0 cached) showed:

- The request `model` (WebUI **LLM** select) switches the process-wide main model (`srv/openai-handler.ts`
  `requestedModel` → `getSmartAgent` → `sharedMainLlm` / `currentModel`). With Opus selected, executor, checker and
  analyst ran on Opus for every user; only the reviewer stayed on Sonnet. Usage records the real model, so the
  attribution is correct.
- `rag_read` pages records 8000 characters at a time; long process documents are read in 10–15 calls, and every
  page stays in the transcript. The coordinator reads documents itself (61 `rag_read`, 18 `rag_search` in one
  window), so whole documents land in Opus context. Delegated tasks start from the brief and read the same records
  again.
- The tool loop keeps the full transcript (`LegacyAccumulateContextStrategy`, the library default; the hub sets no
  strategy), so long loops grow roughly quadratically.
- The compact `: tool-result` summary drops `query`, so `rag_search` shows `{}` in the WebUI.
- When the coordinator stops to wait for a task (no final iteration), the fallback keeps tool-round progress text,
  so English pre-tool reasoning reaches the reply again.
- The library rejects skills that share a name with a different `kind`, although names are display-only.

## Goals

1. **Model per role.**
   - The request `model` (WebUI LLM select, OpenAI/Anthropic `model`) selects the coordinator model of that
     session only. It never changes the process-wide main model or other users.
   - The coordinator chooses the model of each agent it launches: optional `model` on `delegate_task` and
     `execute_step`, limited to the deploy allowlist `LLM_AGENT_WORKER_MODELS` (comma list). A model outside the
     list is a tool error `MODEL_NOT_ALLOWED`.
   - Without a choice: the profile's `model` (new optional profile front matter field, must be in the allowlist),
     else `LLM_AGENT_MODEL`.
   - Plan author: `LLM_AGENT_PLANNER_MODEL` as today. Classifier, embedder, reviewer: unchanged.
   - Coordinator prompt rule: default to the agent's default model; choose a stronger allowed model only for hard
     analysis or a failed check.
   - Usage keeps recording the real model of every call; the WebUI TOKENS line already shows models per role.
2. **No progress text on waiting stops.** When a call ends without a final iteration because the coordinator stops
   (wait, budget, stop signal), tool-round progress text is dropped from the reply; only text after the last tool
   round is kept (the library fallback and the hub paragraph wrapper). Validation-retry and provider-reset
   handling stay as released.
3. **RAG reading.**
   - `rag_read` default page: 32000 characters (still capped by the existing tool-result cap).
   - Within one tool loop, an identical repeated `rag_read` (same record, offset, limit, unchanged record version)
     returns a short pointer ("already read above in this task: <record> offset n–m") instead of the text again.
     Changed records are read normally.
   - Coordinator prompt: delegate reading and analysing documents to an agent; the coordinator reads records itself
     only to answer short lookups.
4. **Context strategy for long loops.** The hub configures `WindowContextStrategy` (library) for agent tool loops:
   the last N rounds verbatim (default 8, `LLM_AGENT_TOOL_LOOP_WINDOW`) plus the prefix; older rounds are dropped
   from the model context but stay in traces. The coordinator keeps the dialogue's own history handling.
5. **`query` in the compact tool result.** The `: tool-result` summary keeps `query` (first 200 characters) for
   `rag_search`; it is model text, not collection content.
6. **Skill kinds in the library.** Skill discovery stops rejecting one name with different `kind`s; skills are
   keyed by id where ids exist. Released as a llm-agent patch; the hub already loads its own skills by id.
7. **External MCP per role (docs search).**
   - Deploy config per role: `LLM_AGENT_PLANNER_MCP`, `LLM_AGENT_EXECUTOR_MCP`, `LLM_AGENT_CHECKER_MCP`, each a
     comma list of BTP destination names (NoAuthentication or the destination's own auth; no credentials in env).
   - Transport: Streamable HTTP through the destination, reusing `McpClientAdapter`. Built-in external MCP is
     distinct from tools a client brings in a request; client tools never become built-in.
   - Tools of these servers are offered to that role's agents (planner gets them as read-only knowledge tools
     where they are read-only), subject to profile ceilings.
   - Their results carry the `docs` trust class tag (`[source: docs:<tool>; trust n]`), with a per-destination trust
     override `LLM_AGENT_MCP_TRUST=<destination>=<n>,…`.
   - Test server: `https://mcp-abap.marianzeis.de/mcp` (ABAP docs; tools search, fetch, abap_feature_matrix, …).
     CF egress from POC must be checked first.

## Non-goals

- Prompt caching via SAP AI Core (separate investigation).
- Cross-task shared cache of document reads (assistant memory, step 4 of the roadmap).
- Global trust evaluators (backlog).

## Acceptance

- Unit tests per goal; WebUI selecting Opus leaves executor/checker on `LLM_AGENT_MODEL` and does not affect another
  session; `delegate_task` with an allowed model runs that model, with a disallowed model returns
  `MODEL_NOT_ALLOWED`; profile `model` outside the allowlist rejects the profile record.
- Waiting-stop replies contain no pre-tool text.
- Repeated identical `rag_read` returns the pointer; changed record returns text.
- POC: the four-phase documentation scenario re-run shows executor/checker on Sonnet and total input tokens at
  least halved; a docs-MCP search reaches the executor with a `docs` tag.

## Decisions after the builder check (my calls unless marked)

- **Allowlist.** One list `LLM_AGENT_MODELS` (comma list) replaces `LLM_AGENT_WORKER_MODELS`; it covers the
  coordinator choice and agent choices. `LLM_AGENT_MODEL` and `LLM_AGENT_PLANNER_MODEL` are always allowed; unset
  list = only those two.
- **Unknown request models** (e.g. Claude Code `claude-…` ids not served by AI Core) are ignored: the request runs
  on the default, the hub logs it and returns header `x-clh-model-ignored: <id>`. Never an error, never global.
- **Non-dialogue paths** (direct chat, LLM-only, per-destination agent): an allowed request model applies to that
  request only; there is no shared-model hot-swap anywhere any more.
- **Profile `model`** only on `kind: profile` (analyst, executor, checker). On write: rejected with 400 if outside
  the allowlist. At load: a stored disallowed model is ignored with a warning (the profile still loads).
  `execute_step` uses the `executor` profile's model as its default; a `model` argument applies to that call only.
- **Repeat-read pointer** applies only while the earlier identical read is still inside the context window; a repeat
  read of a page that has left the window returns the full text.
- **Docs MCP for the analyst:** `LLM_AGENT_ANALYST_MCP` as well. Tools of external docs MCP destinations count as
  read-only knowledge tools (they are declared docs-search servers); write-capable external MCP is out of scope.
- **llm-agent:** one minor release (delegate_task `model`, waiting-stop fallback, window strategy wiring, skill-kind
  patch) before the hub release.
