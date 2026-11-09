# Session Role Models — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-session model choice for coordinator, planner, executor and checker, and per-session execution limits with "off", from the WebUI, the OpenAI/Anthropic APIs and the agent MCP. This is stage 1 of the spec: hub only, model parameters and library-owned limits refused.

**Architecture:**
- One typed settings object per session lives in an in-memory store keyed by the session slot (user + session key). It is not persisted, so a restart drops it.
- One validator serves all channels.
- An AsyncLocalStorage carries the session's settings into dialogue turns and agent MCP calls. The coordinator, the plan author and `createWorker` read it there.
- Channels only write the store: HTTP endpoints for the WebUI, sticky headers for the chat APIs, `session_open` / `session_set_models` for the agent MCP.

**Tech Stack:** TypeScript (CAP srv), zod, jest, plain-JS WebUI (`app/chat/webapp/index.html`), Playwright for the WebUI check.

**Spec:** `docs/superpowers/specs/2026-11-09-session-role-models-design.md`

**Stage 2** (llm-agent per-role `CallOptions`, reasoning, `'off'` limits, ledger parameters, then enabling `params` in the hub) gets its own plan once this stage is merged and the llm-agent internals are mapped.

## Global Constraints

- Static typing: no `any`, no `unknown` outside narrowed caught errors, no `as unknown as`, no `as never`.
- No timeouts introduced.
- Session isolation: settings are keyed by the caller's own session slot. No cookie, shared storage or empty header may attach them to another session.
- No new required configuration. Only `LLM_AGENT_MODEL` stays required.
- Changing models, parameters or limits needs `MCP_Admin` on every channel; reading the effective values does not.
- The same agent MCP tool set on every connection.
- A model or parameter the hub cannot apply is refused with a reason naming the field. Nothing is quietly replaced, and nothing is partly applied.
- Stage 1 refuses any `params` with the reason `parameters per role arrive with llm-agent per-role call options (stage 2)`.
- Settings are not written to the dialogue state store. The existing `coordinatorModel` persistence stays.
- jest runs with `--maxWorkers=1`.

## Review Focus

1. **Two sessions of one user.** Settings of session A are invisible to session B and to another user with the same session key. Test in Task 1.
2. **A session that is closed and then reopened under the same key.** It starts on defaults. Test in Task 1 (`clearRoleModels` on close) and Task 4.
3. **A model removed from `LLM_AGENT_MODELS` after it was set.** The next turn refuses visibly rather than running the old model. Test in Task 3.
4. **Headers on a request without a session** (plain mode, no `x-clh-session`). The request fails with 400 naming `x-clh-session`; nothing is stored under an empty key. Test in Task 5.
5. **`auto` sent for a role that was never set**, and an empty header value. Both are accepted as "clear" and must not throw. Test in Task 1.
6. **`maxIterations: 'off'` with a worker that loops.** The user must still be able to end it with `stop_task` or by closing the session. Test in Task 3b.

---

### Task 1: Settings types, validator and session store

**Files:**
- Create: `srv/lib/role-model-settings.ts`
- Test: `test/unit/role-model-settings.test.ts`

**Interfaces:**
- Produces:
  - `type RoleName = 'coordinator' | 'planner' | 'executor' | 'checker'`
  - `interface ModelParams { temperature?: number; topP?: number; maxOutputTokens?: number | 'off'; reasoning?: ReasoningSetting }`
  - `type ReasoningSetting = { kind: 'budget'; tokens: number | 'off' } | { kind: 'effort'; effort: 'low' | 'medium' | 'high' } | { kind: 'disabled' }`
  - `interface RoleSetting { model?: string; params?: ModelParams }`
  - `type RoleModelSettings = Partial<Record<RoleName, RoleSetting>>`
  - `interface RoleSettingsError { field: string; reason: string }`
  - `roleModelSettingsSchema` (zod) for the wire shape. A role value may also be the string `'auto'`, which means "clear".
  - `validateRoleModelSettings(input: RoleModelSettingsInput, ctx: { allow: ReadonlySet<string>; channel: 'chat' | 'mcp'; paramsEnabled: boolean }): Result<RoleModelSettings, RoleSettingsError>`
  - `getRoleModels(userId: string, key: string): RoleModelSettings`
  - `setRoleModels(userId: string, key: string, settings: RoleModelSettings): void`
  - `clearRoleModels(userId: string, key: string): void`

