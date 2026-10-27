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
export interface HubUsageBreakdown {
  planner?: WireTokens;
  subagents?: Array<WireTokens & { task_id: string; worker: string }>;
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
): DialogueUsage | undefined {
  let planner: TokenUsage | undefined;
  const tasks = new Map<string, { worker: string; usage: TokenUsage }>();
  for (const usage of messages) {
    planner = addTokenUsage(planner, usage?.planner);
    for (const task of usage?.tasks ?? []) {
      const combined = addTokenUsage(tasks.get(task.id)?.usage, task.usage);
      if (combined)
        tasks.set(task.id, { worker: task.worker, usage: combined });
    }
  }
  let total = planner;
  for (const task of tasks.values()) total = addTokenUsage(total, task.usage);
  if (!total) return undefined;
  return {
    ...total,
    x_hub: {
      ...(planner ? { planner: tokenUsageToWire(planner) } : {}),
      ...(tasks.size
        ? {
            subagents: Array.from(tasks, ([task_id, task]) => ({
              ...tokenUsageToWire(task.usage),
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
