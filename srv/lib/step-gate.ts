/**
 * Cheap suspicion gate deciding WHETHER to spend an LLM reviewer call on an
 * execute_step result. Not a verdict — just "worth double-checking".
 *
 * Suspicious means the executor claimed work on the ABAP system and called
 * NOTHING to do it. That is the reviewer's own rule, stated in its prompt:
 * flag "a concrete system fact or success after zero tool calls".
 *
 * The default used to be 1, which invited the critic on every single-tool step
 * — and a compact create that activates itself IS a single-tool step. Asked to
 * judge, the critic obliged: it saw one `CreateDataElement`, no `Activate*`,
 * and called a correct answer possibly fake. The gate was looser than the rule
 * it gates, so it kept summoning a judge to the one case most easily misread.
 *
 * A step that ran even one tool is left to `evaluateDeterministic`, which is
 * free, unconditional, and grounded in the tool RESULTS rather than a
 * judgement about them.
 */
export type StepGateThresholds = { maxToolCalls: number };

/**
 * Parse a strict integer env value >= `min`; empty / non-numeric / trailing junk
 * ('10abc') / decimal ('1.5') / below-min → `def`. Used for ALL numeric config
 * here so behaviour is uniform (no `Number('')===0` or `parseInt('1.5')===1`).
 */
function strictInt(
  value: string | undefined,
  def: number,
  min: number,
): number {
  if (value === undefined || value.trim() === '') return def;
  const t = value.trim();
  const n = Number.parseInt(t, 10);
  return Number.isInteger(n) && n >= min && String(n) === t ? n : def;
}

export function loadStepGateThresholds(
  env: NodeJS.ProcessEnv,
): StepGateThresholds {
  return {
    maxToolCalls: strictInt(env.LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS, 0, 0),
  };
}

/** Reviewer hard-timeout (ms), strictly positive; empty/invalid/<=0 → 8000. */
export function loadStepReviewTimeoutMs(env: NodeJS.ProcessEnv): number {
  return strictInt(env.LLM_AGENT_STEP_REVIEW_TIMEOUT_MS, 8000, 1);
}

/**
 * Reviewer master switch. Enabled ONLY when unset or exactly 'true'; any other
 * value ('false', '0', '', ...) disables — matching the documented semantics.
 */
export function stepReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.LLM_AGENT_STEP_REVIEW_ENABLED ?? 'true') === 'true';
}
