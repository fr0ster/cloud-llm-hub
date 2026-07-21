# Explicit Controller + Executor/Reviewer via DAG Coordinator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize an explicit **Controller** inside the agent (not bolted onto the `execute_step` MCP tool) so every channel (`execute_step`, `/v1/chat`, `/v1/messages`) gets the same honesty guard: the **Executor** streams live, then a **Reviewer** compares its claims against the *executed ABAP tools* and, on a false claim, an explicit **notice** is appended and the run **stops safely** (ADT locks always released).

**Architecture (all wiring VERIFIED against `node_modules`, see "Verified library facts"):** Build it AS THE PIPELINE on imported `@mcp-abap-adt/llm-agent` interfaces, using the **DAG coordinator** (`SmartAgentBuilder.withDagCoordinator`), because it forwards a worker's `onPartial` content deltas to the client stream LIVE — the simple `withCoordinator` cannot (it prefixes `### stepId` and emits a single chunk). Pieces:
- `FixedExecutorPlanner implements IPlanner` → a fixed 1-node DAG (`executor`). No planner LLM. (When the real planner lands in llm-agent, swap this.)
- `ExecutorWorker implements ISubAgent` → wraps a **separate** tool-loop `SmartAgent` (built WITHOUT a coordinator — avoids `coordinator→executor→same coordinator` recursion). Streams content via `onPartial`.
- `NoticeFinalizer implements IFinalizer` → after execution, reads the executor output + the **executed tool names** (from the recording logger, keyed by `traceId`), runs the Reviewer, and emits **only the notice** via `onPartial` (the executor content was already streamed → no duplication, no re-emit).
- `ReviewerCore` (pure) → deterministic per-operation check (claimed op vs executed `Activate*`/`Create*`…) + a token-gated LLM critic. Exposed BOTH as a pure module (used by `NoticeFinalizer` now) AND as `ReviewerSubAgent implements ISubAgent` (portable to the future coordinator).
- `RecordingRequestLogger implements IRequestLogger` → a self-contained per-trace logger (cumulative + per-`requestId` deltas) that also captures executed `toolName`s per `traceId`. Injected via `withRequestLogger`.

**Tech Stack:** TypeScript (CommonJS), `@sap/cds` v9, `@mcp-abap-adt/{llm-agent,llm-agent-libs}`, Jest, Biome (single quotes, 2-space, 100-col).

## Global Constraints

- Program against **imported** llm-agent interfaces only: `ISubAgent`/`ISubAgentInput`/`ISubAgentResult`, `IPlanner`/`PlannerInput`/`PlannerResult`, `IFinalizer`/`FinalizerInput`/`FinalizerResult`, `DagPlan`/`PlanNode`, `IRequestLogger`/`ToolCallEntry`, `IErrorStrategy`. No bespoke shapes duplicating them.
- **Notice rides the SUCCESS path only.** NEVER signal a problem via `errorClass:'epicfail'` or a failed step — both discard output before final assembly (see Verified facts). The notice is emitted by `NoticeFinalizer.onPartial`.
- Executor = LLM tool-loop, behavior unchanged. Reviewer = deterministic; only its gated layer calls an LLM (`totalTokens < threshold`).
- Reaction is **notify + safe-stop**, never retry/replan (interim, until the planner lands). Consumer decides next.
- **Safe-stop on every exit path** (normal / reviewer-stop / client abort-disconnect): `connection.closeSession()` → release ADT edit-locks, then reset. Never orphan locked/inactive objects.
- Ground truth = executed **internal** ABAP tool names from `RecordingRequestLogger` keyed by `traceId`; write-tool universe from the startup MCP collection (`Create*/Update*/Delete*/Activate*` = write).
- Streaming: executor worker streams content via `onPartial` (live); `NoticeFinalizer` appends the notice as a trailing `onPartial` content delta. Non-stream (`process`) accumulates the same yielded chunks. NO content re-emit (would duplicate).
- All artifacts English; Biome clean; `npm run test:check` + `npm run test:unit` green.
- E2E only on **staging** (`:3006` proxy) against **self-created, non-shared** objects. NEVER touch `TEST_MCP_SHR_PKG`/`TEST_ADT_SHR_PKG`/`*AC_SHR`.

