/**
 * Operator controls for the honesty reviewer.
 *
 * There used to be a suspicion GATE here: a tool-call count below which the LLM
 * critic was thought worth spending. It was a cost proxy from when the critic
 * reasoned about tools, and it was wrong in both directions — at one call it
 * summoned a judge to every honest single-tool create, at zero it left the
 * critic only cases the deterministic check already answers for free. The
 * critic now answers whether the response delivered what the USER asked, which
 * is worth asking of every step, so the proxy is gone rather than retuned.
 *
 * What remains is a timeout and a master switch.
 */

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

/** Reviewer hard-timeout (ms), strictly positive; empty/invalid/<=0 → 8000. */
export function loadStepReviewTimeoutMs(env: NodeJS.ProcessEnv): number {
  return strictInt(env.LLM_AGENT_STEP_REVIEW_TIMEOUT_MS, 8000, 1);
}

/**
 * Reviewer master switch. Enabled ONLY when unset or exactly 'true'; any other
 * value ('false', '0', '', ...) disables — matching the documented semantics.
 *
 * With the gate gone this is the only way to stop paying for the critic, so it
 * carries more weight than it used to.
 */
export function stepReviewEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.LLM_AGENT_STEP_REVIEW_ENABLED ?? 'true') === 'true';
}
