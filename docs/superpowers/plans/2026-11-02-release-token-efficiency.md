# Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the release items: models per role, no progress text on waiting stops, cheaper RAG reading,
windowed tool loops, `query` in compact tool results, skill kinds in the library, docs MCP per role.

**Architecture:** Library first (llm-agent minor: `delegate_task`/worker `model`, waiting-stop fallback, skill-kind
patch), then the hub (per-session/per-request model resolution replacing the shared-model hot-swap, allowlist,
profile `model`, RAG read pointer and page size, window strategy wiring, summary `query`, external docs MCP per
role with `docs` trust).

**Tech Stack:** TypeScript, node:test (llm-agent), jest `--maxWorkers=1` (hub), SAP CAP, BTP destinations, MCP
Streamable HTTP.

**Spec:** `docs/superpowers/specs/2026-11-02-release-token-efficiency-design.md`

## Global Constraints

- Allowlist `LLM_AGENT_MODELS` (comma list); `LLM_AGENT_MODEL` and `LLM_AGENT_PLANNER_MODEL` always allowed; unset =
  only those two. Only `LLM_AGENT_MODEL` may be a required model name.
- Request model overrides the coordinator model for that session/request only; never process-wide. Unknown
  request model → ignored, header `x-clh-model-ignored: <id>`, log line.
- Disallowed `delegate_task`/`execute_step` model → tool error `MODEL_NOT_ALLOWED`.
- Same tools on every connection; profile ceilings apply.
- Built-in external MCP is distinct from client-supplied tools; credentials only via destinations.
- Static typing: no any/unknown except narrowed caught errors, no `as unknown as`, no `as never`.
- Cache only in DB providers; do not rewrite CHANGELOG history or older specs.

## Review Focus

- Two sessions with different WebUI models at once: each coordinator uses its own model; agents stay on defaults.
- Claude Code / Anthropic client sending `claude-…` ids: request runs on defaults, header set, no error.
- A long `rag_read` loop: repeated identical page inside the window → pointer; after it leaves the window → full
  text again; changed record → text.
- External docs MCP destination unreachable at startup: hub starts, role simply lacks those tools, warning logged.
- Waiting-stop after tool rounds with English pre-tool text: reply has none of it.

---

### Task 1: llm-agent — worker model, waiting-stop fallback, skill kinds

Repo `C:\Users\OleksiiKyslytsia\projects\llm-agent`, branch `feat/worker-model` from `origin/main`.

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/planner-tools-client.ts` (`delegate_task` schema gains
  optional `model: string`; passed to the task board and `IAgentProfileRunner.createWorker`)
- Modify: `packages/llm-agent/src/interfaces/agent-profile.ts` (`WorkerProfile.model?: string`;
  `createWorker(input, options)` input gains `model?: string`)
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/task-board.ts` (task record keeps `model`)
- Modify: `IAgentProfileRunner` gains optional `validateModel?(model: string): Result<void, AgentProfileError>`;
  `AgentProfileError.code` gains `MODEL_NOT_ALLOWED`. `delegate_task` calls it synchronously BEFORE enqueueing; a
  failure is the tool error (`MODEL_NOT_ALLOWED`) and creates no task.
- Modify: `packages/llm-agent-libs/src/agent.ts`, `pipeline/handlers/tool-loop.ts`,
  `coordinator/dialogue/dialogue-session.ts` (fallback without a final iteration keeps only the last iteration's
  text; validation-retry/reset handling unchanged)
- Modify: `packages/llm-agent-libs/src/skills/skill-utils.ts` — discovery keys skills by identity, not display
  name: front-matter `id`, else the skill directory name; two skills sharing a display name with different ids
  both survive (no overwrite, no rejection of different `kind`s); two skills with the same identity keep today's
  first-wins behaviour with a warning
- Test: `packages/llm-agent-libs/src/__tests__/worker-model.test.ts`, extend `final-iteration-content.test.ts`
- Changeset: minor for llm-agent and llm-agent-libs (server-libs patch if touched).

