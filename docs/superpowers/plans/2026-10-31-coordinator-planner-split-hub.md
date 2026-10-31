# Coordinator and planner split — hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the dialogue as a coordinator with a stateless planner, and expose the same orchestration tools on
agent MCP so an external agent can coordinate instead.

**Architecture:** The hub supplies profile records (`coordinator`, `planner-create`, `planner-revise`), a
`preparePlanAuthor` runner with read-only knowledge tools, passes `ProfilePlanAuthor` into `DialogueSession`, and
registers orchestration tools on agent MCP that call `DialogueSession.callTool()` on the caller's session.

**Tech Stack:** TypeScript, SAP CAP, jest (`--maxWorkers=1`), MCP SDK, zod.

**Spec:** `docs/superpowers/specs/2026-10-31-coordinator-planner-split-design.md`.
**Depends on:** `2026-10-31-coordinator-planner-split-llm-agent.md` released (new llm-agent / llm-agent-libs
minor versions published by the user).

## Global Constraints

- Branch `feat/coordinator-planner-split` from `origin/main` in `cloud-llm-hub-poc-hana-rag` (fetch/push by URL
  `git@github.com:fr0ster/cloud-llm-hub.git`). Never commit on main.
- Static typing everywhere (no any / `as unknown as` / silencing casts).
- `LLM_AGENT_PLANNER_MODEL` drives both coordinator and planner by default. Optional, unset by default:
  `LLM_AGENT_COORDINATOR_MODEL`. Only `LLM_AGENT_MODEL` may be required.
- Planner tools: exactly `rag_search`, `rag_read`, `collection_records`, `collections_list`, under profile
  ceilings; no SAP tools; agents-collection exclusion applies.
- Same orchestration tools on every connection; no aliases for renamed tools.
- WebUI and OpenAI / Anthropic protocol behaviour unchanged (plan/task events, TASKS panel, turn/follow).
- Codex implements (`codex exec -s workspace-write`, no commit); Claude reviews, runs tsc/lint/jest, commits.

## Review Focus

- Orchestration session tools without a session key → `SESSION_REQUIRED`; another user's key → `SESSION_NOT_FOUND`.
- External `delegate_task` naming a worker beyond the caller's exposition level → refused like today's grants.
- A WebUI dialogue and an agent MCP client on the same session key at once → `callTool` refused while a turn runs;
  no lost plan.
- Restart with a headless (MCP-only) session that has running tasks → restored like dialogue state (interrupted
  tasks, replan note), not silently dropped.
- Planner author attempting a write tool (`record_add`) → refused by the ceiling.

---

### Task 1: Dependencies, profile records and prompts

**Files:**
- Modify: `package.json`, `package-lock.json` (new llm-agent / llm-agent-libs minors)
- Create: `srv/agent-profiles/coordinator.md`, `srv/agent-profiles/planner-create.md`,
  `srv/agent-profiles/planner-revise.md`
- Delete: `srv/agent-profiles/planner.md` (content split into the three files)
- Modify: `srv/lib/agent-profile-seeds.ts` (seed + require the new records; `planner` no longer required)
- Modify: `srv/lib/agent-profile-source.ts` (`getPrompts` returns `coordinator`, `plannerCreate`, `plannerRevise`)
- Modify: `test/unit/shipped-rag-contract.test.ts` and seed tests
- Test: `test/unit/agent-profile-seeds.test.ts` (or the existing seed test file)

**Interfaces:**
- Produces: record names `coordinator` (`kind: coordinator`), `planner-create` / `planner-revise`
  (`kind: planner-author`). The existing `LLM_AGENT_PLANNER_RECORD` override now names the coordinator record.
- Split rule: conversation/orchestration lines → coordinator; planning rules (step design, batches, paging,
  scope-narrowing consent, checks in the plan, profile selection for steps) → both planner records; revise adds
  "keep done steps, change only what the change requires".

- [ ] **Step 1: Failing tests:** seeds include the three records and not `planner`; `getPrompts` maps them;
  shipped-contract test asserts the coordinator prompt mentions `plan_create` / `plan_revise` / `plan_update` and
  no longer `get_plan` / `update_plan`; planner records mention no SAP tool names.
- [ ] **Step 2:** Run `npx jest --maxWorkers=1 test/unit/agent-profile*` → FAIL.
- [ ] **Step 3:** Implement; `npm ci --ignore-scripts` after the dependency bump.
- [ ] **Step 4:** tsc (both configs), lint, touched suites → PASS.
- [ ] **Step 5:** Commit `feat(agents): coordinator and planner author profiles`.

