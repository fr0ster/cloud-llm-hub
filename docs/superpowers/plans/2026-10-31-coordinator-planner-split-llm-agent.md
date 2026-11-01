# Coordinator and planner split — llm-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give llm-agent a stateless plan author (create / revise), coordinator mode for `DialogueSession`, the
orchestration tools `plan_create` / `plan_revise` / `plan_get` / `plan_update`, and a way to call the
orchestration tools on a session without an LLM turn.

**Architecture:** A new `IPlanAuthor` interface with a profile-backed implementation turns a brief into a
`DialoguePlan` through a prepared agent (tool loop, host-enforced read-only knowledge tools). `PlannerToolsClient`
gains planning tools that call the author from the planner scope. `DialogueSession` gets an optional `planAuthor`
(coordinator mode: coordinator prompt, planning through tools) and `callTool()` for external coordinators.

**Tech Stack:** TypeScript, node:test (`npm test` in `packages/llm-agent-libs`), zod, Changesets.

**Spec:** `docs/superpowers/specs/2026-10-31-coordinator-planner-split-design.md` (hub repo, branch
`design/coordinator-planner-split`).

## Global Constraints

- Repository `C:\Users\OleksiiKyslytsia\projects\llm-agent`; branch `feat/coordinator-planner-split` from
  `origin/main`. Never commit on main.
- Static typing: no `any`, no `as unknown as`, no silencing casts; `unknown` only for narrowed caught errors and
  untyped tool `args` already typed `Record<string, unknown>` by `IMcpClient`.
- Existing behaviour without `planAuthor` stays byte-for-byte (other library users).
- Tool names, no aliases: `plan_create`, `plan_revise`, `plan_get`, `plan_update`. `get_plan` / `update_plan` are
  renamed (removed), not aliased.
- Planner (author) has no SAP tools; read-only knowledge tools are enforced by the host runner, not the library.
- Changeset: minor for `@mcp-abap-adt/llm-agent` and `@mcp-abap-adt/llm-agent-libs`.
- Release order: version PR → Claude pushes signed per-package tags → the user publishes.

## Review Focus

- `plan_create` / `plan_revise` returning unparsable or schema-invalid output → tool error, session plan unchanged.
- `plan_revise` must keep finished work: steps `done` with `taskIds` / `successfulWorkTaskId` survive (merge, not
  replace).
- `callTool()` while a coordinator turn is running in the same session → refused with a clear error, no state
  change.
- `plan_create` when the session already has an active plan with running tasks → refused like `new_request` with a
  reserved attempt; caller must stop or finish first.
- Coordinator mode with a profile source lacking `coordinator` prompt → falls back to `DIALOGUE_COORDINATOR_SYSTEM`,
  never to the planner prompt.

---

### Task 1: Plan author interfaces and profile-backed author

