/** Operator controls for deterministic claim notices. No automatic LLM critic. */

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

/** @deprecated Parsed for compatibility only; reviews have no deadline. */
export function loadStepReviewTimeoutMs(env: NodeJS.ProcessEnv): number {
  return strictInt(env.LLM_AGENT_STEP_REVIEW_TIMEOUT_MS, 8000, 1);
}

/** Enabled when unset or exactly true; journal-based write safeguards are independent. */
export function stepReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.LLM_AGENT_STEP_REVIEW_ENABLED ?? 'true') === 'true';
}