- [ ] **Step 1: Write the failing tests**
  - `accepts a model on the allowlist per role`
  - `refuses a model outside the allowlist with field "executor.model"`
  - `refuses params when paramsEnabled is false with the stage 2 reason`
  - `refuses params without a model with field "planner.params"`
  - `refuses coordinator on channel mcp with field "coordinator"`
  - `auto and empty model clear a role`
  - `refuses unknown role names`
  - `nothing is applied when one role is invalid`. The store keeps its previous value after a failed `setRoleModels` path. Validation happens before set.
  - `isolates sessions`: `setRoleModels('u1','k1',…)` is not seen by `getRoleModels('u1','k2')` or `getRoleModels('u2','k1')`.
  - `clearRoleModels returns the session to defaults`.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/role-model-settings.test.ts --maxWorkers=1`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement**
  - Implement `srv/lib/role-model-settings.ts`.
  - Key the store with the same slot function the dialogue sessions use (`slot(userId, key)` in `srv/lib/dialogue-sessions.ts`). Export it from a small shared module if it is not exported, rather than duplicating the format.
  - Return `Result` from `@mcp-abap-adt/llm-agent`, like `srv/lib/model-policy.ts`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npx jest test/unit/role-model-settings.test.ts --maxWorkers=1`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): per-session role model settings and validator"`

### Task 2: Model capability table

**Files:**
- Create: `srv/lib/model-capabilities.ts`
- Test: `test/unit/model-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `interface ParamCapability { name: keyof ModelParams; min?: number; max?: number; canDisable: boolean }`
  - `interface ModelCapabilities { family: 'anthropic' | 'openai' | 'openai-reasoning' | 'gemini' | 'mistral' | 'other'; params: ParamCapability[]; maxOutputTokens?: number }`
  - `modelCapabilities(model: string): ModelCapabilities | undefined`. It returns `undefined` for an unknown family, so no fields are guessed.
  - `capabilitiesFor(allow: ReadonlySet<string>): Record<string, ModelCapabilities | null>`
- Consumes: `ModelParams` from Task 1.

- [ ] **Step 1: Write the failing tests**
  - `anthropic--claude-4.6-opus is family anthropic with temperature, topP, maxOutputTokens (canDisable true), reasoning`
  - `an o-series or gpt-5 model has no temperature and has reasoning`
  - `an unknown model returns undefined`
  - `capabilitiesFor maps every allowlisted model, unknown ones to null`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/model-capabilities.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement the table**
  - Match families by the AI Core model-id prefix as the allowlist spells it: `anthropic--`, `gpt-`, `o1`/`o3`/`o4`, `gemini-`, `mistral`.
  - Anthropic `canDisable` for `maxOutputTokens` is true. Stage 2 sends the model maximum for `'off'`, so `maxOutputTokens` holds that maximum.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npx jest test/unit/model-capabilities.test.ts --maxWorkers=1`

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): model parameter capability table"`

### Task 3: Roles take their model from the session settings

**Files:**
- Create: `srv/lib/role-models-scope.ts`
- Modify: `srv/lib/dialogue-sessions.ts`:
  - the `profileRunner.createWorker` wrapper near :1191;
  - `preparePlanner` near :1199 (`withCoordinatorModel(selectedModel, …)`);
  - turn entry points (`runAdmitted` near :459).
- Modify: `srv/agent-manager.ts`: the plan-author `buildPlannerAgent` call near :3331, and `buildPlanner` near :3345.
- Test: `test/unit/role-models-scope.test.ts`; extend `test/unit/dialogue-sessions.test.ts` and `test/unit/model-per-session.test.ts`.

**Interfaces:**
- Consumes: `getRoleModels`, `RoleName` and `RoleModelSettings` from Task 1.
- Produces:
  - `withRoleModels<T>(settings: RoleModelSettings, fn: () => Promise<T>): Promise<T>`
  - `currentRoleModel(role: RoleName): string | undefined`
  - `roleOfProfile(profile: { result?: string }): 'executor' | 'checker'`. It returns `checker` when `result === 'verdict'`.
  - `effectiveRoleModels(userId: string, key: string): Record<RoleName, { model: string | null; source: 'user' | 'request' | 'env' | 'deploy' | 'coordinator' }>`. `model: null` with source `coordinator` means "the coordinator chooses".

