/** Resolve the deployment model without loading runtime configuration. */
export function deployModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_AGENT_MODEL || env.SAP_CORE_AI_MODEL || 'gpt-4o-mini';
}
