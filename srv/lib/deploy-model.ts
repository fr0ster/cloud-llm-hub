import { BuildValidationError } from './build-validation-error';

/** Resolve the deployment model without loading runtime configuration. */
export function deployModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLM_AGENT_PROVIDER === 'sap-aicore-foundation') {
    const model = env.LLM_AGENT_MODEL?.trim();
    if (!model)
      throw new BuildValidationError(
        'LLM_AGENT_MODEL must name a deployed model when LLM_AGENT_PROVIDER=sap-aicore-foundation.',
      );
    return model;
  }
  return env.LLM_AGENT_MODEL || env.SAP_CORE_AI_MODEL || 'gpt-4o-mini';
}
