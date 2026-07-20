/**
 * Cheap suspicion gate deciding WHETHER to spend an LLM reviewer call on an
 * execute_step result. Not a verdict — just "worth double-checking". A real SAP
 * operation needs tool calls and burns tokens; near-zero of either == suspicious.
 */
export type StepGateThresholds = { maxToolCalls: number; minTokens: number };

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
    maxToolCalls: strictInt(env.LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS, 1, 0),
    minTokens: strictInt(env.LLM_AGENT_STEP_REVIEW_MIN_TOKENS, 1500, 0),
  };
}

/** Reviewer hard-timeout (ms), strictly positive; empty/invalid/<=0 → 8000. */
export function loadStepReviewTimeoutMs(env: NodeJS.ProcessEnv): number {
  return strictInt(env.LLM_AGENT_STEP_REVIEW_TIMEOUT_MS, 8000, 1);
}

export function stepIsSuspicious(
  input: { toolCallCount: number; totalTokens: number },
  t: StepGateThresholds,
): boolean {
  return (
    input.toolCallCount <= t.maxToolCalls || input.totalTokens < t.minTokens
  );
}

/**
 * Reviewer master switch. Enabled ONLY when unset or exactly 'true'; any other
 * value ('false', '0', '', ...) disables — matching the documented semantics.
 */
export function stepReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.LLM_AGENT_STEP_REVIEW_ENABLED ?? 'true') === 'true';
}