- [ ] **Step 1: Write the failing tests**
  - `createWorker uses the user executor model over the delegate_task model`
  - `createWorker uses the user checker model for a verdict profile`
  - `createWorker keeps the delegate_task model when no user setting exists`
  - `the coordinator runs on the user coordinator model over the request model`
  - `the plan author runs on the user planner model, else LLM_AGENT_PLANNER_MODEL, else the deploy model`
  - `a user model removed from the allowlist is refused at the next worker with MODEL_NOT_ALLOWED`. It must not fall back.
  - `effectiveRoleModels reports source per role`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/role-models-scope.test.ts test/unit/dialogue-sessions.test.ts test/unit/model-per-session.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Every dialogue turn of a session runs inside `withRoleModels(getRoleModels(userId, key), …)`.
  - The `createWorker` wrapper passes `model: currentRoleModel(roleOfProfile(input.profile)) ?? input.model`.
  - `preparePlanner` uses `currentRoleModel('coordinator') ?? selectedModel`.
  - The plan-author call passes `llm.plannerModel: currentRoleModel('planner') ?? config.llm.plannerModel`.
  - The chat planner keeps following the coordinator.
  - When a user setting replaces a coordinator-requested model, log it at info with both models and the task id.
  - If the task board exposes a model field to the coordinator, set it to the model that ran. If it does not, list the gap for the stage 2 plan; do not patch the library here.

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): coordinator, planner and workers take the session role models"`

### Task 3b: Execution limits per session, with "off"

**Files:**
- Create: `srv/lib/execution-limits.ts`
- Modify (each limit is read where it is applied today):
  - `srv/agent-config.ts`: `maxIterations` near :643, `parseMaxToolCalls` near :929, `parseToolResultMaxChars` near :915;
  - `srv/agent-manager.ts`: the agent build that passes `maxIterations` / `maxToolCalls` near :754 and :2790–:2835, and `new SessionManager({ tokenBudget: 8000 })` near :2998 and :3805;
  - `srv/lib/read-dedup.ts:84` and `srv/lib/tool-result-cap.ts` (`toolResultBudget` ALS).
- Test: `test/unit/execution-limits.test.ts`

**Interfaces:**
- Consumes: the session slot and store pattern from Task 1, and `withRoleModels` from Task 3. Limits travel in the same scope.
- Produces:
  - `type Limit = number | 'off'`
  - `interface RunLimits { maxIterations?: Limit; maxToolCalls?: Limit }`
  - `interface ExecutionLimits { coordinator?: RunLimits; executor?: RunLimits; checker?: RunLimits; toolResultMaxChars?: Limit; historyTokenBudget?: Limit; planStepBudget?: Limit }`
  - `executionLimitsSchema` (zod)
  - `validateExecutionLimits(input: ExecutionLimitsInput, ctx: { libraryLimitsEnabled: boolean }): Result<ExecutionLimits, RoleSettingsError>`
  - `getExecutionLimits(userId: string, key: string): ExecutionLimits`
  - `setExecutionLimits(userId: string, key: string, limits: ExecutionLimits): void`
  - `clearExecutionLimits(userId: string, key: string): void`
  - `currentLimit(role: 'coordinator' | 'executor' | 'checker', name: keyof RunLimits): Limit | undefined`
  - `currentSessionLimit(name: 'toolResultMaxChars' | 'historyTokenBudget'): Limit | undefined`
  - `effectiveExecutionLimits(userId: string, key: string): Record<string, { value: number | 'off'; source: 'user' | 'env' | 'default' }>`

