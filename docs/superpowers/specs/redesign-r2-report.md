# Result-based reviewer redesign — R2 fix report

Opus review of the result-based reviewer redesign (commit `7c24849`) APPROVED
correctness (false-positive killed, lies caught) with 1 Important + 3 Minor
findings. All four fixed on branch `chore/migrate-mcp-abap-adt-latest`.

## Fix 1 (IMPORTANT) — scope `status:'active'` satisfaction to write tools

`srv/lib/reviewer-core.ts`: `opSatisfied` previously accepted
`outcomes.some(o => o.status === 'active')` for `'activated'`/`'updated'` from
ANY tool, including reads. A read tool echoing `status:'active'` (e.g. a
`ReadDomain` read-back) could mask a real activation/update lie. Now scoped:
`o.status === 'active' && isWriteTool(o.name)` (imports `isWriteTool` from
`./write-guardrail`, already imported for `claimedWriteOps`).

Legitimate write paths still satisfy: `CreateDomain`(activate:true)→active,
`ActivateDomain`, `UpdateTable`→active are all write-tool names.

Test added (`test/unit/reviewer-core.test.ts`): "does NOT let a READ tool
echoing status:active satisfy an activation claim" — content claims
"activated", records = only `ReadDomain` with `status:'active'` →
`ok:false`, `claimedOp:'activated'`.

## Fix 2 (Minor) — removed the redundant failed-write catch-all

`srv/lib/reviewer-core.ts`: removed the trailing loop in
`evaluateDeterministic` that pushed an extra `unverified-write` issue for
ANY failed write tool while a completed write was claimed, attributing it to
`claims[0]`. Rationale confirmed: the per-op rules already flag failed
writes for the CLAIMED op — a failed `Create*` fails `created` (no
successful Create* ran), a failed `Activate*` fails `activated` (no
status:active from a write tool). The catch-all only added noise for
UNRELATED failed writes and mislabeled the op.

Tests:
- "still flags a failed CreateDomain claimed as created (per-op rule, no
  catch-all needed)" — `CreateDomain` with `isError:true` claiming "created"
  → still `ok:false`, reason includes `CreateDomain returned error`.
- "is clean for an honest create+activate alongside an UNRELATED failed
  DeleteTable" — `CreateDomain`→active (satisfies created+activated) plus an
  unrelated failed `DeleteTable` → `ok:true` (previously the catch-all would
  have flagged this).

## Fix 3 (Minor) — removed dead token-gate machinery

`srv/lib/step-gate.ts`: `evaluateGated` (in `step-reviewer.ts`) already
inlines `toolCallCount <= loadStepGateThresholds(env).maxToolCalls` directly,
so `stepIsSuspicious` and the `minTokens` threshold were dead in production
(no operator-visible effect from `LLM_AGENT_STEP_REVIEW_MIN_TOKENS`).
Removed:
- `stepIsSuspicious` function
- `minTokens` field from `StepGateThresholds` and `loadStepGateThresholds`
- `LLM_AGENT_STEP_REVIEW_MIN_TOKENS` env parsing

Kept: `maxToolCalls` (used by `evaluateGated`), `loadStepReviewTimeoutMs`,
`stepReviewEnabled` (both used).

`test/unit/step-gate.test.ts` updated: removed the `stepIsSuspicious`
describe block and all `minTokens` assertions/env keys; kept
`loadStepGateThresholds` (maxToolCalls-only), `stepReviewEnabled`,
`loadStepReviewTimeoutMs` tests.

Grep evidence (production + test code, docs/plan excluded per "do not touch
unrelated files"):
```
$ grep -rn "stepIsSuspicious\|\bminTokens\b" srv/ test/
(no output)
```
(`test/unit/step-reviewer.test.ts` still saves/restores the env var
`LLM_AGENT_STEP_REVIEW_MIN_TOKENS` in its `ENV_KEYS` cleanup list — harmless,
the var is simply unread now; left untouched as out of scope for this fix.)

## Fix 4 (Minor) — consistent `i` flag on `WRITE_TOOL`

`srv/lib/write-guardrail.ts`: `WRITE_TOOL` regex
`/^(?:Handler)?(?:Create|Update|Delete|Activate)/` gained the `i` flag,
matching the `CREATE_TOOL`/`UPDATE_TOOL`/`DELETE_TOOL` family regexes in
`reviewer-core.ts` which are already `i`-flagged. Harmless (tool names are
PascalCase) — purely for consistency. `isWriteTool`/`hasWriteTool` behavior
unchanged; existing `write-guardrail.test.ts` suite (13 tests) still green.

## Verification

```
npx jest test/unit/reviewer-core.test.ts test/unit/step-gate.test.ts \
  test/unit/write-guardrail.test.ts test/unit/step-reviewer.test.ts
# 4 suites, 68 tests passed

npm run test:unit
# 50 suites, 447 tests passed

npm run test:check   # tsc --noEmit — clean
npx biome check srv/lib/reviewer-core.ts srv/lib/write-guardrail.ts \
  srv/lib/step-gate.ts test/unit/reviewer-core.test.ts test/unit/step-gate.test.ts
# Checked 5 files, no issues
```

## Commit

`fix(controller): scope activation ground-truth to write tools; drop dead
token-gate machinery` — touches `srv/lib/reviewer-core.ts`,
`srv/lib/write-guardrail.ts`, `srv/lib/step-gate.ts`,
`test/unit/reviewer-core.test.ts`, `test/unit/step-gate.test.ts`.

## Concerns / follow-ups

- None blocking. The only loose end is the now-inert
  `LLM_AGENT_STEP_REVIEW_MIN_TOKENS` key still listed in
  `step-reviewer.test.ts`'s env save/restore array — cosmetic, not touched
  per the "don't modify unrelated files" constraint; safe to clean up in a
  future pass if desired.
