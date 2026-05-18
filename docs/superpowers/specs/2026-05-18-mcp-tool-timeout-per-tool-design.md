# SearchSource timeout — minimal default bump

**Date:** 2026-05-18
**Issue:** [cloud-llm-hub#97](https://github.com/fr0ster/cloud-llm-hub/issues/97)
**Scope:** One conditional in `srv/agent-manager.ts`. Shipping as v6.8.4.

## TL;DR

`srv/agent-manager.ts:1148-1163` races every MCP tool call against a 2-minute timeout. SearchSource over moderate Z-namespaces blows past it routinely — the rest of the tool surface (~200 handlers) doesn't. **YAGNI on weight maps, per-tool env vars, AbortSignal**: just give SearchSource a longer default in the same block. Everything else stays at 2 min. Global env override still works.

```ts
const DEFAULT_TIMEOUT_MS = name === 'SearchSource' ? 600_000 : 120_000;
const MCP_TOOL_TIMEOUT_MS =
  Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
```

When the next tool needs special-casing, we add another branch. Until then, no infrastructure.

## What's already in place

- `srv/agent-manager.ts:1148-1163` — the `Promise.race` block with the inline timeout lookup.
- `process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS` — existing global knob; left intact.

## Out of scope

- **Weight maps / categories.** Speculative — only one tool currently needs an override.
- **Per-tool env-var vocabulary.** 200+ tools × env-var = noise; we have one outlier today, hardcode it.
- **AbortSignal propagation.** `Promise.race` still abandons the underlying ADT request when the timer fires. Not in scope; widening the deadline removes the user-visible error, and the leak is a separate concern worth a follow-up issue if observed in production.
- **`.mtaext` per-deploy overrides.** Not needed — the new default already fits the SearchSource workload. Operators can still set `LLM_AGENT_MCP_TOOL_TIMEOUT_MS` globally if they want.

## The change

Inside `srv/agent-manager.ts`, the existing block:

```ts
const MCP_TOOL_TIMEOUT_MS =
  Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || 120_000;
```

Becomes:

```ts
// Default 2 min for most tools; SearchSource scans whole packages over
// ADT and routinely exceeds that on real Z-namespaces. Other tools that
// hit the same wall in the future get their own branch here.
const DEFAULT_TIMEOUT_MS = name === 'SearchSource' ? 600_000 : 120_000;
const MCP_TOOL_TIMEOUT_MS =
  Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
```

Three lines added, one line replaced. No new function, no new file.

## Error handling

| Condition | Behavior |
|---|---|
| `LLM_AGENT_MCP_TOOL_TIMEOUT_MS` is set to a valid positive number | Use it (current behavior — global override wins) |
| `LLM_AGENT_MCP_TOOL_TIMEOUT_MS` is unset, tool is SearchSource | 600_000 ms (10 min) |
| `LLM_AGENT_MCP_TOOL_TIMEOUT_MS` is unset, any other tool | 120_000 ms (2 min — unchanged) |
| Tool times out | Same as today — race rejects, agent surfaces "MCP tool ... timed out after Ns" |

## Testing

**Unit:**

The block is small enough that a focused test on a tiny extracted function reads cleaner than testing through the full `agent-manager` stack. Promote the timeout-resolution to a private helper inside `agent-manager.ts` (or `srv/lib/mcp-tool-timeout.ts` if more readability is needed):

```ts
export function resolveMcpToolTimeoutMs(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return toolName === 'SearchSource' ? 600_000 : 120_000;
}
```

Tests:

- No env set, SearchSource → 600_000
- No env set, RuntimeListFeeds → 120_000
- Env set to `"900000"`, SearchSource → 900_000 (global override wins)
- Env set to `"abc"`, SearchSource → 600_000 (NaN falls through)
- Env set to `"0"`, SearchSource → 600_000 (non-positive falls through)
- Env set to `"-1"`, SearchSource → 600_000

**Manual (post-deploy):**

- `SearchSource` on `ZABAPGIT` recursive → completes (was: 2-min timeout).
- Any other tool (e.g. `GetClass` on a small object) → completes quickly; timeout still 2 min.
- Set `LLM_AGENT_MCP_TOOL_TIMEOUT_MS=300000` env override → both SearchSource and other tools use 5 min.

## File touch list

- `srv/agent-manager.ts` — three-line conditional + helper extraction.
- `test/unit/mcp-tool-timeout.test.ts` (new) — 6 small tests for `resolveMcpToolTimeoutMs`.

## Open questions

None. If a second tool turns out to need its own default in production, we add a second branch (or graduate to a map at that point) — but not pre-emptively.
