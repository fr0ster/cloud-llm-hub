# Agent latency: one translation, one retrieval, critic on suspicion — implementation plan

**Goal:** cut the time to first content of a chat answer (measured 9.2–9.5 s for a Ukrainian question,
2.5 s for the same question in English) without losing tool-retrieval quality or the honesty guard.

**Measured on the test subaccount (2026-10-21), "What code word did I give?" in Ukrainian:**

| Stage | Time |
|---|---|
| controller: pipeline `translate` (main model, no `helperLlm`) + retrieval, result unused | 2.7 s |
| executor: pipeline `translate` again, its text then used by EVERY store | 2.0 s |
| executor: LLM answer | 1.85 s |
| after the answer: `NoticeFinalizer` → `reviewStep` LLM critic (answer already shown) | 2.4–3 s |

Tool retrieval quality (tools/measure-tool-rag.ts, `text-embedding-3-small`, 15 Ukrainian queries, K15):
untranslated reqRecall 0.885 / MRR 0.795 (misses CreateDomain, DeleteTable); translated with the
classifier model reqRecall 1.0 / MRR 0.92, ~1 s per translation. So translation stays, for tool search only.

**Decisions (owner, 2026-10-21):**
1. Translate only for tool search. History and collections are searched with the original text.
2. The controller (DAG coordinator, `FixedExecutorPlanner`) does no retrieval: nothing it retrieves is used;
   the executor gets only the task text. Passing context controller → executor is a later llm-agent change.
3. `execute_step` (agent MCP: an external agent uses the hub as its subagent) runs the executor alone, no
   controller. The OpenAI/Anthropic channels (WebUI) keep controller → executor.
4. The deterministic honesty check (`evaluateDeterministic`) runs on every step as today. The LLM critic
   (`reviewStep`) runs only on a suspicion signal:
   - **token anomaly:** the executor's completion tokens for the step lie outside mean ± 2σ of the last 50
     steps of that model in this process; no signal until 20 steps are recorded;
   - **SAP request answered without tools:** zero MCP tool calls AND the request concerns SAP. Every request
     is checked for SAP relevance, at no extra LLM cost: the top tool score of the executor's own tool search
     ≥ 0.48, OR the request names an SAP object (`\b[ZY][A-Z0-9_/]{2,}\b`, `$TMP`, a transport
     `\b[A-Z0-9]{3}K9\d{5}\b`). Measured: chat questions top out at 0.467, SAP questions start at 0.450, so
     the score alone overlaps; the identifier rule closes the gap (12/12 SAP, 0/12 chat).
   - `LLM_AGENT_STEP_REVIEW_ENABLED=false` (existing kill switch) still turns the whole guard off.

## Global constraints

- Code from the main repo `main`; branch `perf/agent-latency`. No new required config; a new env var gets
  a default and is documented (`npm run docs:check` must pass).
- No model names: the translator uses the classifier model as today (`config.llm.classifierModel`, which falls
  back to the main model when unset).
- Jest with `--maxWorkers=2`; at most 2 parallel processes. Full suite once at the end of each task.
- Keep the security filter of `ExpositionFilteringRag` (role collections, fail-closed exposition) unchanged.

## Task 1: translation only for tool search

**Files:** `srv/agent-manager.ts` (builders, `createToolsRagStore`, `loadToolCorpus`, `ExpositionFilteringRag`),
new `srv/lib/tool-query-translator.ts`, tests under `test/unit/`.

- Every hub `SmartAgentBuilder` (`configureDestinationAgentBuilder`, `buildLlmOnlyAgent`) sets
  `agent.ragTranslateEnabled: false`, so the pipeline `translate` stage never runs.
- `ToolQueryTranslator`: `translate(text, options): Promise<string>` — ASCII or < 15 chars → unchanged; else one
  classifier-model chat with the prompt `TranslatePreprocessor` uses today (llm-agent `TRANSLATE_SYSTEM_PROMPT`, copied if not exported), result
  trimmed; empty or failed → original text. LRU cache by text, 500 entries; concurrent calls for one text share
  one promise.
- `ExpositionFilteringRag` takes an optional translator and the query embedder. `query()` translates
  `embedding.text` before searching the reader/writer/skill stores and searches with a new embedding of the
  translated text: `QueryEmbedding(translated, embedder)` when an embedder exists, else
  `TextOnlyEmbedding(translated)`. Same for every backend (in-memory, vector, hana/pg vector, qdrant).
