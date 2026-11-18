import { readPositiveIntFrom } from './env-int';

/** Leave output length to the provider unless an override is configured. */
export function configuredMaxTokens(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return (
    readPositiveIntFrom(env, 'LLM_AGENT_MAX_TOKENS') ??
    readPositiveIntFrom(env, 'SAP_CORE_AI_MAX_TOKENS')
  );
}
