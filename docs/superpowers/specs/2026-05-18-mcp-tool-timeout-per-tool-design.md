# MCP tool timeout — per-tool overrides

**Date:** 2026-05-18
**Issue:** [cloud-llm-hub#97](https://github.com/fr0ster/cloud-llm-hub/issues/97)
**Scope:** Single small server-side change shipping as v6.8.4. Plus `.mtaext` config rollout per deploy.

## TL;DR

`srv/agent-manager.ts:1148-1163` enforces a global 2-minute timeout on every MCP tool call via `Promise.race`. Heavy tools (most notably `SearchSource` scanning hundreds of ABAP objects) exceed it; raising the global default would penalise every quick tool. Fix: extract the timeout resolution into a small helper that consults a 3-tier lookup chain:

1. `process.env[\`LLM_AGENT_MCP_TOOL_TIMEOUT_MS_${toolName}\`]` (per-tool override, env-var name case-sensitive)
2. `process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS` (global override, existing knob)
3. `120_000` (built-in default, unchanged)

Plus `.mtaext` for each deploy-target gets a starter override:

```yaml
LLM_AGENT_MCP_TOOL_TIMEOUT_MS_SearchSource: "600000"   # 10 min
```

No new endpoints, no schema changes, no client changes. Promise.race semantics unchanged — this only widens the deadline, not the cancellation behaviour.

## What's already in place

- `srv/agent-manager.ts:1142-1163` — the existing `Promise.race` block that races `toolCall` against a `setTimeout` reject.
- `.mtaext` files per deploy-target — already pass `LLM_AGENT_*` env vars verbatim into the `cloud-llm-hub-srv` Cloud Foundry app.

## Out of scope

- **AbortSignal propagation.** `Promise.race` only stops awaiting the result — the underlying ADT HTTP request keeps running until it returns naturally. Worth a follow-up issue but not in this one; the user-facing symptom (timeout error in chat) is fixed by widening the deadline, even if a stale request leaks server-side for a bit longer.
- **Tool-self-declared default timeout** (each tool exporting its expected max). Couples cloud-llm-hub to `@mcp-abap-adt` release cycle. Not needed for the SearchSource pain point.
- **Streaming progress / heartbeat extensions.** Same — not needed for this fix.
- **Per-collection or per-user timeouts.** Env-var-per-tool is enough granularity.

## Components

### 1. Server: timeout resolver helper

Inside `srv/agent-manager.ts` (or extracted to `srv/lib/mcp-tool-timeout.ts` if it grows), add:

```ts
/**
 * Resolve the MCP tool timeout for a given tool name.
 *
 * Lookup order (first non-empty, valid positive integer wins):
 *   1. process.env[`LLM_AGENT_MCP_TOOL_TIMEOUT_MS_${toolName}`]
 *   2. process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS
 *   3. 120_000 (default)
 *
 * Tool names are case-sensitive. Malformed values (NaN, non-positive, non-numeric)
 * fall through to the next tier rather than being silently treated as 0.
 */
export function resolveMcpToolTimeoutMs(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultMs = 120_000,
): number {
  const perTool = env[`LLM_AGENT_MCP_TOOL_TIMEOUT_MS_${toolName}`];
  const global = env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS;
  const parsed = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return parsed(perTool) ?? parsed(global) ?? defaultMs;
}
```

Replace the inline lookup at `agent-manager.ts:1148-1149` with a call to this helper:

```ts
const MCP_TOOL_TIMEOUT_MS = resolveMcpToolTimeoutMs(name);
```

The rest of the `Promise.race` block stays unchanged.

### 2. `.mtaext` overrides per deploy

Add to each `.mtaext` `parameters:` block (and `.mtaext.staging` where applicable):

```yaml
LLM_AGENT_MCP_TOOL_TIMEOUT_MS_SearchSource: "600000"   # 10 min — large packages
```

Targets: `deploy/acme-sandbox`, `deploy/acme-prod`, `deploy/acme-prod-stg`, `deploy/customer-b`. Each branch carries its own `.mtaext`. The new key sits next to the existing `LLM_AGENT_MODEL` / `LLM_AGENT_MCP_DESTINATION` / etc.

`mta.yaml` and `mta-staging.yaml` are cross-branch invariants — they do NOT get the new key. Per-deploy values stay in `.mtaext` per the project's existing config-layering rule.

### 3. Tests

Unit test for `resolveMcpToolTimeoutMs` in `test/unit/`:

- per-tool wins over global wins over default
- malformed values (empty string, `"abc"`, `"0"`, `"-1"`) fall through to next tier
- missing env returns default
- explicit `env` arg lets the test inject without mutating `process.env`

## Error handling

| Condition | Behavior |
|---|---|
| Per-tool env set, valid positive integer | Use that value |
| Per-tool env set, invalid (NaN, ≤0, empty) | Fall through to global, then default |
| Global env set, invalid | Fall through to default |
| No env vars set | 120_000 ms default — unchanged from today |
| Tool times out | Same as today: `Promise.race` rejects, agent surfaces the message; underlying request remains in flight server-side (Out of scope to fix here) |

## Testing

**Unit (Jest with ts-jest):**

- `resolveMcpToolTimeoutMs`:
  - per-tool override wins (`SearchSource` env, no global) → returns override
  - global override wins when no per-tool (`SearchSource` env absent, `LLM_AGENT_MCP_TOOL_TIMEOUT_MS` set) → returns global
  - default applies when both empty → returns 120_000
  - per-tool invalid → falls through to global
  - global invalid → falls through to default
  - `"0"` and `"-100"` treated as invalid (positive-int gate)
  - non-numeric (`"abc"`, `""`) treated as invalid

**Manual (post-deploy):**

- Issue a `SearchSource` call on `ZABAPGIT` recursively via chat-📎. Before fix: 2-min timeout. After fix: completes successfully within 10 min for typical workloads.
- `cf logs cloud-llm-hub-srv --recent | grep "MCP tool"` — verify the timeout messages mention the new value for SearchSource specifically; other tools still log 120s.

## File touch list

- `srv/agent-manager.ts` — extract `resolveMcpToolTimeoutMs`, swap the inline lookup for the helper call.
- `test/unit/mcp-tool-timeout.test.ts` (new) — unit tests for the helper.
- `.mtaext` (deploy/acme-sandbox branch) — add SearchSource override.
- `.mtaext` (deploy/acme-prod), `.mtaext.staging` (deploy/acme-prod-stg) — same.
- `.mtaext` (deploy/customer-b) — same.

Each deploy-branch update can happen on a separate commit during rollout (after main merge) — they don't conflict.

## Open questions

None. The 10-minute SearchSource value matches typical observed durations for moderate Z-namespace scans; deploy operators can raise/lower per subaccount without code change.
