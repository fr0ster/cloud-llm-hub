# Controller Vehicle Spike — DAG coordinator streaming/notice/traceId findings

Task 1 of `docs/superpowers/plans/2026-07-21-explicit-controller-reviewer.md`. Throwaway test
was `test/unit/_spike-dag.test.ts` (deleted after this doc was recorded — see git history of this
commit for the exact code that produced the observations below).

Fixture: `SmartAgentBuilder({ skipModelValidation: true }).withMainLlm(stubLlm).withDagCoordinator({
planner: FixedEchoPlanner, interpreter: new DagPlanInterpreter(), workers: Map{echo: EchoWorker},
finalizer: SpikeNoticeFinalizer })`. `EchoWorker.run` emits two `onPartial` content deltas
(`'hello '`, `'world'`) and returns `{ output: 'hello world' }`. `SpikeNoticeFinalizer.finalize`
emits one `onPartial` content delta (`'[[NOTICE]]'`) and returns `{ output: input.interpreterOutput }`.
`stubLlm.chat`/`streamChat` both throw if called — never invoked, confirming the DAG coordinator
path bypasses `mainLlm` entirely (only needed to satisfy `.withMainLlm()`'s builder-time
requirement).

## (a) Do onPartial deltas reach the consumer? Are they accumulated in `process`?

**Yes to both, observed directly.**

`streamProcess` yielded, in order:
```
{ok:true, value:{content:'hello '}}
{ok:true, value:{content:'world'}}
{ok:true, value:{content:'[[NOTICE]]'}}
{ok:true, value:{content:'', finishReason:'stop', usage:{...}}}
```
Every `onPartial({kind:'content', delta})` call — from the worker AND from the finalizer — became
its own yielded chunk. The finalizer's own `finalize()` return value (`FinalizerResult.output`) is
**never re-yielded**; the terminal chunk always has `content:''` (confirms Verified fact 4).

`process()` returned:
```json
{"ok":true,"value":{"content":"hello world[[NOTICE]]","iterations":1,"toolCallCount":0,"stopReason":"stop","usage":{...}}}
```
`content` is the exact concatenation of every streamed delta, in emission order — worker's two
deltas then the finalizer's delta. It is NOT derived from `ISubAgentResult.output` or
`FinalizerResult.output` in any way; those return values are effectively discarded for content
purposes (only used internally: `interpreterOutput` feeds `FinalizerInput`, and node outputs feed
downstream dependent nodes via the interpreter's task composition).

**Conclusion for the design:** since the worker already streams its own content via `onPartial`,
`NoticeFinalizer` must emit **notice-only** — never `interpreterOutput + notice` — or the executor's
output will appear twice in both `process()` and `streamProcess()`.

## (b) Duplication when both worker and finalizer emit content?

**Confirmed empirically — yes, exact duplication, no dedup/diffing anywhere in the pipeline.**

A `DuplicatingFinalizer` that emits `` `${input.interpreterOutput}[[NOTICE]]` `` (i.e.
`'hello world[[NOTICE]]'`) instead of just `'[[NOTICE]]'` produced, in `process()`:
```
"hello worldhello world[[NOTICE]]"
```
— `"hello world"` appears twice (once from the worker's own two deltas, once re-emitted by the
finalizer). The coordinator does no deduplication; it is a dumb concatenator of every yielded
chunk. This directly validates Verified fact 4's warning against `PassthroughFinalizer` (which
re-emits `interpreterOutput`) and confirms `NoticeFinalizer.finalize` must emit ONLY the notice
delta via `onPartial`, never the interpreter output.

## (c) Exact shapes: `DagCoordinatorHandlerDeps`, `DagPlan`, `PlanNode`

From `node_modules/@mcp-abap-adt/llm-agent/dist/interfaces/dag-plan.d.ts`:
```ts
interface PlanNode {
  id: string;
  goal: string;
  agent?: string;       // worker name in the `workers` Map — how a node binds to a worker
  dependsOn?: string[];
  needsInput?: boolean;
}
interface DagPlan {
  nodes: PlanNode[];
  objective?: string;
  rationale?: string;
  createdAt: number;    // REQUIRED, no default — FixedExecutorPlanner must set Date.now()
}
```
Binding rule (confirmed by `dag-plan-interpreter.js` `resolveWorker`): if `node.agent` is set, the
worker is looked up by that exact key in the `workers` Map; if omitted AND there is exactly one
worker in the map, that single worker is used; otherwise a `PLAN_INVALID` error is thrown. The
spike used `{ id: 'n1', goal: 'echo something', agent: 'echo' }` against `workers: Map{echo: ...}`
— built and ran successfully.

`IPlanner.plan(input: PlannerInput): Promise<PlannerResult>` where `PlannerResult = { plan: DagPlan;
usage?: LlmUsage }` — `usage` is optional and was omitted by the fixed planner with no ill effect.

`DagCoordinatorHandlerDeps` (from `builder.d.ts` / `dag-coordinator.js` usage) — REQUIRED:
`planner: IPlanner`, `interpreter: IInterpreter<DagPlan, InterpretResult>` (we passed
`new DagPlanInterpreter()` from `@mcp-abap-adt/llm-agent-libs`), `workers: ReadonlyMap<string,
ISubAgent>`. OPTIONAL (all omitted in the spike and `.build()` succeeded, coordinator ran with
documented defaults): `finalizer` (defaults `PassthroughFinalizer`), `errorStrategy` (defaults
`AbortErrorStrategy`), `reviewer` (plan-gate, no default = skipped), `activation`, `stateOracle`,
`maxRoundTrips` (defaults 6 per `dag-coordinator.js`: `Math.max(1, this.deps.maxRoundTrips ?? 6)`).

