# Response token usage — design

## Intent

Every hub answer tells the client how many tokens it cost. A direct executor run (agent MCP
`execute_step`) reports the executor's own usage. An answer produced by the dialogue planner
(OpenAI-compatible API, WebUI, Anthropic-compatible API) reports the total and a breakdown: the
planner's own usage and the usage of each subagent task.

Source of the numbers: the llm-agent contracts (llm-agent ≥ 30.14.0, llm-agent-libs ≥ 30.12.0):
`ISubAgentResult.usage: TokenUsage`, `TaskRecord.usage`, `PlannerMessage.usage = { planner?, tasks? }`,
`PlannerAgent.process` result `usage?`. The numbers do not depend on `LLM_AGENT_USAGE` (usage
recording may be off).

## Wire format

`TokenUsage` maps to OpenAI-style fields:

```ts
interface WireTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  models?: Record<string, { prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number }>;
}
type WireAgentUsage = WireTokens & { duration_ms?: number };
interface HubUsageBreakdown {
  duration_ms?: number;
  planner?: WireAgentUsage | { duration_ms: number };
  subagents?: Array<WireAgentUsage & { task_id: string; worker: string }>;
}
```

Durations are optional milliseconds (llm-agent >= 30.16.0 / libs >= 30.14.0).
Planner duration sums planner turns, including corrective calls and excluding queue wait.
Subagent duration is its running time (`finishedAt - startedAt`); repeated task reports use
the maximum duration. Request `x_hub.duration_ms` is hub wall clock from request start to
final usage assembly, including queue wait and follow. Event messages have no request total.
Parts do not add up to the total because tasks run in parallel and turns have gaps.
Unknown durations are omitted. A known planner duration is emitted even without planner tokens,
as a duration-only planner entry; token totals remain unchanged. WebUI omits duration-only
planner entries from the token breakdown and displays their TIME in m:ss or h:mm:ss.

- **OpenAI / WebUI** (`/v1/chat/completions`): `usage = { prompt_tokens, completion_tokens,
  total_tokens, x_hub: HubUsageBreakdown }`; totals = planner + all subagents of the planner messages
  this response delivers.
  - Streaming: one usage chunk (`choices: []`) after the last delivered message (follow included),
    before `data: [DONE]`. Sent whenever any usage is known (the WebUI always sets
    `stream_options.include_usage`; keep the existing non-gated behaviour of the handler).
  - Non-streaming: in the response body for the messages the body contains.
  - Messages delivered later by id (delivery endpoint) carry their own `usage` in the same shape.
- **Anthropic** (`/v1/messages`): `usage.input_tokens` / `usage.output_tokens` = totals, plus
  `usage.x_hub: HubUsageBreakdown`; streaming in the final `message_delta`.
- **Agent MCP `execute_step`** (executor runs directly, no planner): `structuredContent.usage:
  WireAgentUsage` (executor; `duration_ms` measures wall clock around the step) and, when the step reviewer ran, `structuredContent.usage_reviewer:
  WireTokens`; the text result ends with one line
  `[usage] prompt=<n> completion=<n> total=<n> time=<seconds>s` (one decimal) (the tool description already promises a usage
  footer — make description and behaviour agree).

## Hub changes

1. The planner wrapper (`srv/lib/dialogue-sessions.ts`, planner `process`) returns the SmartAgent
   result's usage (with `models`) as `usage`.
2. The worker adapter returns the worker result's `usage`; when the step reviewer runs and exposes
   usage, add it to the task's usage (`addTokenUsage`) so a subagent's number covers its whole work.
3. `dialogueChat.process` / `streamProcess` and `chat-stream.ts` sum `PlannerMessage.usage` of every
   delivered message (`addTokenUsage`) and emit it per the wire format; the delivery-by-id path
   attaches each message's usage.
4. `execute_step` emits the executor's usage as above.
5. Non-dialogue paths keep today's behaviour (provider usage) and gain nothing new.

## Non-goals / builder's calls

- Embedding tokens are not reported (no contract carries them per request; usage records keep them).
- No cached-token fields (`LlmUsage` has none yet).
- No zero-filling: when nothing is known, `usage` stays as today.

## Constraints

- Static typing: no `any`, no `unknown` outside narrowed caught errors, no `as unknown as`, no
  silencing casts, no untyped callback params — product code and tests.
- Tests: `npx jest --maxWorkers=1`; typecheck `npx tsc --noEmit`; lint `npx biome check`.
