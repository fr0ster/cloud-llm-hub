import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { PlannerToolsClient } from '@mcp-abap-adt/llm-agent-libs';
import { z } from 'zod';
import type { getSmartAgent as SmartAgentFactory } from '../agent-manager';
import { getRequestSessionId, getRequestUserId } from '../request-session';
import {
  EXECUTE_STEP_DESCRIPTION,
  executeStepSchema,
  listDestinations,
  listDestinationsDefinition,
} from './coordinator-tool-definitions';
import type {
  runExecutorStep as ExecutorStep,
  ExecutorStepArgs,
} from './executor-step';
import { longSessionsIfReady } from './long-session';
import { orchestrationDefinitions } from './orchestration-tool-definitions';

export type CoordinatorRun = <T extends { ok: boolean }>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
) => Promise<T>;

const coordinatorRuns = new AsyncLocalStorage<CoordinatorRun>();

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
export function coordinatorToolsClient({
  getSmartAgent,
  runExecutorStep,
  wrapRun,
}: {
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
          {
            name: 'execute_step',
            description: EXECUTE_STEP_DESCRIPTION,
            inputSchema: z.toJSONSchema(z.object(executeStepSchema)),
          },
          {
            name: 'list_destinations',
            description: listDestinationsDefinition.description,
            inputSchema: z.toJSONSchema(z.object({})),
          },
        ],
      };
    },
    callTool: async (name, args, options) => {
      if (name === 'list_destinations')
        return { ok: true, value: await listDestinations() };
      if (name !== 'execute_step') return planner.callTool(name, args);
      const input = z.object(executeStepSchema).parse(args);
      const userId = getRequestUserId();
      const sessionId = getRequestSessionId();
      const session =
        userId && sessionId
          ? longSessionsIfReady()?.get(userId, sessionId)
          : undefined;
      if (!userId || !sessionId || !session?.destination)
        throw new Error('Session request scope required');
      if (input.session && input.session !== sessionId)
        throw new Error('Session differs from current session');
      if (input.destination && input.destination !== session.destination)
        throw new Error('Destination differs from session destination');
      const handle = await getSmartAgent(undefined, session.destination);
      const traceId = randomUUID();
      try {
        const result = await wrapRun((signal) =>
          runExecutorStep(
            handle,
            userId,
            input.task,
            input.worker ?? 'executor',
            {
              ...options,
              signal,
              sessionId,
              trace: { ...options?.trace, traceId },
              usage: options?.usage?.with({ traceId }),
            },
          ),
        );
        return {
          ok: true,
          value: {
            content: result.ok
              ? (result.value.content ?? '')
              : String(result.error),
            isError: !result.ok,
          },
        };
      } finally {
        handle.recMcp?.dropRequest(traceId);
      }
    },
  };
}