`SmartAgentBuilder` itself REQUIRES `.withMainLlm(llm)` (throws `'Main LLM is required...'`
otherwise) even though the DAG coordinator path never calls it for generation. Passing
`{ skipModelValidation: true }` to the constructor skips the builder's startup
`llm.chat([...'Reply with OK'...])` liveness probe — with that flag, a stub `ILlm` whose
`chat`/`streamChat` both `throw` is sufficient to `.build()` and run the DAG path; the stub was
never invoked in any of the three test runs (worker's own tool-loop LLM, if any, is a fully
separate concern not exercised by this coordinator-only spike).

## (d) Is `FinalizerInput.trace.traceId` populated, and does it match the `getSummary` key?

**Yes, confirmed by direct capture.** The finalizer captured
`input.trace?.traceId === 'spike-trace-process-1'`, exactly the `traceId` passed into
`agent.process('...', { trace: { traceId: 'spike-trace-process-1' } })`. Calling
`handle.requestLogger.getSummary('spike-trace-process-1')` (same literal string) returned a valid
`RequestSummary` (empty buckets in this spike, since neither the stub LLM nor the echo worker log
anything — no LLM calls, no tool calls happened). This confirms `ctx.requestLogger.getSummary(traceId)`
inside `dag-coordinator.js` uses the SAME key surfaced to the finalizer via `FinalizerInput.trace.traceId`
— they are the same string, sourced from the same `ctx.options?.trace?.traceId` the caller supplied.

Caveat: this spike's `RecordingRequestLogger` stand-in is the BUILDER's default
(`DefaultRequestLogger`, since `withRequestLogger` was not called) — it exists only to prove the key
identity, not the per-trace bucket semantics (those are Task 2's subject, already documented as
`DefaultRequestLogger` CLEARS on `startRequest` and ignores `requestId`, hence why Task 2 replaces it).

## (e) `logToolCall` requestId + `withRequestLogger` injection

**Confirmed by direct grep** of
`node_modules/@mcp-abap-adt/llm-agent-libs/dist/pipeline/handlers/tool-loop.js:734-741`:
```js
ctx.requestLogger.logToolCall({
    // Stamp requestId so tool executions land in the per-traceId delta
    // bucket — without it, `getSummary(traceId).toolCalls` stays 0 even
    // when the request actually ran tools (only the session-cumulative
    // counter would tick).
    requestId: ctx.options?.trace?.traceId,
    toolName: tc.name,
    success: !!res?.ok,
    durationMs: r.duration,
    cached: r.cached,
});
```
`requestId` is stamped from `ctx.options?.trace?.traceId` — matches the plan's Verified fact
exactly (also true for `logLlmCall` at `tool-loop.js:431` with the same `requestId:
ctx.options?.trace?.traceId` pattern, and at `:305` for `traceId: ctx.options?.trace?.traceId ??
'tool-loop'` used in a sessionLogger step name).

`ctx.requestLogger` is whatever `IRequestLogger` was set via `.withRequestLogger(logger)` on the
SmartAgent that OWNS that tool-loop pipeline stage (confirmed by reading `builder.js:601`:
`const requestLogger = this._requestLogger ?? new DefaultRequestLogger();` — the builder wires
whichever logger instance was injected, or a fresh `DefaultRequestLogger` if none was). This spike
did not build a tool-loop `SmartAgent` worker (out of scope — the echo worker is a bespoke
`ISubAgent`, not a tool-loop pipeline), so it did not directly exercise a real `logToolCall`
invocation end-to-end; the grep + the `builder.js:601` wiring together establish that an injected
`RecordingRequestLogger` WILL receive those calls, because `ctx.requestLogger` is exactly the
injected instance. Task 7's own test (`buildExecutorWorker` + `RecordingRequestLogger`) is the
right place to exercise this live with a real tool-loop worker.

## Decision: finalizer emission strategy

**`NoticeFinalizer` MUST emit notice-ONLY** via `onPartial` (never `interpreterOutput + notice`).
The worker already streams its full content through its own `onPartial` calls (forwarded live by
the DAG coordinator/interpreter to both `process()`'s accumulation and `streamProcess()`'s chunk
sequence); re-emitting the interpreter output from the finalizer duplicates it verbatim in both
APIs, empirically confirmed in section (b). This finalizes the choice noted as an open question in
the plan's Verified fact 4 and Task 8's interface spec.

## Blockers encountered

None. The spike built and ran without any live AI Core / SAP credentials — `skipModelValidation:
true` plus a throwing stub `ILlm` was sufficient because the DAG coordinator path never calls
`mainLlm.chat`/`streamChat` (only a genuine tool-loop worker, not exercised here, would need a real
or mocked LLM — out of scope for Task 1). All (a)-(e) were answered with direct, reproducible
observations from `npx jest test/unit/_spike-dag.test.ts` (3/3 passing) before the throwaway test
was deleted.
