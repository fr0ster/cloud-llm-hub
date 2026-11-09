import { BuildValidationError } from './build-validation-error';
import type { ExecutionLimits, Limit } from './execution-limits';
import { parseModelAllowlist } from './model-policy';
import type { RoleName } from './role-model-settings';

/** Shared by startup validation and dependency-light runtime scopes. */
export function configuredRoleModel(
  role: RoleName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = `LLM_AGENT_${role.toUpperCase()}_MODEL`;
  const model = env[name]?.trim() || undefined;
  if (model && !parseModelAllowlist(env).has(model))
    throw new BuildValidationError(
      `Invalid ${name}: model is outside LLM_AGENT_MODELS`,
    );
  return model;
}

export function configuredLimit(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Limit | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (raw === 'off') return 'off';
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < (name === 'LLM_AGENT_TOOL_RESULT_MAX_CHARS' ? 0 : 1)
  )
    throw new BuildValidationError(
      `Invalid ${name}: expected a positive integer or off${name === 'LLM_AGENT_TOOL_RESULT_MAX_CHARS' ? ' (0 also disables the limit)' : ''}`,
    );
  return value === 0 ? 'off' : value;
}

export function configuredExecutionLimits(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionLimits {
  const maxIterations = configuredLimit('LLM_AGENT_MAX_ITERATIONS', env);
  const maxToolCalls = configuredLimit('LLM_AGENT_MAX_TOOL_CALLS', env);
  const limits: ExecutionLimits = {
    toolResultMaxChars: configuredLimit('LLM_AGENT_TOOL_RESULT_MAX_CHARS', env),
    historyTokenBudget: configuredLimit('LLM_AGENT_HISTORY_TOKEN_BUDGET', env),
  };
  for (const role of ['coordinator', 'executor', 'checker'] as const) {
    limits[role] = {
      maxIterations:
        configuredLimit(
          `LLM_AGENT_${role.toUpperCase()}_MAX_ITERATIONS`,
          env,
        ) ?? maxIterations,
      maxToolCalls:
        configuredLimit(
          `LLM_AGENT_${role.toUpperCase()}_MAX_TOOL_CALLS`,
          env,
        ) ?? maxToolCalls,
    };
  }
  return limits;
}