- [ ] **Step 1: Failing tests:** a disallowed model → tool error `MODEL_NOT_ALLOWED`, no task on the board;
  `delegate_task({ worker, goal, model: 'm2' })` reaches `createWorker` with
  `model: 'm2'` and the task record stores it; without `model` nothing is passed; a call stopped after two tool
  rounds ("Thinking." then "Waiting." + stopping tool) returns exactly "Waiting."; two skill dirs sharing a display name
  with different ids (or directory names) both load, regardless of `kind`.
- [ ] **Step 2–4:** Fail, implement, pass; typecheck, lint, tests of all packages.
- [ ] **Step 5:** Commit, PR, Codex review, merge, release (version PR → signed tags → user publishes npm).

### Task 2: Hub — model resolution and allowlist

Hub branch `feat/release-readiness` from the reviewed `design/model-per-role` head, rebased on main; deps bumped to
Task 1's versions.

**Files:**
- Create: `srv/lib/model-policy.ts` — `parseModelAllowlist(env): ReadonlySet<string>`,
  `resolveRequestModel(requested: string | undefined, allow): { model?: string; ignored?: string }`,
  `resolveAgentModel(input: { requested?: string; profile?: string }, allow, fallback: string): Result<string, 'MODEL_NOT_ALLOWED'>`
- Modify: `srv/agent-manager.ts` — remove the shared-model hot-swap in `getSmartAgent` (`requestedModel` no longer
  changes `currentModel`/`sharedMainLlm`/agent deps); coordinator/planner construction takes the per-session model;
  `buildWorker` / `createWorker` builds the agent on the resolved agent model (LLM cached per model name).
- Modify: `srv/openai-handler.ts`, `srv/anthropic-handler.ts` — resolve the request model per request; dialogue
  sessions keep their coordinator model for the session; `x-clh-model-ignored` header.
- Modify: `srv/lib/agent-profile-records.ts` — `model` on `kind: profile` only; write → 400 outside allowlist; load →
  ignore with warning.
- Modify: `srv/lib/orchestration-tool-definitions.ts` / `srv/lib/executor-step.ts` — `execute_step.model`,
  default = executor profile model, else `LLM_AGENT_MODEL`.
- Modify: `srv/agent-profiles/coordinator.md` — rule: default model for agents; stronger allowed model only for hard
  analysis or a failed check.
- Test: `test/unit/model-policy.test.ts`, `test/unit/model-per-session.test.ts`.

- [ ] **Step 1: Failing tests:** two concurrent sessions with models A and B: each coordinator call uses its model,
  executor uses `LLM_AGENT_MODEL`; request `claude-sonnet-4` ignored with header; `delegate_task` with a disallowed
  model → `MODEL_NOT_ALLOWED`; profile write with disallowed model → 400; stored disallowed model loads with
  warning; `execute_step` default and override; `/v1/models` `_active_model` unchanged by requests.
- [ ] **Step 2–4:** Fail, implement, pass; full jest.
- [ ] **Step 5:** Commit `feat(models): per-session coordinator model and per-agent model allowlist`.

### Task 3: Hub — RAG reading, window strategy, summary query, waiting-stop wrapper