- [ ] **Step 1: Write the failing tests**
  - `maxIterations off lets an executor run past 10 iterations`. Use a fake LLM that asks for 12 tool rounds; the run completes.
  - `maxIterations 3 ends the executor run after 3 iterations with the existing budget-exhausted result`
  - `checker and executor limits are independent`
  - `toolResultMaxChars off returns the full tool result; a number caps it`
  - `historyTokenBudget off builds the SessionManager without a token budget`
  - `planStepBudget is refused with the stage 2 reason while libraryLimitsEnabled is false`
  - `limits are isolated per session and cleared on session close`
  - `an absent field keeps the env value; effectiveExecutionLimits reports source env`
  - `a stopped task ends a run whose maxIterations is off`. `stop_task` is the way out; no timeout is added.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/execution-limits.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Each place that reads a limit today asks `currentLimit` or `currentSessionLimit` first, then falls back to today's env/default.
  - `'off'` passes "no limit" in the form the consumer takes. If a consumer has no unlimited form, say so in the task summary and refuse `'off'` for that limit with a reason, rather than substituting a large number.
  - Agents are cached and shared, so a limit must not leak between sessions. If the cache key does not include the session's limits, build a per-session agent or pass the limit per call; do not mutate the shared config.

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(limits): per-session execution limits with off"`

### Task 3c: Deploy configuration parity

**Files:**
- Modify: `srv/agent-config.ts`: new optional variables next to `plannerModel` / `coordinatorModel` near :673, the limit parsers near :643, :915 and :929.
- Modify: `srv/lib/role-models-scope.ts` and `srv/lib/execution-limits.ts`: configuration is the default layer under the session setting.
- Test: extend `test/unit/session-config.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 3b.
- Produces:
  - `AgentConfig.llm.executorModel?: string` from `LLM_AGENT_EXECUTOR_MODEL`.
  - `AgentConfig.llm.checkerModel?: string` from `LLM_AGENT_CHECKER_MODEL`.
  - `AgentConfig.limits: ExecutionLimits`, built from:
    - `LLM_AGENT_<ROLE>_MAX_ITERATIONS` and `LLM_AGENT_<ROLE>_MAX_TOOL_CALLS` (`ROLE` = `COORDINATOR` | `EXECUTOR` | `CHECKER`), falling back to the existing `LLM_AGENT_MAX_ITERATIONS` / `LLM_AGENT_MAX_TOOL_CALLS`;
    - `LLM_AGENT_TOOL_RESULT_MAX_CHARS`;
    - `LLM_AGENT_HISTORY_TOKEN_BUDGET`.
  - Every limit variable accepts `off`.
  - The `effective*` sources gain `config`.

- [ ] **Step 1: Write the failing tests**
  - `LLM_AGENT_EXECUTOR_MODEL overrides the delegate_task model for every session`
  - `a session executor setting overrides LLM_AGENT_EXECUTOR_MODEL`
  - `LLM_AGENT_CHECKER_MODEL outside the allowlist fails startup naming the variable`
  - `LLM_AGENT_EXECUTOR_MAX_ITERATIONS=off gives the executor no iteration limit; the coordinator keeps LLM_AGENT_MAX_ITERATIONS`
  - `LLM_AGENT_HISTORY_TOKEN_BUDGET unset keeps 8000`
  - `no new variable is required: only LLM_AGENT_MODEL set still starts`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/session-config.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Resolution order per value: session setting → configuration → today's behaviour (the coordinator's choice for worker models, the built-in default for limits).
  - Document the new variables where the existing `LLM_AGENT_*` variables are documented (find with `grep -rl LLM_AGENT_PLANNER_MODEL docs`).

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(config): deploy defaults for role models and execution limits"`

### Task 4: Session models HTTP API and capabilities in /v1/models

**Files:**
- Create: `srv/session-models-handler.ts`
- Modify:
  - `srv/server.ts`: routes next to `POST /v1/session` near :393;
  - `srv/openai-handler.ts`: `handleModels` near :1680 adds `_meta.capabilities`;
  - the session close path that calls `closeDialogue`: it also calls `clearRoleModels` and `clearExecutionLimits`.