**Files:**
- Modify: `packages/llm-agent/src/interfaces/agent-profile.ts` (AgentPrompts, IAgentProfileRunner)
- Create: `packages/llm-agent/src/interfaces/plan-author.ts` (+ export from the interfaces index)
- Create: `packages/llm-agent-libs/src/coordinator/dialogue/profile-plan-author.ts`
- Create: `packages/llm-agent-libs/src/coordinator/dialogue/plan-author-prompt.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/profile-resolver.ts` (promptsSchema)
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/plan-author.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // llm-agent
  export interface AgentPrompts { workerBase?: string; planner?: string;
    coordinator?: string; plannerCreate?: string; plannerRevise?: string }
  export interface PlanBrief { goal: string; context?: string; references?: string[] }
  export interface PlanRevisionInput { plan: DialoguePlan; change: string; brief?: PlanBrief }
  export interface PlanAuthorError { code: 'invalid' | 'unavailable' | 'aborted'; message: string }
  export interface IPlanAuthor {
    create(brief: PlanBrief, options?: CallOptions): Promise<Result<DialoguePlan, PlanAuthorError>>;
    revise(input: PlanRevisionInput, options?: CallOptions): Promise<Result<DialoguePlan, PlanAuthorError>>;
  }
  // IAgentProfileRunner gains:
  preparePlanAuthor(input: { systemPrompt: string; mode: 'create' | 'revise' },
    options?: CallOptions): Promise<Result<ISmartAgent, AgentProfileError>>;
  // llm-agent-libs
  export const PLAN_CREATE_SYSTEM: string; export const PLAN_REVISE_SYSTEM: string;
  export class ProfilePlanAuthor implements IPlanAuthor {
    constructor(opts: { source: IAgentProfileSource; runner: IAgentProfileRunner;
      notes?: (options?: CallOptions) => Promise<string[]> });
  }
  ```
- `ProfilePlanAuthor` input message: the brief as JSON plus `notes()` (worker profiles, environment) and, for
  revise, `planView(plan)` and the change. Output: the agent's final text must be a JSON object
  `{ steps: PlanStep-input[], question?: string, status?: 'active'|'waiting_user'|'done' }` parsed with the existing
  `stepSchema`; revise output goes through `mergePlan(current, next)` so finished work survives.
- Prompt choice: `prompts.plannerCreate ?? PLAN_CREATE_SYSTEM`, `prompts.plannerRevise ?? PLAN_REVISE_SYSTEM`.
  The constants carry only planning rules (taken from `DIALOGUE_PLANNER_SYSTEM`'s planning sections plus the JSON
  output contract).

- [ ] **Step 1: Write failing tests** in `plan-author.test.ts` using `profile-test-host.ts` stubs:
  - `create returns a plan parsed from the author JSON` — stub agent returns
    `{"steps":[{"id":"s1","goal":"read","worker":"executor"}]}`; assert `ok`, `plan.steps[0].state === 'pending'`.
  - `create uses the plannerCreate prompt when the source has one` — assert the runner got
    `{ mode: 'create', systemPrompt: '<custom>' }`.
  - `create falls back to PLAN_CREATE_SYSTEM` — source prompts `{}`.
  - `invalid JSON is an invalid error` — stub returns `not json`; assert `!ok && error.code === 'invalid'`.
  - `revise keeps done steps` — current plan step `s1` done with `taskIds:['t1']`, author returns s1 pending + s2;
    assert merged s1 still `done` with `taskIds ['t1']`, s2 `pending`.
  - `aborted signal yields aborted` — pre-aborted `AbortSignal`; assert `error.code === 'aborted'`.
- [ ] **Step 2:** `npm test -w packages/llm-agent-libs` → the new tests FAIL (module not found).
- [ ] **Step 3:** Implement the interfaces, prompts, `promptsSchema` fields, and `ProfilePlanAuthor`. Add a
  `preparePlanAuthor` stub to `profile-test-host.ts` and to every in-repo `IAgentProfileRunner` implementation.
- [ ] **Step 4:** `npm run build && npm test` in `packages/llm-agent` and `packages/llm-agent-libs` → PASS.
- [ ] **Step 5:** Commit `feat(dialogue): stateless plan author with create/revise prompts`.

### Task 2: Planning tools in `PlannerToolsClient`

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/planner-scope.ts` (add `planAuthor?: IPlanAuthor`)
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/planner-tools-client.ts`
- Modify: existing tests that call `get_plan` / `update_plan` (rename)
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/planner-tools-client.test.ts`

**Interfaces:**
- Consumes: `IPlanAuthor`, `PlanBrief` (Task 1).
- Produces tool schemas:
  - `plan_create { goal: string (required), context?: string, references?: string[] }` → stores the plan through
    `scope.setPlan(plan, plan.status, plan.question)` and returns `{ ok: true, plan: planView(plan) }`.
  - `plan_revise { change: string (required), context?: string }` → `planAuthor.revise({ plan: current, change })`,
    stores and returns like `plan_create`. Error when the session has no structured plan.
  - `plan_get` = former `get_plan` (same args and output). `plan_update` = former `update_plan` (same args and
    output, description "Edit the current plan directly, without the planner.").
  - When `scope.planAuthor` is absent, `plan_create` / `plan_revise` are not listed and calling them errors
    `plan author is unavailable`.