- The `vector` tools store loses its `TranslatePreprocessor` (it would translate twice).
  `loadToolCorpus(…, { translateQueries: false })` (the measurement tool) builds the store without a translator.
- Tests: tool store queried with the translated text for a Ukrainian query; history store and a collection store
  receive the ORIGINAL text in the same request; ASCII query → no translator call; cache: two queries of one
  text → one LLM call; translator failure → original text, no throw; in-memory path uses `TextOnlyEmbedding`.
- Verify: `tools/measure-tool-rag.ts` with translation on (add an env switch `TOOL_RAG_MEASURE_TRANSLATE=1`)
  reaches K15 reqRecall ≥ 0.96 on the Ukrainian set.

## Task 2: the controller does no retrieval

**Files:** `srv/agent-manager.ts` (`buildAgentForDestination`, `configureDestinationAgentBuilder`).

- `configureDestinationAgentBuilder(…, { skipSkills: true, skipRetrieval: true })` for the controller: no
  `setToolsRag`, no `setHistoryRag`. The executor worker keeps both.
- Tests: building the controller registers no tools/history store; a controller run makes no RAG query, no
  embedding and no translation before the coordinator stage (spy on the stores / translator); the executor
  still searches tools and history.

## Task 3: the LLM critic runs on suspicion only

**Files:** `srv/lib/step-reviewer.ts` (`evaluateGated`), new `srv/lib/review-signals.ts`, `srv/lib/notice-finalizer.ts`,
`ExpositionFilteringRag.query` (records the top tool score), the request scope that already carries
exposition (`connectionALS`) or a new per-request slot, `srv/lib/tracked-llm.ts` (per-request completion tokens
of main-model calls).

- `review-signals.ts`: `TokenStats` (per model, window 50, warm-up 20, `isAnomalous(tokens)`, `record(tokens)`),
  `concernsSap(request, topToolScore)` with the threshold `LLM_AGENT_SAP_RELEVANCE_SCORE` (default 0.48) and the
  identifier rule above; `suspicion({ records, request, topToolScore, completionTokens, model })` →
  `{ suspicious: boolean, reasons: string[] }`.
- `ExpositionFilteringRag.query` stores the top non-skill score of the request in the request scope.
- Main-model completion tokens of the step are summed per request (before the critic runs) and recorded into
  `TokenStats` after every step, suspicious or not.
- `evaluateGated` always runs `evaluateDeterministic`; calls `reviewStep` only when `suspicion().suspicious`; logs
  the reasons (`step review triggered`) or `step review skipped`.
- Tests: chat answer with no tools and a non-SAP request → no `reviewStep`; SAP-named request with no tools →
  `reviewStep`; score ≥ 0.48 with no tools → `reviewStep`; tools called and tokens normal → no `reviewStep`;
  token anomaly after warm-up → `reviewStep`; before warm-up → none; deterministic issue still reported without
  the LLM; kill switch off → nothing.

## Task 4: `execute_step` runs the executor alone

**Files:** `srv/agent-manager.ts` (expose the executor agent on the handle, like `recMcp`), `srv/agent-mcp.ts`.

- The controller handle carries `executor` (the `withConversationHistory` SmartAgent) and `recMcp`.
- `execute_step` calls `handle.executor.process([...history, task], opts)` inside the same scopes as today, then
  `evaluateGated` (Task 3) with the step's records, and appends `renderNotice(verdict)` to the text on a failed
  verdict — the same NOTICE the finalizer would add. Error paths, `unverifiedWriteFor`, `recMcp.dropRequest`,
  door admission, long-session history and the pass-through output are unchanged.
- Tests: `execute_step` never invokes the controller's coordinator; the result text equals the executor output,
  plus a NOTICE on a deterministic contradiction; long-session steps still share history.

## Task 5: docs and measurement

- `CHANGELOG.md` [Unreleased] "Changed"/"Performance"; `docs/architecture/ARCHITECTURE.md` §7 (execute_step no
  longer goes through the controller; critic gating); `docs/llm-agent/CONFIG_USAGE.md` (`LLM_AGENT_SAP_RELEVANCE_SCORE`).
- After deploy to the test subaccount: rerun the streaming timing script (first content / total, Ukrainian and
  English) and record the numbers in the PR.