- Test: `test/unit/session-models-handler.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `GET /v1/session/models` with `x-clh-session` → `200 { settings: RoleModelSettings, effective: ReturnType<typeof effectiveRoleModels>, capabilities: ReturnType<typeof capabilitiesFor> }`.
  - `PUT /v1/session/models` with body `RoleModelSettingsInput` → `200` with the same body as GET, or `400 { error: { field, reason } }`. The route is mounted behind `requireAdminRole` (`srv/lib/require-admin-role.ts`), so a non-admin gets `403`.
  - GET is open to every user of the session and adds `canEdit: boolean`, which is true only for `MCP_Admin`.
  - Without a session header the answer is `400 { error: { field: 'x-clh-session', reason } }`.
  - Both bodies also carry `limits: ExecutionLimits`, and the GET answer carries `effectiveLimits`. A PUT validates models and limits together and applies both or neither.

- [ ] **Step 1: Write the failing tests**
  - `GET without x-clh-session is 400 naming x-clh-session`
  - `PUT stores and GET returns settings and effective models`
  - `PUT with params is 400 with the stage 2 reason and leaves settings unchanged`
  - `closing the session clears its settings`
  - `PUT by a non-admin is 403 and leaves settings unchanged`
  - `GET by a non-admin returns settings with canEdit false`
  - `/v1/models includes _meta.capabilities for the allowlist`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/session-models-handler.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Resolve the user and session exactly as `POST /v1/session` and `srv/session-id.ts` do.
  - Use channel `chat` and `paramsEnabled: false`.

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): session models API and model capabilities"`

### Task 5: Sticky role headers on the OpenAI and Anthropic APIs

**Files:**
- Create: `srv/lib/role-model-headers.ts`
- Modify:
  - `srv/openai-handler.ts`: request entry near :449 and model resolution near :667;
  - `srv/anthropic-handler.ts`: near :197 and :374.
- Test: `test/unit/role-model-headers.test.ts`; extend `test/unit/anthropic-channel.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 3, 4 (same validator, same store).
- Produces:
  - Header names: `x-clh-model-coordinator`, `x-clh-model-planner`, `x-clh-model-executor`, `x-clh-model-checker`, `x-clh-params-<role>` (JSON), `x-clh-limits` (JSON `ExecutionLimitsInput`, merged field by field, sticky like the model headers).
  - `readRoleModelHeaders(headers: IncomingHttpHeaders): Result<RoleModelSettingsInput | undefined, RoleSettingsError>`. It returns `undefined` when no role header is present.
  - The response header `x-clh-models-effective` carries JSON `Record<RoleName, string | null>`, made printable with `ignoredModelHeader`.

- [ ] **Step 1: Write the failing tests**
  - `role headers update the session settings and persist across a later request without headers`
  - `x-clh-model-coordinator wins over body model`
  - `body model still selects the coordinator when no header is sent, and x-clh-model-ignored stays for a non-allowlisted body model`
  - `an invalid role header fails the request with 400 naming the header and leaves settings unchanged`
  - `role headers without x-clh-session fail with 400 naming x-clh-session`
  - `x-clh-params-executor is refused with the stage 2 reason`
  - `every response carries x-clh-models-effective`. Cover OpenAI and Anthropic, streaming and non-streaming.
  - `role or limit headers from a non-admin fail with 403 naming the header and store nothing`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/role-model-headers.test.ts test/unit/anthropic-channel.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Read the headers before the dialogue turn.
  - Merge them over the stored settings role by role: a header for one role leaves the other roles as they are. Then validate the merged result and store it.
  - The coordinator header beats the body `model` by putting it into `settings.coordinator`. Task 3 already prefers that over `selectedModel`.

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): sticky role model headers on the chat APIs"`

### Task 6: Agent MCP — session_open models and session_set_models

**Files:**
- Modify:
  - `srv/agent-mcp.ts`: `session_open` near :660 and the tool list near :654–:767;
  - `srv/agent-mcp-orchestration.ts`: run plan and delegate calls inside `withRoleModels`.
