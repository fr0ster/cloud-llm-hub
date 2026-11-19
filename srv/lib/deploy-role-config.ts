import { BuildValidationError } from './build-validation-error';
import type { ExecutionLimits, Limit } from './execution-limits';
import { parseModelAllowlist, usesModelCatalog } from './model-policy';
import type { RoleName } from './role-model-settings';

export type PromptCachingRole = RoleName | 'classifier';

const ROLE_ENV = {
  coordinator: {
    model: 'LLM_AGENT_COORDINATOR_MODEL',
    promptCaching: 'LLM_AGENT_COORDINATOR_PROMPT_CACHING',
    maxIterations: 'LLM_AGENT_COORDINATOR_MAX_ITERATIONS',
    maxToolCalls: 'LLM_AGENT_COORDINATOR_MAX_TOOL_CALLS',
  },
  planner: {
    model: 'LLM_AGENT_PLANNER_MODEL',
    promptCaching: 'LLM_AGENT_PLANNER_PROMPT_CACHING',
  },
  executor: {
    model: 'LLM_AGENT_EXECUTOR_MODEL',
    promptCaching: 'LLM_AGENT_EXECUTOR_PROMPT_CACHING',
    maxIterations: 'LLM_AGENT_EXECUTOR_MAX_ITERATIONS',
    maxToolCalls: 'LLM_AGENT_EXECUTOR_MAX_TOOL_CALLS',
  },
  checker: {
    model: 'LLM_AGENT_CHECKER_MODEL',
    promptCaching: 'LLM_AGENT_CHECKER_PROMPT_CACHING',
    maxIterations: 'LLM_AGENT_CHECKER_MAX_ITERATIONS',
    maxToolCalls: 'LLM_AGENT_CHECKER_MAX_TOOL_CALLS',
  },
  classifier: {
    model: 'LLM_AGENT_CLASSIFIER_MODEL',
    promptCaching: 'LLM_AGENT_CLASSIFIER_PROMPT_CACHING',
  },
} as const satisfies Record<
  PromptCachingRole,
  { model: string; promptCaching: string }
> &
  Record<
    Exclude<RoleName, 'planner'>,
    { maxIterations: string; maxToolCalls: string }
  >;

/** Role overrides global; omission keeps provider prompt caching enabled. */
export function configuredPromptCaching(
  role?: PromptCachingRole,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const parse = (name: string): boolean | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    switch (raw.trim()) {
      case 'on':
      case 'true':
        return true;
      case 'off':
      case 'false':
        return false;
      default:
        throw new BuildValidationError(
          `Invalid ${name}: expected on, off, true or false, got ${JSON.stringify(raw)}`,
        );
    }
  };
  const global = parse('LLM_AGENT_PROMPT_CACHING');
  return (
    (role ? parse(ROLE_ENV[role].promptCaching) : undefined) ?? global ?? true
  );
}

/** Shared by startup validation and dependency-light runtime scopes. */
export function configuredRoleModel(
  role: RoleName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = ROLE_ENV[role].model;
  const model = env[name]?.trim() || undefined;
  if (model && !usesModelCatalog(env) && !parseModelAllowlist(env).has(model))
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
  };
  for (const role of ['coordinator', 'executor', 'checker'] as const) {
    limits[role] = {
      maxIterations:
        configuredLimit(ROLE_ENV[role].maxIterations, env) ?? maxIterations,
      maxToolCalls:
        configuredLimit(ROLE_ENV[role].maxToolCalls, env) ?? maxToolCalls,
    };
  }
  return limits;
}
