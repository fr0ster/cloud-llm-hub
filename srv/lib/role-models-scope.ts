import { AsyncLocalStorage } from 'node:async_hooks';
import { deployModel } from './deploy-model';
import { configuredRoleModel } from './deploy-role-config';
import { type ExecutionLimits, withExecutionLimits } from './execution-limits';
import { parseModelAllowlist } from './model-policy';
import {
  getRoleModels,
  type RoleModelSettings,
  type RoleName,
} from './role-model-settings';
import { sessionSlot } from './session-slot';

const settingsScope = new AsyncLocalStorage<RoleModelSettings>();
const requestModels = new Map<string, string>();

export function setRequestModel(
  userId: string,
  key: string,
  model: string,
): void {
  requestModels.set(sessionSlot(userId, key), model);
}

export function clearRequestModel(userId: string, key: string): void {
  requestModels.delete(sessionSlot(userId, key));
}

export function dialogueRequestModel(
  userId: string,
  key: string,
): string | undefined {
  return requestModels.get(sessionSlot(userId, key));
}

export function withRoleModels<T>(
  settings: RoleModelSettings,
  fn: () => Promise<T>,
  limits?: ExecutionLimits,
): Promise<T> {
  const run = () => settingsScope.run(structuredClone(settings), fn);
  return limits === undefined ? run() : withExecutionLimits(limits, run);
}

export class RoleModelNotAllowedError extends Error {
  constructor(role: RoleName, model: string) {
    super(
      `${role}.model: MODEL_NOT_ALLOWED: model "${model}" is outside the current allowlist`,
    );
    this.name = 'RoleModelNotAllowedError';
  }
}

export function currentRoleModel(role: RoleName): string | undefined {
  const model = settingsScope.getStore()?.[role]?.model;
  if (model !== undefined && !parseModelAllowlist().has(model))
    throw new RoleModelNotAllowedError(role, model);
  return (
    model ??
    (role === 'executor' || role === 'checker'
      ? configuredRoleModel(role)
      : undefined)
  );
}

export function roleOfProfile(profile: {
  result?: string;
}): 'executor' | 'checker' {
  return profile.result === 'verdict' ? 'checker' : 'executor';
}

type ModelSource =
  | 'config'
  | 'user'
  | 'request'
  | 'env'
  | 'deploy'
  | 'coordinator';
interface EffectiveModel {
  params?: Record<string, { value: number; source: 'config' | 'default' }>;
  model: string | null;
  source: ModelSource;
}

export function effectiveRoleModels(
  userId: string,
  key: string,
): Record<RoleName, EffectiveModel> {
  const settings = getRoleModels(userId, key);
  const request = dialogueRequestModel(userId, key);
  const deploy: EffectiveModel = {
    model: deployModel(),
    source: 'deploy',
  };
  const resolve = (
    role: RoleName,
    fallback: EffectiveModel,
  ): EffectiveModel => {
    const model = settings[role]?.model;
    return model === undefined ? fallback : { model, source: 'user' };
  };
  const workerDefault = (role: 'executor' | 'checker'): EffectiveModel => {
    const model = configuredRoleModel(role);
    return model
      ? { model, source: 'config' }
      : { model: null, source: 'coordinator' };
  };
  const result = {
    coordinator: resolve(
      'coordinator',
      request !== undefined
        ? { model: request, source: 'request' }
        : process.env.LLM_AGENT_COORDINATOR_MODEL
          ? { model: process.env.LLM_AGENT_COORDINATOR_MODEL, source: 'env' }
          : deploy,
    ),
    planner: resolve(
      'planner',
      process.env.LLM_AGENT_PLANNER_MODEL
        ? { model: process.env.LLM_AGENT_PLANNER_MODEL, source: 'env' }
        : deploy,
    ),
    executor: resolve('executor', workerDefault('executor')),
    checker: resolve('checker', workerDefault('checker')),
  };
  for (const effective of Object.values(result)) {
    const temperature =
      process.env.LLM_AGENT_TEMPERATURE || process.env.SAP_CORE_AI_TEMPERATURE;
    const maxTokens =
      process.env.LLM_AGENT_MAX_TOKENS || process.env.SAP_CORE_AI_MAX_TOKENS;
    effective.params = {
      temperature: {
        value: Number.parseFloat(temperature || '0.7'),
        source: temperature ? 'config' : 'default',
      },
      maxOutputTokens: {
        value: Number.parseInt(maxTokens || '2000', 10),
        source: maxTokens ? 'config' : 'default',
      },
    };
  }
  return result;
}