### Task 2: Plan author runner and coordinator wiring

**Files:**
- Modify: `srv/agent-manager.ts` (`destinationProfileRunner`: `preparePlanAuthor`; coordinator model)
- Modify: `srv/agent-config.ts` (`LLM_AGENT_COORDINATOR_MODEL`, optional)
- Modify: `srv/lib/dialogue-sessions.ts` (pass `planAuthor: new ProfilePlanAuthor({...})`; move
  `plannerSessionOptions` retrieval/memory to the author notes)
- Modify: `srv/lib/dialogue-store.ts` (`DIALOGUE_TOOL_CONTRACT_VERSION = 2`; v1 → v2 keeps plan and tasks; v0 → v2
  keeps the existing interrupt migration)
- Test: `test/unit/dialogue-sessions.test.ts`, `test/unit/dialogue-store.test.ts`, new
  `test/unit/plan-author-runner.test.ts`

**Interfaces:**
- Consumes: `IPlanAuthor`, `ProfilePlanAuthor`, `preparePlanAuthor` (llm-agent plan).
- Produces: `preparePlanAuthor({ systemPrompt, mode })` returns a SmartAgent whose only MCP client is
  `LocalRagMcpClient` filtered to the four read tools under the caller's ceilings, model = planner model; usage
  recorded with component `planner-author`.

- [ ] **Step 1: Failing tests:**
  - `plan author lists exactly rag_search, rag_read, collection_records, collections_list`.
  - `plan author record_add is refused`.
  - `coordinator model defaults to the planner model`; `LLM_AGENT_COORDINATOR_MODEL overrides it`.
  - `dialogue session is opened with a planAuthor`.
  - `v1 state migrates to v2 keeping plan and tasks`; `v0 state still interrupts unfinished tasks`.
  - `planner-author usage is recorded with its own component`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** tsc, lint, full jest `--maxWorkers=1` → PASS.
- [ ] **Step 5:** Commit `feat(dialogue): coordinator with stateless plan author`.

### Task 3: Orchestration tools on agent MCP

**Files:**
- Modify: `srv/agent-mcp.ts` (register tools; `execute_step` gains optional `worker`)
- Create: `srv/agent-mcp-orchestration.ts` (tool definitions and handlers)
- Modify: `srv/lib/dialogue-sessions.ts` (open a headless dialogue for an agent MCP long session: no coordinator
  turn, same store and limits)
- Test: new `test/unit/agent-mcp-orchestration.test.ts`; extend the agent MCP tools/list parity test

**Interfaces:**
- Consumes: `DialogueSession.callTool` (llm-agent plan), `dialogueFor` (existing).
- Produces tools: `plan_create`, `plan_revise` (session optional: with a session they store and return; without,
  they return only), `plan_get`, `plan_update`, `delegate_task`, `get_task`, `list_tasks`, `stop_task`
  (session required). `execute_step { …existing, worker?: string }` — default `executor`; other profiles by name
  under the caller's grants.

- [ ] **Step 1: Failing tests:**
  - tools/list contains the eight orchestration tools plus the existing ones (15 + 8 = 23).
  - `delegate_task without session → SESSION_REQUIRED`; `foreign session → SESSION_NOT_FOUND`.
  - `plan_create without session returns a plan and stores nothing`.
  - `session flow: plan_create → delegate_task → get_task done`.
  - `execute_step worker=checker returns a verdict`; `worker beyond grants is refused`.
  - `callTool refused while a WebUI turn runs on the same key`.
  - `headless session with running task is restored as interrupted after restart`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** tsc, lint, full jest → PASS.
- [ ] **Step 5:** Commit `feat(agent-mcp): orchestration tools for external coordinators`.

### Task 4: Docs, CHANGELOG, measurement

- [ ] **Step 1:** Update `docs/architecture/ARCHITECTURE.md` (dialogue coordinator section), the agent MCP API
  reference, agent profile docs, configuration docs (`LLM_AGENT_COORDINATOR_MODEL`), CHANGELOG `[Unreleased]`
  (tool rename `get_plan`→`plan_get`, `update_plan`→`plan_update` is internal to the coordinator; release minor).
  Mark the spec as implemented.
- [ ] **Step 2:** Commit `docs: coordinator and planner split`.
- [ ] **Step 3 (after POC deploy, with the user's go-ahead):** run the same scenarios as before (snapshot taken
  before deploy), compare tokens per coordinator turn and per scenario from the usage records; write
  `docs/superpowers/verification/<date>-coordinator-planner-split.md`.