## Reuse audit (take llm-agent implementations first; custom ONLY where none fits)

**REUSE (import, do not reimplement):** `DagPlanInterpreter` (required `interpreter` dep), `AbortErrorStrategy` (default `errorStrategy`), `SmartAgentSubAgent` (executor wrap — via `withSubAgent`, unless the Task 1 spike shows `onPartial` isn't forwarded), `NoopReviewStrategy` (leave the plan-gate a no-op).

**CUSTOM (justified — audited, nothing existing fits):**
- `FixedExecutorPlanner` — `LlmDagPlanner` is LLM-driven; `SkillStepsPlanning` needs a structured skill; `ReplanOnErrorPlanning` wraps a delegate. None yields a fixed non-LLM single-node DAG.
- `RecordingRequestLogger` — a **self-contained per-trace `IRequestLogger`** (NOT a thin decorator). `DefaultRequestLogger` (the builder default) is FLAT: `startRequest` ignores `requestId` and CLEARS the arrays, so the nested controller→worker `startRequest(traceId)` would wipe telemetry and parallel requests would mix. `SessionRequestLogger` HAS the correct nested-safe per-`requestId` semantics but is **NOT exported** from the package (deep-import is fragile). So we re-implement those semantics (per-`requestId` buckets; depth-counted `startRequest` that NEVER clears; `dropRequest` deletes) AND add executed tool-NAME capture (no logger exposes names — `getSummary` gives only a count).
- `NoticeFinalizer` — `Passthrough/Template/Llm` finalizers cannot emit a conditional notice from a tool-trace review.
- `ReviewerCore` (+ `ReviewerSubAgent`) — domain honesty logic; nothing equivalent exists.

## Verified library facts (binding — do not re-derive, do not contradict)

1. **Simple `withCoordinator` is unusable for us** — `coordinator.js:174` joins step outputs as `### ${stepId}\n${output}` and `:207` yields the whole thing as ONE chunk. Breaks verbatim output + live streaming.
2. **`epicfail`/failed step lose the notice** — `coordinator/dispatch/subagent.js:72-84` returns `output:''` on `epicfail`; `coordinator.js:139` / `:159` set `ctx.error` + `return false` BEFORE final assembly. So the reviewer must return a SUCCESSFUL result.
3. **DAG coordinator streams worker `onPartial` LIVE** — `dag-coordinator.js:215` `onPartial = (chunk) => chunk.kind==='content' && ctx.yield({value:{content: chunk.delta}})`; `dag-plan-interpreter.js:41-47` passes it into `worker.run({..., onPartial})`.
4. **After `finalize`, the coordinator does NOT re-yield the finalizer output** — `dag-coordinator.js:275` yields only `{content:'', finishReason:'stop'}`. So ALL content comes from `onPartial`. `PassthroughFinalizer` (`passthrough-finalizer.js:9`) re-emits `interpreterOutput` → would DUPLICATE if the worker already streamed → use a CUSTOM finalizer that emits only the notice.
5. **`withDagCoordinator(deps: DagCoordinatorHandlerDeps)`** REQUIRES three deps: `planner: IPlanner`, **`interpreter: IInterpreter<DagPlan, InterpretResult>`**, `workers: ReadonlyMap<string,ISubAgent>`. Optional: `finalizer?: IFinalizer` (defaults to `PassthroughFinalizer`), `errorStrategy?` (defaults `AbortErrorStrategy`), `reviewer?: IReviewStrategy` (a PLAN gate — NOT our honesty reviewer; leave unset), `activation?`, `stateOracle?`, `maxRoundTrips?`. **`DagPlanInterpreter` is exported from `@mcp-abap-adt/llm-agent-libs`** (`index.d.ts:14`) — pass `interpreter: new DagPlanInterpreter()`.
6. **Ground-truth key is `traceId`** — `dag-coordinator.js:272` reads `ctx.requestLogger.getSummary(traceId)`; `FinalizerInput.trace.traceId` is available to the finalizer.
7. **`IRequestLogger` full surface** (`request-logger.d.ts`): `logLlmCall, logRagQuery, logToolCall, startRequest, endRequest, dropRequest, getSummary, reset`; requestId-scoped buckets (nested-safe; `dropRequest` frees). `logToolCall(entry: ToolCallEntry & {requestId?})`, `ToolCallEntry.toolName`. `RequestSummary` exposes `byModel/byComponent/byCategory: Record<string,TokenBucket{totalTokens}>` and `toolCalls: number` — so **`totalTokens` = sum of `getSummary(traceId).byModel[*].totalTokens`**, `toolCallCount = getSummary(traceId).toolCalls`.
8. **`SmartAgentResponse.toolCalls` = EXTERNAL tools only** — internal ABAP tools (`CreateDomain`…) never appear there; they are recorded via `logToolCall`. Hence the recording logger, not `response.toolCalls`, and not prose parsing.
9. **`SmartAgentSubAgent.run` does NOT forward a requestLogger to the wrapped worker** (`smart-agent-subagent.js`: it passes only `{sessionId,signal,trace,sessionLogger,onPartial}` into `this.agent.process`). The worker logs its internal ABAP tools to the logger IT was BUILT with. **Therefore `RecordingRequestLogger` must be injected (via `withRequestLogger`) into the EXECUTOR WORKER build, and the SAME instance handed to `NoticeFinalizer`.** Injecting it only into the controller → finalizer sees zero tools → false-positive guard on every write. Task 1 must also confirm the worker's `logToolCall` carries `requestId===traceId` (needed for concurrency isolation); if it does not, scope the worker run with `startRequest(traceId)`/`endRequest(traceId)`.
10. **Per-trace telemetry lifecycle.** `agent.js:412/731` brackets each `process()` with `startRequest(traceId)`/`endRequest(traceId)` — in controller→worker BOTH nest with the SAME `traceId`. `DefaultRequestLogger` (builder default, `builder.js:601`) CLEARS its arrays on `startRequest` and ignores `requestId` → nested worker call wipes telemetry + parallel requests mix. `SessionRequestLogger` is nested-safe (depth-counted, never clears, `dropRequest` deletes) but is NOT exported. tool-loop stamps `requestId = ctx.options?.trace?.traceId` on BOTH `logToolCall`(`:739`) and `logLlmCall`(`:431`). **Nobody calls `dropRequest`** in agent/pipeline — the consuming server must, or buckets leak. ⇒ `RecordingRequestLogger` owns per-`requestId` buckets; the channel handlers set a unique `trace.traceId` per request AND call `recLogger.dropRequest(traceId)` in `finally`.

---

### Task 1: Vehicle spike — prove DAG streaming + notice + no duplication (findings only, minimal throwaway code)

**Files:**
- Create: `docs/superpowers/specs/controller-vehicle-spike.md` (delete after Task 12)
- Create (throwaway, deleted at end of task): `test/unit/_spike-dag.test.ts`

**Why:** the whole design hinges on library behaviors that must be observed, not assumed (the previous plan revision was rejected for assuming them).

- [ ] **Step 1: Minimal DAG proof.** In a throwaway Jest test, build a `SmartAgentBuilder` with `withDagCoordinator({ planner: <fixed 1-node>, interpreter: new DagPlanInterpreter(), workers: Map{echo: <ISubAgent that emits two content deltas via input.onPartial and returns their concat>}, finalizer: <emits "[[NOTICE]]" via input.onPartial, returns {output: interpreterOutput}> })` — the REQUIRED `interpreter` dep (Verified fact 5) must be present or the build fails. Run BOTH `agent.process(...)` and consume `agent.streamProcess(...)`.
- [ ] **Step 2: Record answers to the load-bearing questions** in the findings doc:
  (a) Do the echo worker's `onPartial` deltas reach the consumer in `streamProcess`? In `process` (accumulated)? — decides whether `NoticeFinalizer` emits notice-only (worker streams content) or must emit `interpreterOutput+notice` (worker does not).
  (b) Is there duplication when both worker and finalizer emit?
  (c) Exact `DagCoordinatorHandlerDeps` object shape and the minimal `IPlanner` returning a 1-node `DagPlan` (record the `DagPlan`/`PlanNode` fields actually required).
  (d) Confirm `FinalizerInput.trace.traceId` is populated and equals the key used by `ctx.requestLogger.getSummary(traceId)`.
  (e) Confirm `withRequestLogger` injects a logger whose `logToolCall` is invoked for each internal ABAP tool (grep the tool-loop dispatch).
- [ ] **Step 3:** Delete `_spike-dag.test.ts`; commit the findings doc (`docs(controller): DAG vehicle spike — streaming/notice/traceId pinned`).

**Interfaces produced:** the finalizer emission strategy (notice-only vs full), the exact deps/planner shapes, and the traceId hand-off — Tasks 2/7/8/9/10 cite these.

---

### Task 2: `RecordingRequestLogger` — self-contained per-trace IRequestLogger

**Files:** Create `srv/lib/recording-request-logger.ts`; Test `test/unit/recording-request-logger.test.ts`

**Interfaces:**
- Consumes: `IRequestLogger`, `ToolCallEntry`, `LlmCallEntry`, `RequestSummary`, `TokenBucket` (imported).
- Produces: `class RecordingRequestLogger implements IRequestLogger` with a **session-cumulative bucket AND per-`requestId` delta buckets** (mirror `SessionRequestLogger` exactly), plus `executedToolNames(requestId?: string): string[]`. Model: a `cumulative` bucket + `deltas: Map<requestId, bucket>` + `depth: Map<requestId, number>`, where each bucket holds `{ llm: LlmCallEntry[]; toolNames: string[]; ragCount: number }`. **Every `logLlmCall`/`logToolCall`/`logRagQuery` ALWAYS writes to `cumulative`, AND additionally to `deltaFor(entry.requestId)` when `entry.requestId` is present** (`deltaFor` get-or-creates — a nested worker call may arrive before `startRequest`). `startRequest(id)` depth++ and creates the delta ONLY if absent (NEVER clears); `endRequest(id)` depth--; `dropRequest(id)` deletes ONLY that delta + depth (cumulative untouched — `/v1/usage` needs the session total); `getSummary(id)` aggregates the delta, `getSummary()` (no id) aggregates `cumulative`, into a `RequestSummary` (`byModel[*].totalTokens`, `toolCalls`); `executedToolNames(id)` → delta names, `executedToolNames()` → cumulative names; `reset()` clears everything.

- [ ] **Step 1: Failing tests (the exact failure modes DefaultRequestLogger has).** (a) `startRequest(t1)`, log tools, nested `startRequest(t1)` again, log more, `endRequest(t1)` → the FIRST batch is NOT wiped (nested-safe); (b) two requestIds `t1`/`t2` stay isolated in `executedToolNames` and `getSummary`; (c) `dropRequest(t1)` frees it (`executedToolNames(t1)===[]`, bucket gone); (d) `getSummary(t1)` reflects only t1's tokens (`byModel` totals) + toolCalls count; (e) **cumulative vs delta**: after logging under `t1`, `getSummary()` (no id) ≥ `getSummary(t1)` (cumulative includes it), and after `dropRequest(t1)` the cumulative total is UNCHANGED while `getSummary(t1)` is empty; (f) a call with undefined `requestId` accrues to cumulative only. Assert against the 8-method surface directly (no fake delegate — it IS the logger).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the self-contained per-trace logger.
- [ ] **Step 4: Run, verify pass.**  **Step 5: Commit** (`feat(controller): self-contained per-trace recording request-logger`).

---

### Task 3: Per-operation write classification

**Files:** Modify `srv/lib/write-guardrail.ts`; Test `test/unit/write-guardrail.test.ts`

**Interfaces:** Produces `type WriteOp='created'|'updated'|'deleted'|'activated'`; `claimedWriteOps(content): WriteOp[]` (EN+RU/UK, reuse CLAIM_PATTERNS); `opSatisfiedByTools(op, tools): boolean` (`activated`↔`/^(?:Handler)?Activate/`, `created`↔`/^(?:Handler)?Create/`, `updated`↔`Update`, `deleted`↔`Delete`).

- [ ] **Step 1: Failing test** — "created and activated" → `['created','activated']`; `opSatisfiedByTools('activated', ['CreateDomain'])===false`; `('activated',['ActivateDomain'])===true`; `('created',['CreateDomain'])===true`.
- [ ] **Step 2: fail.** **Step 3: implement.** **Step 4: pass.** **Step 5: commit** (`feat(controller): per-operation write-claim vs tool matching`).

---

### Task 4: `ReviewerCore.evaluateDeterministic` (pure verdict)

**Files:** Create `srv/lib/reviewer-core.ts`; Test `test/unit/reviewer-core.test.ts`

**Interfaces:** Produces `type ReviewIssue={kind:'unverified-write';claimedOp:WriteOp;expectedToolFamily:string;observedTools:string[]}`; `type ReviewVerdict={ok:true}|{ok:false;issues:ReviewIssue[]}`; `evaluateDeterministic(content:string, executedTools:string[]):ReviewVerdict`.

- [ ] **Step 1: Failing test** — claims created+activated, tools `['CreateDomain','ReadDomain']` → `ok:false` one issue (`activated`); both tools present → `ok:true`; honest refusal ("could not create") → `ok:true`.
- [ ] **Step 2: fail.** **Step 3: implement** (uses Task 3). **Step 4: pass.** **Step 5: commit** (`feat(controller): deterministic reviewer verdict`).

---

### Task 5: Token-gated LLM critic layer

**Files:** Modify `srv/lib/step-gate.ts`, `srv/lib/step-reviewer.ts`; Test `test/unit/step-reviewer.test.ts`

**Interfaces:** Produces `evaluateGated(input:{content;executedTools;totalTokens;toolCallCount;llm}):Promise<ReviewVerdict>` — deterministic first; LLM critic only when `totalTokens<minTokens || toolCallCount<=maxToolCalls`; fail-open on timeout/throw; merges any `unsupported-claim` issues.

- [ ] **Step 1: Failing test** — tokens above threshold → critic NOT called (spy 0), verdict = deterministic; below → called; critic throws/timeouts → verdict unchanged (no false problem).
- [ ] **Step 2: fail.** **Step 3: implement** (reuse existing gate + reviewStep). **Step 4: pass.** **Step 5: commit** (`feat(controller): token-gated LLM critic feeds verdict`).

---

### Task 6: `ReviewerSubAgent implements ISubAgent` (portable form)

**Files:** Create `srv/lib/reviewer-subagent.ts`; Test `test/unit/reviewer-subagent.test.ts`

**Interfaces:** Consumes `ISubAgent` + Task 4/5. Produces `class ReviewerSubAgent implements ISubAgent` (`name='reviewer'`, `capabilities={contextPolicy:'optional'}`) whose `run` returns `ISubAgentResult` with `output` = passed content and `metadata.verdict`. **Never sets `errorClass:'epicfail'`** (Verified fact 2). This class is the future coordinator worker; the interim path calls the same core via `NoticeFinalizer`.

- [ ] **Step 1: Failing test** — false-activation input → `metadata.verdict.ok===false`, no `errorClass`; clean → `verdict.ok===true`.
- [ ] **Step 2: fail.** **Step 3: implement** (thin over reviewer-core). **Step 4: pass.** **Step 5: commit** (`feat(controller): ReviewerSubAgent (portable, no epicfail)`).

---

### Task 7: Coordinator-less executor worker (REUSE `SmartAgentSubAgent`) with the SHARED recording logger

**Files:** Modify `srv/agent-manager.ts` (add a worker build path); Test `test/unit/executor-worker.test.ts`

**Interfaces:** Produces `buildExecutorWorker(mcpAdapter: McpClientAdapter, toolsRag: ExpositionFilteringRag, config: AgentConfig, recLogger: IRequestLogger): Promise<ISubAgent>`. It is **the current `buildAgentForDestination(mcpAdapter, toolsRag, config)` body MINUS the coordinator** — behavior-preserving: SAME `mainLlm`/`classifierLlm` (via `getOrCreateSharedLlms`), SAME `toolsRag`/`mcpAdapter`/`skillsPool`/`embedder`, SAME prompts and tool-loop knobs (`maxIterations`, `toolReselectPerIteration`, `ragQueryK`, `classificationEnabled:false`, `FallbackLlmCallStrategy`, `ToolCache`, `SessionManager`, `ClineClientAdapter`, `withHistorySummarization`). The ONLY additions vs today: `.withRequestLogger(recLogger)` (so internal ABAP tools land in the shared logger — Verified fact 9) and NO coordinator. Refactor: extract the shared builder setup so both this worker and (if ever needed) the old path stay DRY. Wrap the built `SmartAgent` as `ISubAgent` by **reusing `SmartAgentSubAgent`** (`new SmartAgentSubAgent('executor', workerAgent)`). Only write a custom `ExecutorWorker` if the Task 1 spike proves `onPartial` is dropped through `SmartAgentSubAgent`. Worker has no coordinator → no self-recursion.

- [ ] **Step 1: Failing test** — build the worker with a fake tool-loop SmartAgent + a `RecordingRequestLogger`; assert `run({task,trace})` returns its output, forwards `onPartial` (per spike), and that a tool call inside the worker is captured by the shared recLogger under the run's `traceId`.
- [ ] **Step 2: fail.** **Step 3: implement** the separate worker build with `withRequestLogger(recLogger)`, wrapped via `SmartAgentSubAgent`. **Step 4: pass.** **Step 5: commit** (`feat(controller): coordinator-less executor worker sharing the recording logger`).

---

### Task 8: `NoticeFinalizer implements IFinalizer` (reviewer + trailing notice, no duplication)

**Files:** Create `srv/lib/notice-finalizer.ts`, `srv/lib/notify-policy.ts`; Test `test/unit/notice-finalizer.test.ts`

**Interfaces:** Consumes `IFinalizer`/`FinalizerInput`/`FinalizerResult`, `RecordingRequestLogger` (Task 2), reviewer-core (Task 4/5). Produces `class NoticeFinalizer implements IFinalizer` (holds a ref to the SAME RecordingRequestLogger injected into the worker + a critic LLM). `finalize(input)`: let `t = input.trace?.traceId`; `tools = logger.executedToolNames(t)`; `s = logger.getSummary(t)`; `totalTokens = Σ s.byModel[*].totalTokens`; `toolCallCount = s.toolCalls` (Verified fact 7); `verdict = await evaluateGated({ content: input.interpreterOutput, executedTools: tools, totalTokens, toolCallCount, llm: criticLlm })`; if `!verdict.ok` emit `input.onPartial({kind:'content', delta: renderNotice(verdict)})` — per the spike's strategy (notice-only if the worker streamed content; else `interpreterOutput+notice`). **`channel` is NOT available in `FinalizerInput`** (fields: prompt, objective, ancestorContext, interpreterOutput, executionTrace, sessionId, signal, trace, onPartial) — so `renderNotice(verdict)` is **channel-neutral**: one canonical notice beginning with the stable ASCII machine-parseable marker **`UNVERIFIED_WRITE:`** (exact token — no emoji/spaces in the marker so consumers can grep it reliably), followed by a human-readable explanation. Any per-channel reformatting is a handler-layer concern, deferred (out of scope here).

- [ ] **Step 1: Failing tests** — (a) recording logger seeded `['CreateDomain']` for traceId `t1`, output claims activation, LOW tokens → `onPartial` notice names claimed op + missing family; (b) clean case (both tools) → no notice; (c) **threshold test**: HIGH `totalTokens` (from seeded `byModel`) → deterministic-only path still fires on the write mismatch, LLM critic NOT called; (d) no content duplication per the spike's strategy.
- [ ] **Step 2: fail.** **Step 3: implement.** **Step 4: pass.** **Step 5: commit** (`feat(controller): NoticeFinalizer surfaces reviewer notice on the success path`).

---

### Task 9: `FixedExecutorPlanner implements IPlanner` (1-node DAG)

**Files:** Create `srv/lib/fixed-executor-planner.ts`; Test `test/unit/fixed-executor-planner.test.ts`

**Interfaces:** Consumes `IPlanner`/`PlannerInput`/`PlannerResult`/`DagPlan` (shapes pinned in Task 1). Produces a planner returning a single `executor` node DAG, no LLM, `usage` omitted. `DagPlan` REQUIRES `createdAt: number` (Verified fact — set `createdAt: Date.now()`), plus the `nodes` array and any other required fields pinned in Task 1.

- [ ] **Step 1: Failing test** — `plan({prompt,agents,sessionId})` → a `DagPlan` with exactly one node bound to worker `executor`, **`typeof plan.createdAt === 'number'`**, deterministic, no LLM call.
- [ ] **Step 2: fail.** **Step 3: implement** (exact `DagPlan`/`PlanNode` fields from Task 1, incl. `createdAt`). **Step 4: pass.** **Step 5: commit** (`feat(controller): fixed 1-node executor planner`).

---

### Task 10: Wire the DAG coordinator into the built agent

**Files:** Modify `srv/agent-manager.ts` (`buildAgentForDestination` ONLY — see LLM-only note); Test `test/unit/agent-controller-wiring.test.ts`

**LLM-only path stays unchanged:** `buildLlmOnlyAgent` has NO `mcpAdapter`/`toolsRag` → no ABAP tools → no write claims to verify → do NOT wire the controller there. Only `buildAgentForDestination` (destinations with real ABAP tools) gets the DAG controller.

**Interfaces:** Consumes Tasks 2/7/8/9. Wire, IN THIS ORDER (the SAME `recLogger` instance must reach the worker AND the finalizer — Verified fact 9):
```
const recLogger = new RecordingRequestLogger();              // self-contained per-trace logger (Task 2) — DefaultRequestLogger would wipe on nested startRequest (fact 10)
const executorWorker = buildExecutorWorker(mcpAdapter, toolsRag, config, recLogger); // Task 7 — worker built WITH recLogger
builder
  .withRequestLogger(recLogger)                               // controller also uses the SAME instance
  .withDagCoordinator({
    planner: new FixedExecutorPlanner(),
    interpreter: new DagPlanInterpreter(),                    // REQUIRED dep (Verified fact 5)
    workers: new Map([['executor', executorWorker]]),
    finalizer: new NoticeFinalizer(recLogger, criticLlm),     // reads the SAME recLogger
    // errorStrategy omitted → AbortErrorStrategy default; reviewer omitted → no plan-gate
  });
```
The top-level built agent is the Controller; the worker is coordinator-less. `DagPlanInterpreter` (+ default `AbortErrorStrategy`) imported from `@mcp-abap-adt/llm-agent-libs` (reuse). **The channel handlers must supply a unique `trace.traceId` per request** (Task 11) so per-trace bucketing + `getSummary(traceId)` key correctly; without it everything collapses into the default bucket and concurrent requests mix.

- [ ] **Step 1: Failing test** — the pipeline diagnostic shows the DAG coordinator stage; a run with a stubbed worker (claims activation, and whose tool call is captured by `recLogger` under the run's traceId with create-only) yields executor content followed by the notice, in BOTH `process` and `streamProcess`.
- [ ] **Step 2: fail.** **Step 3: implement wiring** in `buildAgentForDestination` ONLY (NOT `buildLlmOnlyAgent` — see the LLM-only note above). **Step 4:** `npm run test:unit` + `npm run test:check` green. **Step 5: commit** (`feat(controller): DAG coordinator wires executor+reviewer into the agent`).

---

### Task 11: Safe-stop + per-request telemetry lifecycle on every exit path

**Files:** Modify `srv/lib/request-connection.ts`, `srv/agent-mcp.ts`, `srv/openai-handler.ts`, `srv/anthropic-handler.ts`, `srv/agent-manager.ts` (expose the agent's `recLogger` on the handle); Test `test/unit/safe-stop.test.ts`

**Interfaces:** Produces `safeStop(connection?):Promise<void>` — idempotent, never throws, `closeSession()` then `reset()`. Also each channel handler MUST: (1) generate a **unique `traceId` per request** and pass it as `agentOpts.trace.traceId` (Verified fact 10 — required for per-trace bucketing + the finalizer's `getSummary(traceId)`); (2) in the SAME `finally` that runs `safeStop`, call `handle.recLogger?.dropRequest(traceId)` (nobody else calls `dropRequest` → otherwise the bucket leaks per request). Wire `safeStop` into `finally` on all three channels AND the client abort/disconnect listener (`req.on('close')` / `AbortSignal`).

- [ ] **Step 1: Failing tests** — `safeStop`: closeSession then reset; throwing closeSession swallowed, reset still runs; idempotent. Lifecycle: after a run, `recLogger.executedToolNames(traceId)` is empty (dropped); two concurrent traceIds don't cross-contaminate.
- [ ] **Step 2: fail.** **Step 3: implement** `safeStop` + abort/disconnect wiring + per-request `traceId` generation + `dropRequest(traceId)` in `finally`; expose `recLogger` on the handle. **Step 4: pass.** **Step 5: commit** (`feat(controller): safe-stop + per-request telemetry lifecycle on all exit paths`).

---

### Task 12: Retire the execute_step-only wrapper; cleanup + e2e

**Files:** Modify `srv/agent-mcp.ts` (remove `assembleReviewedResponse`), confirm `srv/openai-handler.ts`/`srv/anthropic-handler.ts` inherit the guard; Delete the spike/vehicle docs and this plan at the very end.

- [ ] **Step 1:** Remove the execute_step-only reviewer wiring; execute_step returns the coordinator's finalized output verbatim (notice already embedded).
- [ ] **Step 2:** Full `npm run test:unit` + `npm run test:check` + `npm run lint:check` green.
- [ ] **Step 3: E2E on STAGING (`:3006`) against self-created non-shared objects:** (1) execute_step "create+activate" where executor only creates → notice present; read-back (raw `/mcp/stream/http`) shows the object state; safe-stop leaves NO lock. (2) `/v1/chat` non-stream → notice appended. (3) `/v1/chat` stream → live executor tokens + trailing notice chunk. (4) honest refusal → NOT flagged. (5) clean create+activate → no notice. (6) client abort mid-flight → `safeStop` releases the lock.
- [ ] **Step 4:** Delete spike docs + this plan. **Commit** (`refactor(controller): retire execute_step-only reviewer; DAG coordinator is the single guard`).
