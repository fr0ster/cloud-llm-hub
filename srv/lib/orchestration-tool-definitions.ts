import type { IAgentProfileSource } from '@mcp-abap-adt/llm-agent';
import {
  PlannerToolsClient,
  runInPlannerScope,
  TaskBoard,
} from '@mcp-abap-adt/llm-agent-libs';

export const orchestrationTools = [
  'plan_create',
  'plan_revise',
  'plan_get',
  'plan_update',
  'delegate_task',
  'get_task',
  'list_tasks',
  'stop_task',
] as const;
export type OrchestrationTool = (typeof orchestrationTools)[number];
// The library owns the schemas, including nested plan steps and descriptions.
export async function orchestrationDefinitions(source?: IAgentProfileSource) {
  const board = new TaskBoard({
    onEvent() {},
    ...(source
      ? {
          profileSource: source,
          profileRunner: {
            createWorker: async () => {
              throw new Error('Schema discovery only');
            },
            preparePlanner: async () => {
              throw new Error('Schema discovery only');
            },
          },
        }
      : {}),
  });
  const unavailable = async () => ({
    ok: false as const,
    error: { code: 'unavailable' as const, message: 'Schema discovery only' },
  });
  return runInPlannerScope(
    {
      board,
      getPlan: () => undefined,
      setPlan() {},
      planAuthor: { create: unavailable, revise: unavailable },
    },
    async () => {
      const result = await new PlannerToolsClient().listTools();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.filter((tool) =>
        orchestrationTools.some((name) => name === tool.name),
      );
    },
  );
}
