interface DialogueModelOptions {
  model: string;
  plannerModel?: string;
  coordinatorModel?: string;
  sessionModel?: string;
  requestModel?: string;
}

/** Shared model precedence for the dialogue coordinator and plan author. */
export function resolveDialogueRoleModel(
  role: 'coordinator' | 'planner',
  options: DialogueModelOptions,
): { model: string; source: 'user' | 'request' | 'env' | 'deploy' } {
  if (options.sessionModel !== undefined)
    return { model: options.sessionModel, source: 'user' };
  if (role === 'coordinator') {
    if (options.requestModel !== undefined)
      return { model: options.requestModel, source: 'request' };
    if (options.coordinatorModel !== undefined)
      return { model: options.coordinatorModel, source: 'env' };
  }
  return options.plannerModel !== undefined
    ? { model: options.plannerModel, source: 'env' }
    : { model: options.model, source: 'deploy' };
}
