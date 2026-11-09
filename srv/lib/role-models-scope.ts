import { AsyncLocalStorage } from 'node:async_hooks';
import { configuredRoleModel } from './deploy-role-config';
import { type ExecutionLimits, withExecutionLimits } from './execution-limits';
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

export function currentRoleModel(role: RoleName): string | undefined {
  return (
    settingsScope.getStore()?.[role]?.model ??
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
    model: process.env.LLM_AGENT_MODEL ?? null,
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
  return {
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
}
