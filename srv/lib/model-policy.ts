import type { Result } from '@mcp-abap-adt/llm-agent';

export function parseModelAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    [
      ...(env.LLM_AGENT_MODELS ?? '').split(','),
      env.LLM_AGENT_MODEL ?? '',
      env.LLM_AGENT_PLANNER_MODEL ?? '',
    ]
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
export function resolveRequestModel(
  requested: string | undefined,
  allow: ReadonlySet<string>,
): { model?: string; ignored?: string } {
  return requested === undefined
    ? {}
    : allow.has(requested)
      ? { model: requested }
      : { ignored: requested };
}
export function resolveAgentModel(
  input: { requested?: string; profile?: string },
  allow: ReadonlySet<string>,
  fallback: string,
): Result<string, 'MODEL_NOT_ALLOWED'> {
  const model = input.requested ?? input.profile ?? fallback;
  return allow.has(model)
    ? { ok: true, value: model }
    : { ok: false, error: 'MODEL_NOT_ALLOWED' };
}