**Files:**
- Modify: `srv/agent-mcp-rag.ts` (`rag_read` default `limit` 32000)
- Create: `srv/lib/read-dedup.ts` — per tool-loop record (scope: one agent tool loop, keyed by its trace) of reads
  identified by `(collection, record, offset, limit, sha256(full record text))` and the round index that returned the full
  text. A repeat whose page hash matches and whose original round is still within the last N rounds returns the
  pointer; pointer responses never update that round index (they cannot extend the text's lifetime);
  a repeat inside the window returns `{ id, offset, total, alreadyRead: true, note: "already read above in this task: <record> offset n–m" }`
- Modify: `srv/agent-manager.ts` — `withToolLoopContextStrategyFactory(() => new WindowContextStrategy({ keepLastRounds: N }))`
  for agent tool loops, `N = LLM_AGENT_TOOL_LOOP_WINDOW` (default 8); the hub wraps the factory so each recorded
  round increments the loop's round counter used by read-dedup (no library eviction callback needed).
- Modify: `srv/lib/tool-result-summary.ts` — keep `query` (first 200 characters) for `rag_search` and `offset` / `limit`
  arguments for `rag_read`, so paging and repeated reads are distinguishable outside the hub.
- Elided rounds (user input, 2026-11-02): when the window drops a round, the model sees a short, deterministic
  digest instead of nothing — one line per dropped tool result, e.g. `rag_read <collection>/<record> chars n–m of
  total (read earlier, dropped from context)` or `<tool>: <first 120 chars of the result>` — so it knows what it
  already used and re-reads only when it needs the text again. No LLM summarization in this release.
- Modify: `srv/lib/dialogue-planner-content.ts` — paragraph wrapper keeps only the last iteration's text on stops
  without a final iteration (matches Task 1).
- Modify: `srv/agent-profiles/coordinator.md` — delegate document reading/analysis to an agent.
- Test: `test/unit/read-dedup.test.ts`, extend `tool-result-summary`, `dialogue-planner-content` tests.

- [ ] Steps: failing tests (pointer inside window, full text after it left, changed record re-read incl. a change
  on another page of the same record, page size,
  query kept, wrapper drops progress on stop) → implement → pass → commit `feat(rag): larger pages, read dedup,
  windowed tool loops`.

### Task 4: Hub — external docs MCP per role

**Files:**
- Modify: `srv/agent-config.ts` — `LLM_AGENT_PLANNER_MCP`, `LLM_AGENT_EXECUTOR_MCP`, `LLM_AGENT_CHECKER_MCP`,
  `LLM_AGENT_ANALYST_MCP` (destination lists), `LLM_AGENT_MCP_TRUST=<destination>=<n>,…`.
- Create: `srv/lib/external-mcp.ts` — connect each destination via Streamable HTTP through `McpClientAdapter`
  (destination URL and auth from the BTP destination service), lazy with retry/cooldown; failures log and leave
  the role without those tools. Each external client registers its tool names with ownership
  `(destination, tool)`; external tools are distinguished from embedded and client tools by that registry, and a
  name clash with an embedded or RAG tool is resolved by prefixing the external tool `<destination>__<tool>`.
- Modify: agent construction per role to add the role's external clients (read-only knowledge tools for the
  planner/author); `systemToolTrust` extended → `docs` class for external tools. Precedence: per-destination
  `LLM_AGENT_MCP_TRUST` override → the active profile's trust map `docs` value (source-trust spec,
  `2026-11-01-source-trust-design.md`, "Profile trust map") → deploy/built-in `docs` default.
- Modify: docs (configuration, architecture), CHANGELOG.
- Test: `test/unit/external-mcp.test.ts` (fake MCP server over HTTP): tools offered only to configured roles,
  results tagged `[source: docs:<tool>; trust n]`; precedence across destination override, two profiles with
  different `docs` maps, and the default; a clashing tool name is prefixed; unreachable destination → startup
  continues.

- [ ] Steps: failing tests → implement → pass → commit `feat(mcp): built-in docs MCP per role`.
- [ ] POC (user go-ahead): create a NoAuthentication destination for `https://mcp-abap.marianzeis.de/mcp`, check CF
  egress, set `LLM_AGENT_EXECUTOR_MCP` / `LLM_AGENT_ANALYST_MCP`, verify a docs search reaches the agent with a
  `docs` tag.

### Task 5: Release verification

- [ ] Whole-branch Codex review → PR → merge → release → POC deploy (snapshot first).
- [ ] Re-run the four-phase documentation scenario: executor/checker on `LLM_AGENT_MODEL`, total input tokens at
  least halved versus the reported baseline; write `docs/superpowers/verification/2026-11-xx-release-readiness.md`
  incl. the 10.2.0/10.2.1 measurements.