- [ ] **Step 1: Write failing tests:**
  - `plan_create stores the author plan` — stub author; assert `getPlan()` structured with the stub step.
  - `plan_create is refused while an attempt is reserved` — same condition as `new_request`; assert error, plan
    unchanged.
  - `plan_revise merges and stores` — assert done step kept.
  - `plan_revise without a structured plan errors`.
  - `author error leaves the plan unchanged` — stub returns `{ok:false, code:'invalid'}`; assert tool error text
    contains `invalid` and `getPlan()` is the previous plan.
  - `listTools hides planning tools without an author` and `lists plan_get/plan_update, never get_plan/update_plan`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; rename `get_plan`/`update_plan` everywhere in the package (prompts, tests, guidance).
- [ ] **Step 4:** Build and test both packages → PASS.
- [ ] **Step 5:** Commit `feat(dialogue): plan_create/plan_revise tools; rename plan tools`.

### Task 3: Coordinator mode and `callTool()` in `DialogueSession`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dialogue/coordinator-prompt.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/dialogue-session.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dialogue/index.ts` (exports)
- Test: `packages/llm-agent-libs/src/coordinator/dialogue/__tests__/coordinator-mode.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  ```ts
  export const DIALOGUE_COORDINATOR_SYSTEM: string; // conversation + orchestration rules only
  // DialogueSessionOptions gains:
  planAuthor?: IPlanAuthor;
  // DialogueSession gains:
  callTool(name: string, args: Record<string, unknown>,
    opts?: { signal?: AbortSignal }): Promise<Result<McpToolResult, McpError>>;
  ```
- With `planAuthor`: the turn prompt is `composePlannerPrompt(discovery.prompts.coordinator ??
  DIALOGUE_COORDINATOR_SYSTEM)` and the scope carries `planAuthor`. Without it: unchanged.
- `callTool` builds the same `PlannerScope` a turn uses (board, plan get/set, deliver, ownTask, taskSteps,
  planAuthor) without turn hooks (`beforeTool` counting, restart), runs `PlannerToolsClient.callTool` inside
  `runInPlannerScope`, persists state like a turn, emits the same plan/task signals. Refused with
  `session is busy with a coordinator turn` while a turn runs. `new_request` and `deliver` are not callable through
  `callTool` (error `not available outside a coordinator turn`).

- [ ] **Step 1: Write failing tests:**
  - `coordinator mode uses the coordinator prompt` — profile source prompts `{ coordinator: 'C' }`; assert the
    runner's `preparePlanner` got a system prompt starting with `C`.
  - `coordinator mode falls back to DIALOGUE_COORDINATOR_SYSTEM, never the planner prompt` — prompts
    `{ planner: 'P' }`; assert prompt does not contain `P`.
  - `without planAuthor the planner prompt is unchanged` — assert equals today's composed prompt.
  - `callTool plan_create then delegate_task runs a task and get_task returns it` — no planner agent at all.
  - `callTool persists to the store and emits a plan signal`.
  - `callTool is refused during a turn` — start `send()` with a planner stub that awaits a gate; assert refusal.
  - `callTool rejects new_request and deliver`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; extract the scope construction shared by turns and `callTool` into one private method.
- [ ] **Step 4:** Build and full test in all touched packages → PASS.
- [ ] **Step 5:** Add `.changeset/coordinator-planner-split.md` (minor: llm-agent, llm-agent-libs) describing the
  author, coordinator mode, `callTool`, and the plan tool rename. Commit
  `feat(dialogue): coordinator mode and session callTool`.

### Task 4: Docs and PR

- [ ] **Step 1:** Update the package README / docs that list planner tools (`get_plan`, `update_plan`) and describe
  `IPlanAuthor`, coordinator mode, `callTool`.
- [ ] **Step 2:** Root `npm run build && npm test` (workspaces) and lint → PASS.
- [ ] **Step 3:** Commit `docs(dialogue): coordinator and plan author`; push branch, open PR to `fr0ster/llm-agent`
  after the user's go-ahead; Codex review.
