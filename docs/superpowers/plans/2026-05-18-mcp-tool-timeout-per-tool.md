# SearchSource timeout default bump — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SearchSource MCP tool calls no longer time out at 2 minutes on real Z-namespace workloads. Other tools keep the current 2-minute default.

**Architecture:** Extract the existing inline timeout lookup in `srv/agent-manager.ts` into a small helper `resolveMcpToolTimeoutMs(toolName, env?)`. The helper applies a 2-tier resolution: global env-var override wins, otherwise `SearchSource` gets 600_000 ms (10 min) and everything else stays 120_000 ms. Three lines of behaviour change, plus a focused unit-test surface.

**Tech Stack:** TypeScript (strict), Jest + ts-jest. No new dependencies, no new files (helper sits inside `agent-manager.ts` since it's a 6-line function).

---

## File Structure

- `srv/agent-manager.ts` (modify) — extract `resolveMcpToolTimeoutMs(name, env?)`; export it for tests; replace the inline lookup at the existing `Promise.race` block.
- `test/unit/mcp-tool-timeout.test.ts` (create) — 6 unit tests covering: SearchSource default, other tools default, global env override, NaN/non-positive/empty env values falling through.

Spec reference: `docs/superpowers/specs/2026-05-18-mcp-tool-timeout-per-tool-design.md`.

---

## Task 1: Orient (no commit)

**Files:** none.

- [ ] **Step 1: Confirm the current timeout block**

```bash
sed -n '1145,1170p' srv/agent-manager.ts
```

Expected:

```ts
const MCP_TOOL_TIMEOUT_MS =
  Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || 120_000;
const result = await Promise.race([
  toolCall,
  new Promise<never>((_, reject) =>
    setTimeout(...),
  ),
]);
```

The block is inside a function that receives `name` (tool name) in scope. The helper extraction will use that `name`.

- [ ] **Step 2: Confirm test infrastructure**

```bash
ls test/unit/
cat jest.config.ts | head -20
```

Expected: Jest + ts-jest already configured (existing `rag-collections-bulk.test.ts`, `rag-export.test.ts`, `exposition.test.ts` are siblings).

No commit. Proceed.

---

## Task 2: Implement and test the helper (TDD)

**Files:**
- Modify: `srv/agent-manager.ts`
- Create: `test/unit/mcp-tool-timeout.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/mcp-tool-timeout.test.ts`:

```typescript
import { resolveMcpToolTimeoutMs } from '../../srv/agent-manager';

describe('resolveMcpToolTimeoutMs', () => {
  it('returns 600_000 for SearchSource when no env is set', () => {
    expect(resolveMcpToolTimeoutMs('SearchSource', {})).toBe(600_000);
  });

  it('returns 120_000 for other tools when no env is set', () => {
    expect(resolveMcpToolTimeoutMs('RuntimeListFeeds', {})).toBe(120_000);
    expect(resolveMcpToolTimeoutMs('GetClass', {})).toBe(120_000);
    expect(resolveMcpToolTimeoutMs('SearchObject', {})).toBe(120_000);
  });

  it('global env override wins for any tool', () => {
    const env = { LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '900000' };
    expect(resolveMcpToolTimeoutMs('SearchSource', env)).toBe(900_000);
    expect(resolveMcpToolTimeoutMs('GetClass', env)).toBe(900_000);
  });

  it('non-numeric env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('SearchSource', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: 'abc',
      }),
    ).toBe(600_000);
    expect(
      resolveMcpToolTimeoutMs('GetClass', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: 'abc',
      }),
    ).toBe(120_000);
  });

  it('zero env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('SearchSource', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '0',
      }),
    ).toBe(600_000);
  });

  it('negative env value falls through to per-tool default', () => {
    expect(
      resolveMcpToolTimeoutMs('GetClass', {
        LLM_AGENT_MCP_TOOL_TIMEOUT_MS: '-1',
      }),
    ).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run tests — expect import error**

Run: `npx jest --testPathPatterns="mcp-tool-timeout"`
Expected: failure because `resolveMcpToolTimeoutMs` is not exported from `srv/agent-manager.ts` yet.

- [ ] **Step 3: Add the helper to `srv/agent-manager.ts`**

Find the existing inline lookup block:

```bash
grep -n "MCP_TOOL_TIMEOUT_MS" srv/agent-manager.ts
```

Above the function that contains the `Promise.race` (or at the top of the file near other top-level helpers — pick whichever sits naturally), add:

```typescript
/**
 * Resolve the MCP tool timeout for a given tool name.
 *
 * 1. process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS — global override (existing knob).
 * 2. otherwise SearchSource gets 600_000 ms (10 min); every other tool
 *    keeps the 120_000 ms (2 min) default.
 *
 * Malformed env values (NaN, zero, negative) fall through to the per-tool
 * default rather than being silently treated as 0.
 *
 * When the next tool starts hitting the 2-minute wall in production we add
 * another branch here — but not pre-emptively.
 */
export function resolveMcpToolTimeoutMs(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return toolName === 'SearchSource' ? 600_000 : 120_000;
}
```

Then replace the inline lookup. Locate (around `srv/agent-manager.ts:1148-1149`):

```typescript
const MCP_TOOL_TIMEOUT_MS =
  Number(process.env.LLM_AGENT_MCP_TOOL_TIMEOUT_MS) || 120_000;
```

Replace with:

```typescript
const MCP_TOOL_TIMEOUT_MS = resolveMcpToolTimeoutMs(name);
```

The rest of the `Promise.race` and the timeout-message string stay unchanged. The string already templates `MCP_TOOL_TIMEOUT_MS / 1000`, so the surfaced "timed out after Ns" stays accurate.

- [ ] **Step 4: Run tests — expect green**

Run: `npx jest --testPathPatterns="mcp-tool-timeout"`
Expected: 6 tests pass.

- [ ] **Step 5: Run full unit suite to catch regressions**

Run: `npm run test:unit`
Expected: full suite green — no other test imports `resolveMcpToolTimeoutMs` so adding the helper is additive.

- [ ] **Step 6: Type-check and lint**

Run: `npx tsc --noEmit`
Run: `npx tsc --noEmit --project tsconfig.test.json`
Run: `npm run lint:check`

All three: clean.

- [ ] **Step 7: Commit**

```bash
git add srv/agent-manager.ts test/unit/mcp-tool-timeout.test.ts
git commit -m "fix(mcp): SearchSource gets 10-min default timeout; others keep 2-min"
```

---

## Task 3: Final verification + cleanup + PR

**Files:** spec + plan deleted in cleanup.

- [ ] **Step 1: Full gates**

Run: `npm run test:unit && npm run lint:check && npx tsc --noEmit && npx tsc --noEmit --project tsconfig.test.json`
All: clean.

- [ ] **Step 2: Manual smoke (post-deploy, after v6.8.4 lands on acme-sandbox/dev)**

1. Open chat UI → ask agent to run SearchSource on a moderate Z-namespace (e.g. `ZABAPGIT` recursive). Should complete (with all the upload/lock fixes in place) instead of failing at 2 min.
2. `cf logs cloud-llm-hub-srv --recent | grep "MCP tool"` — verify the timeout message in the agent log for a deliberately long call reports a longer-than-120s deadline if SearchSource is the offender.
3. Sanity check with a fast tool (e.g. `GetClass` on a tiny class) — completes well under 2 min, no behaviour change.

- [ ] **Step 3: Delete spec + plan**

```bash
git rm docs/superpowers/specs/2026-05-18-mcp-tool-timeout-per-tool-design.md \
       docs/superpowers/plans/2026-05-18-mcp-tool-timeout-per-tool.md
git commit -m "chore: remove implemented spec/plan for SearchSource timeout bump"
```

- [ ] **Step 4: Push + PR**

```bash
git push -u origin mcp-tool-timeout-per-tool
gh pr create --base main --head mcp-tool-timeout-per-tool \
  --title "fix(mcp): SearchSource gets 10-min default timeout; others keep 2-min" \
  --body "Closes #97.

## Summary
- Extract \`resolveMcpToolTimeoutMs(toolName, env?)\` helper from the existing inline lookup in srv/agent-manager.ts.
- Global env override \`LLM_AGENT_MCP_TOOL_TIMEOUT_MS\` still wins.
- Default: SearchSource → 600_000 ms (10 min); every other tool → 120_000 ms (2 min, unchanged).
- 6 unit tests for the helper.

## Test plan
- [x] 6 unit tests for resolveMcpToolTimeoutMs cover SearchSource default, other-tool default, global override, NaN/zero/negative env fallthrough.
- [x] Full unit suite green; lint clean; root tsc + test tsc clean.
- [ ] Manual smoke on acme-sandbox/dev: SearchSource on a moderate Z-namespace completes; fast tools still timeout in 2 min if they hang.

## Out of scope (kept YAGNI per #97)
- Weight maps / per-tool env-var vocabulary — speculative; only one tool currently needs an override.
- AbortSignal propagation — Promise.race still abandons the underlying ADT request when the timer fires. Worth a follow-up if observed in production.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
