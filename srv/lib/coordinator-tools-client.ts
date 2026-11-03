import { AsyncLocalStorage } from 'node:async_hooks';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { PlannerToolsClient } from '@mcp-abap-adt/llm-agent-libs';
import type { getSmartAgent as SmartAgentFactory } from '../agent-manager';
import type {
  runExecutorStep as ExecutorStep,
  ExecutorStepArgs,
} from './executor-step';
import { orchestrationDefinitions } from './orchestration-tool-definitions';

export type CoordinatorRun = <T extends { ok: boolean }>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
) => Promise<T>;

const coordinatorRuns = new AsyncLocalStorage<CoordinatorRun>();

// Capture only the original delegate argument before the library appends results.
// TaskBoard scheduling preserves this scope through queue waits and worker runs.
const delegateBriefs = new AsyncLocalStorage<string>();

export function currentDelegateBrief(): string {
  return delegateBriefs.getStore() ?? '';
}

export function withDelegateBrief<T>(
  name: string,
  args: Parameters<IMcpClient['callTool']>[1],
  run: () => T,
): T {
  return name === 'delegate_task'
    ? delegateBriefs.run(
        typeof args.context === 'string' ? args.context : '',
        run,
      )
    : run();
}

/** Carries the dialogue's connection/admission runner into planner construction. */
export function withCoordinatorRun<T>(
  run: CoordinatorRun,
  prepare: () => T,
): T {
  return coordinatorRuns.run(run, prepare);
}

export function currentCoordinatorRun(): CoordinatorRun {
  return (
    coordinatorRuns.getStore() ??
    (async () => {
      throw new Error('Session execution scope required');
    })
  );
}

/** Preserves library planner tools and adds session-scoped hub tools. */
export function coordinatorToolsClient(_dependencies: {
  wrapRun: CoordinatorRun;
  getSmartAgent: typeof SmartAgentFactory;
  runExecutorStep: (
    ...args: ExecutorStepArgs
  ) => ReturnType<typeof ExecutorStep>;
}): IMcpClient {
  const planner = new PlannerToolsClient();
  return {
    listTools: async () => {
      const result = await planner.listTools();
      if (!result.ok) return result;
      const definitions = await orchestrationDefinitions();
      return {
        ok: true,
        value: [
          ...result.value,
          ...definitions.filter(
            (tool) =>
              !result.value.some((existing) => existing.name === tool.name),
          ),
        ],
      };
    },
    callTool: async (name, args) => {
      if (name === 'execute_step' || name === 'list_destinations')
        return {
          ok: true,
          value: {
            isError: true,
            content: 'Tool unavailable to coordinator. Use delegate_task.',
          },
        };
      return withDelegateBrief(name, args, () => planner.callTool(name, args));
    },
  };
}
