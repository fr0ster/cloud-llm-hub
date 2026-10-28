import {
  addTokenUsage,
  type PlannerMessageUsage,
  type TokenUsage,
} from '@mcp-abap-adt/llm-agent';

export interface WireTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  models?: Record<
    string,
    {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      requests: number;
    }
  >;
}
export type WireAgentUsage = WireTokens & { duration_ms?: number };
export interface HubUsageBreakdown {
  duration_ms?: number;
  planner?: WireAgentUsage | { duration_ms: number };
  subagents?: Array<WireAgentUsage & { task_id: string; worker: string }>;
}
export type DialogueUsage = TokenUsage & { x_hub: HubUsageBreakdown };
export function tokenUsageToWire(usage: TokenUsage): WireTokens;
export function tokenUsageToWire(
  usage: TokenUsage | undefined,
): WireTokens | undefined;
export function tokenUsageToWire(
  usage: TokenUsage | undefined,
): WireTokens | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(usage.models
      ? {
          models: Object.fromEntries(
            Object.entries(usage.models).map(([name, model]) => [
              name,
              {
                prompt_tokens: model.promptTokens,
                completion_tokens: model.completionTokens,
                total_tokens: model.totalTokens,
                requests: model.requests,
              },
            ]),
          ),
        }
      : {}),
  };
}
export function sumPlannerUsage(
  messages: Iterable<PlannerMessageUsage | undefined>,
  opts?: { durationMs?: number },
): DialogueUsage | undefined {
  let planner: TokenUsage | undefined;
  let plannerMs: number | undefined;
  const tasks = new Map<
    string,
    { worker: string; usage: TokenUsage; durationMs?: number }
  >();
  for (const usage of messages) {
    if (usage?.plannerMs !== undefined)
      plannerMs = (plannerMs ?? 0) + usage.plannerMs;
    planner = addTokenUsage(planner, usage?.planner);
    for (const task of usage?.tasks ?? []) {
      const combined = addTokenUsage(tasks.get(task.id)?.usage, task.usage);
      const previousMs = tasks.get(task.id)?.durationMs;
      const durationMs =
        task.durationMs === undefined
          ? previousMs
          : Math.max(previousMs ?? task.durationMs, task.durationMs);
      if (combined)
        tasks.set(task.id, {
          worker: task.worker,
          usage: combined,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
    }
  }
  let total = planner;
  for (const task of tasks.values()) total = addTokenUsage(total, task.usage);
  if (!total) return undefined;
  return {
    ...total,
    x_hub: {
      ...(opts?.durationMs !== undefined
        ? { duration_ms: opts.durationMs }
        : {}),
      ...(planner
        ? {
            planner: {
              ...tokenUsageToWire(planner),
              ...(plannerMs !== undefined ? { duration_ms: plannerMs } : {}),
            },
          }
        : plannerMs !== undefined
          ? { planner: { duration_ms: plannerMs } }
          : {}),
      ...(tasks.size
        ? {
            subagents: Array.from(tasks, ([task_id, task]) => ({
              ...tokenUsageToWire(task.usage),
              ...(task.durationMs !== undefined
                ? { duration_ms: task.durationMs }
                : {}),
              task_id,
              worker: task.worker,
            })),
          }
        : {}),
    },
  };
}
export function dialogueUsageToWire(usage: DialogueUsage | undefined) {
  if (!usage) return undefined;
  return { ...tokenUsageToWire(usage), x_hub: usage.x_hub };
}
function isDialogueUsage(usage: TokenUsage): usage is DialogueUsage {
  return (
    'x_hub' in usage && typeof usage.x_hub === 'object' && usage.x_hub !== null
  );
}
export function responseUsageToWire(
  usage: TokenUsage | undefined,
): (WireTokens & { x_hub?: HubUsageBreakdown }) | undefined {
  if (!usage) return undefined;
  return {
    ...tokenUsageToWire(usage),
    ...(isDialogueUsage(usage) ? { x_hub: usage.x_hub } : {}),
  };
}