- Test: extend `test/unit/agent-mcp-session-tools.test.ts` and `test/unit/agent-mcp-orchestration.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces:
  - `session_open` takes an optional `models: { planner?, executor?, checker? }`, each a `RoleSetting`.
  - A new tool `session_set_models` with arguments `{ session: string, models?: RoleModelSettingsInput, limits?: ExecutionLimitsInput }` returns `{ settings, effective, limits, effectiveLimits }`.
  - `session_open` takes optional `limits` as well.
  - On this channel the `coordinator` entry in `limits` is refused, like the coordinator model.
  - Channel `mcp`, `paramsEnabled: false`.

- [ ] **Step 1: Write the failing tests**
  - `session_open with models stores them for the opened session`
  - `session_set_models replaces them and returns effective models`
  - `a coordinator entry is refused with field "coordinator"`
  - `execute_step runs on the session executor model`
  - `delegate_task to the checker profile runs on the session checker model`
  - `plan_create runs the plan author on the session planner model`
  - `session_set_models is listed on every agent MCP connection`
  - `session_set_models for a session of another user is refused as not found`
  - `session_set_models and session_open models/limits from a user without MCP_Admin are refused with a reason; the tool stays listed`

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npx jest test/unit/agent-mcp-session-tools.test.ts test/unit/agent-mcp-orchestration.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement**
  - Wrap `execute_step` and the orchestration tool handlers in `withRoleModels(getRoleModels(userId, session), …)`.
  - If any of the three paths does not reach the corresponding role, refuse that role on this channel with a reason. Do not accept it without effect, and report it in the task summary.

- [ ] **Step 4: Run the tests to verify they pass**
  Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(models): role models on the agent MCP"`

### Task 7: WebUI LLM window, docs and CHANGELOG

**Files:**
- Modify:
  - `app/chat/webapp/index.html`:
    - toolbar: the `#llm-model-select` near :90 and the read-only PLANNER label near :100;
    - `#rag-manage-btn` near :101;
    - the chat request body near :2195;
  - `docs/usage/` (the page documenting the chat API headers; find it with `grep -rl x-clh-session docs/usage`);
  - `CHANGELOG.md` `[Unreleased]`.
- Test: a Playwright run through the local proxy (`npm run proxy <dest>`), not a VM harness.

**Interfaces:**
- Consumes: the Task 4 endpoints.

- [ ] **Step 1: Implement the window**
  - **Toolbar.** Replace `#llm-model-select` with a button `#llm-settings-btn` labelled `LLM`, placed next to `MANAGE`. Remove the PLANNER label. `CLASSIFIER` and `EMBEDDER` stay.
  - **Modal.** Add `#llm-modal`, built like `#rag-modal` (`openRagPanel` / `closeRagPanel` near :2694–:2712).
  - **Role blocks.** One block per role: a model select with `auto` first, then the parameter fields from `capabilities[model]`. Parameter fields are read-only and show the effective values in stage 1, with each limit's "off" switch disabled.
  - **Open and save.** Opening calls `GET /v1/session/models`; Save calls `PUT`. A 400 shows `reason` next to `field`.
  - **Limits section.** Below the roles, a "Limits" section with one row per limit from `effectiveLimits`. Each row has a number field and an "off" switch, and both are editable in stage 1 for the hub-owned limits. `planStepBudget` is shown disabled.
  - **Without the admin role.** When `canEdit` is false, the same `LLM` button opens the window as information only: every field read-only, no Save, a line saying changes need the `MCP_Admin` role.
  - **Chat request.** It stops sending the toolbar `model`.

- [ ] **Step 2: Playwright check**
  - Open the WebUI through the local proxy.
  - Open the LLM window; set executor to a second allowlisted model; save.
  - Reload the page in the same session: the window shows the setting.
  - Send a chat message: the response header `x-clh-models-effective` names the executor model.
  - Switch `maxIterations` for the executor to "off" and save: the window shows `off` with source `user` after reload.
  - As a user without `MCP_Admin`, open the window: everything is read-only and there is no Save.
  - Expected: all six checks pass. Save screenshots of the window before and after save.

- [ ] **Step 3: Docs and CHANGELOG**
  - Docs: the headers and their sticky rule, `GET`/`PUT /v1/session/models`, the `session_open` `models` argument and `session_set_models`.
  - CHANGELOG, `### Added`, in one entry:
    - per-session models for coordinator, planner, executor and checker;
    - from the WebUI LLM window, the chat API headers and the agent MCP;
    - parameters follow in stage 2.

- [ ] **Step 4: Full verification**
  Run: `npx tsc --noEmit -p .`, `npx biome check --config-path .` on the changed files, `npx jest --maxWorkers=1`.
  Expected: all pass.

- [ ] **Step 5: Commit**
  `git commit -S -m "feat(webui): LLM window for session role models"`
