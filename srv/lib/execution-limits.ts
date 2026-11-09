import { AsyncLocalStorage } from 'node:async_hooks';
import type { Result } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import type { RoleSettingsError } from './role-model-settings';
import { sessionSlot } from './session-slot';

export type Limit = number | 'off';
export interface RunLimits {
  maxIterations?: Limit;
  maxToolCalls?: Limit;
}
export interface ExecutionLimits {
  coordinator?: RunLimits;
  executor?: RunLimits;
  checker?: RunLimits;
  toolResultMaxChars?: Limit;
  historyTokenBudget?: Limit;
  planStepBudget?: Limit;
}
const limit = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.literal('off'),
]);
const run = z.strictObject({
  maxIterations: limit.optional(),
  maxToolCalls: limit.optional(),
});
export const executionLimitsSchema = z.strictObject({
  coordinator: run.optional(),
  executor: run.optional(),
  checker: run.optional(),
  toolResultMaxChars: limit.optional(),
  historyTokenBudget: limit.optional(),
  planStepBudget: limit.optional(),
});
export type ExecutionLimitsInput = z.input<typeof executionLimitsSchema>;
export function validateExecutionLimits(
  input: ExecutionLimitsInput,
  ctx: { libraryLimitsEnabled: boolean },
): Result<ExecutionLimits, RoleSettingsError> {
  const parsed = executionLimitsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        field: [
          ...issue.path,
          ...(issue.code === 'unrecognized_keys' ? issue.keys.slice(0, 1) : []),
        ].join('.'),
        reason: issue.message,
      },
    };
  }
  if (parsed.data.planStepBudget !== undefined && !ctx.libraryLimitsEnabled)
    return {
      ok: false,
      error: {
        field: 'planStepBudget',
        reason:
          'run and plan-step budgets arrive with llm-agent library limits (stage 2)',
      },
    };
  return { ok: true, value: parsed.data };
}
const store = new Map<string, ExecutionLimits>();
const scope = new AsyncLocalStorage<ExecutionLimits>();
export function getExecutionLimits(
  userId: string,
  key: string,
): ExecutionLimits {
  return structuredClone(store.get(sessionSlot(userId, key)) ?? {});
}
export function setExecutionLimits(
  userId: string,
  key: string,
  limits: ExecutionLimits,
): void {
  store.set(sessionSlot(userId, key), structuredClone(limits));
}
export function clearExecutionLimits(userId: string, key: string): void {
  store.delete(sessionSlot(userId, key));
}
export function withExecutionLimits<T>(
  limits: ExecutionLimits,
  fn: () => T,
): T {
  return scope.run(structuredClone(limits), fn);
}
type RunRole = 'coordinator' | 'executor' | 'checker';
export function currentLimit(
  role: RunRole,
  name: keyof RunLimits,
): Limit | undefined {
  return scope.getStore()?.[role]?.[name];
}
export function currentSessionLimit(
  name: 'toolResultMaxChars' | 'historyTokenBudget',
): Limit | undefined {
  return scope.getStore()?.[name];
}

/** Infinity is the numeric consumer's unbounded form, not a finite substitute. */
export function runLimitOptions(
  role: RunRole,
  defaults: { maxIterations: number; maxToolCalls?: number },
): { maxIterations: number; maxToolCalls?: number } {
  const iterations = currentLimit(role, 'maxIterations');
  const calls = currentLimit(role, 'maxToolCalls');
  return {
    maxIterations:
      iterations === 'off' ? Infinity : (iterations ?? defaults.maxIterations),
    // An explicit undefined overrides SmartAgentBuilder's built-in 30-call default.
    ...(calls === 'off'
      ? { maxToolCalls: undefined }
      : calls !== undefined
        ? { maxToolCalls: calls }
        : defaults.maxToolCalls !== undefined
          ? { maxToolCalls: defaults.maxToolCalls }
          : {}),
  };
}
export function historyBudgetOptions(): { tokenBudget: number } | undefined {
  const value = currentSessionLimit('historyTokenBudget');
  return value === 'off' ? undefined : { tokenBudget: value ?? 8000 };
}
export function sessionToolResultMaxChars(fallback: number): number {
  const value = currentSessionLimit('toolResultMaxChars');
  return value === 'off' ? 0 : (value ?? fallback);
}
export function effectiveExecutionLimits(
  userId: string,
  key: string,
): Record<string, { value: Limit; source: 'user' | 'env' | 'default' }> {
  const settings = getExecutionLimits(userId, key);
  const result: ReturnType<typeof effectiveExecutionLimits> = {};
  const add = (
    name: string,
    value: Limit | undefined,
    env: string | undefined,
    fallback: Limit,
  ) => {
    result[name] =
      value !== undefined
        ? { value, source: 'user' }
        : env?.trim()
          ? { value: Number(env), source: 'env' }
          : { value: fallback, source: 'default' };
  };
  for (const role of ['coordinator', 'executor', 'checker'] as const) {
    add(
      `${role}.maxIterations`,
      settings[role]?.maxIterations,
      process.env.LLM_AGENT_MAX_ITERATIONS,
      10,
    );
    add(
      `${role}.maxToolCalls`,
      settings[role]?.maxToolCalls,
      process.env.LLM_AGENT_MAX_TOOL_CALLS,
      30,
    );
  }
  add(
    'toolResultMaxChars',
    settings.toolResultMaxChars,
    process.env.LLM_AGENT_TOOL_RESULT_MAX_CHARS,
    60000,
  );
  if (result.toolResultMaxChars.value === 0)
    result.toolResultMaxChars.value = 'off';
  add('historyTokenBudget', settings.historyTokenBudget, undefined, 8000);
  return result;
}
