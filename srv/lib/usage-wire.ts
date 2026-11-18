import {
  addTokenUsage,
  type PlannerMessageUsage,
  type TokenUsage,
} from '@mcp-abap-adt/llm-agent';
import { reconcileTokenUsage } from './llm-failure';

interface WireModelTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface WireTokens {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens: number };
  models?: Record<string, WireModelTokens>;
}
export type WireAgentUsage = WireTokens & { duration_ms?: number };
export interface HubUsageBreakdown {
  duration_ms?: number;
  planner?: WireAgentUsage | { duration_ms: number };
  subagents?: Array<WireAgentUsage & { task_id: string; worker: string }>;
}
export type DialogueUsage = TokenUsage & { x_hub: HubUsageBreakdown };

export function timedUsageToWire(
  usage: TokenUsage | undefined,
  duration_ms?: number,
): WireAgentUsage | undefined {
  return (
    usage && {
      ...tokenUsageToWire(usage),
      ...(duration_ms === undefined ? {} : { duration_ms }),
    }
  );
}
export function tokenUsageToWire(usage: TokenUsage, model?: string): WireTokens;
export function tokenUsageToWire(
  usage: TokenUsage | undefined,
  model?: string,
): WireTokens | undefined;
export function tokenUsageToWire(
  usage: TokenUsage | undefined,
  model?: string,
): WireTokens | undefined {
  if (!usage) return undefined;
  const models = Object.entries(usage.models ?? {});
  const selected =
    models.length === 0
      ? usage
      : model === undefined && models.length === 1
        ? models[0][1]
        : models.find(([name]) => name === model)?.[1];
  return {
    ...(selected
      ? {
          prompt_tokens: selected.promptTokens,
          completion_tokens: selected.completionTokens,
          total_tokens: selected.totalTokens,
          ...(selected.cachedInputTokens !== undefined
            ? {
                prompt_tokens_details: {
                  cached_tokens: selected.cachedInputTokens,
                },
              }
            : {}),
        }
      : {}),
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
                ...(model.cachedInputTokens !== undefined
                  ? { cached_input_tokens: model.cachedInputTokens }
                  : {}),
                ...(model.cacheCreationInputTokens !== undefined
                  ? {
                      cache_creation_input_tokens:
                        model.cacheCreationInputTokens,
                    }
                  : {}),
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
      const previous = tasks.get(task.id);
      const combined = reconcileTokenUsage(previous?.usage, task.usage);
      const previousMs = previous?.durationMs;
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
export function dialogueUsageToWire(
  usage: DialogueUsage | undefined,
  model?: string,
) {
  if (!usage) return undefined;
  return { ...tokenUsageToWire(usage, model), x_hub: usage.x_hub };
}
function isDialogueUsage(usage: TokenUsage): usage is DialogueUsage {
  return (
    'x_hub' in usage && typeof usage.x_hub === 'object' && usage.x_hub !== null
  );
}
export function responseUsageToWire(
  usage: TokenUsage | undefined,
  model?: string,
): (WireTokens & { x_hub?: HubUsageBreakdown }) | undefined {
  if (!usage) return undefined;
  return {
    ...tokenUsageToWire(usage, model),
    ...(isDialogueUsage(usage) ? { x_hub: usage.x_hub } : {}),
  };
}

export const emptyOpenAiUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

export function openAiUsageToWire(
  usage: TokenUsage | undefined,
  model: string,
) {
  const wire = responseUsageToWire(usage, model);
  return wire ? { ...emptyOpenAiUsage, ...wire } : undefined;
}
