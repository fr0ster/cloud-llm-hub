import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  IConcurrencyPool,
  ILlm,
  ISubAgent,
  ISubAgentResult,
  PlannerMessage,
  TaskRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  SemaphorePool,
  type SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import { getAgentConfig } from '../agent-config';
import {
  buildPlannerAgent,
  getSmartAgent,
  releasePlannerAgent,
  runWithRequestConnection,
} from '../agent-manager';
import {
  getRequestHistory,
  runWithSessionId,
  runWithToolGateBypass,
} from '../request-session';
import {
  createDialogueStateStore,
  deleteDialogueState,
} from './dialogue-store';
import { admitBackground, type PipelineSession } from './gatekeeper';
import { renderNotice } from './notify-policy';
import type { RecordingMcpClient } from './recording-mcp-client';
import { runWithRequestSystem } from './request-system-context';
import { getReviewSignals } from './review-scope';
import {
  type ConnectionLease,
  SessionConnectionFactory,
  SessionConnectionPool,
} from './session-connection-pool';
import { evaluateGated } from './step-reviewer';

export type DialogueEvent =
  | { kind: 'message'; message: PlannerMessage }
  | {
      kind: 'task';
      task: Pick<TaskRecord, 'id' | 'worker' | 'goal' | 'state'>;
    };
export interface DialogueHandle {
  session: DialogueSession;
  factory: SessionConnectionFactory;
  pool: SessionConnectionPool;
  subscribe(fn: (e: DialogueEvent) => void): () => void;
}
interface LiveHandle extends DialogueHandle {
  planner: SmartAgent;
  stop(): void;
}
const handles = new Map<string, Promise<LiveHandle>>();
const closing = new Map<string, Promise<void>>();
let executorPool: IConcurrencyPool | undefined;
export function sharedExecutorPool(): IConcurrencyPool {
  executorPool ??= new SemaphorePool(
    getAgentConfig().agent.dialogue.executorPool,
  );
  return executorPool;
}
const slot = (userId: string, key: string) => JSON.stringify([userId, key]);

export function dialogueFor(
  userId: string,
  key: string,
  destination: string,
): Promise<DialogueHandle> {
  const id = slot(userId, key);
  if (closing.has(id))
    return Promise.reject(new Error('dialogue session closing'));
  const existing = handles.get(id);
  if (existing) return existing;
  const opening = open(userId, key, destination);
  handles.set(id, opening);
  void opening.catch(() => {
    if (handles.get(id) === opening) handles.delete(id);
  });
  return opening;
}
async function open(
  userId: string,
  key: string,
  destination: string,
): Promise<LiveHandle> {
  const config = getAgentConfig();
  const destinationHandle = (await getSmartAgent(
    undefined,
    destination,
  )) as Awaited<ReturnType<typeof getSmartAgent>> & {
    workers: ReadonlyMap<string, ISubAgent>;
    recMcp: RecordingMcpClient;
    criticLlm: ILlm;
  };
  if (!destinationHandle.workers)
    throw new Error('Destination executor workers unavailable');
  const planner = await buildPlannerAgent(config);
  const factory = new SessionConnectionFactory(userId, key);
  const pool = new SessionConnectionPool(
    factory,
    config.agent.dialogue.executors,
  );
  const subscribers = new Set<(e: DialogueEvent) => void>();
  const lifetime = new AbortController();
  let stopped = false;
  let session: DialogueSession | undefined;
  const emit = (event: DialogueEvent) => {
    if (stopped) return;
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        /* Observers cannot break work. */
      }
    }
  };
  const taskStates = new Map<string, TaskRecord['state']>();
  const emitTask = (
    task: Pick<TaskRecord, 'id' | 'worker' | 'goal' | 'state'>,
  ) => {
    if (taskStates.get(task.id) === task.state) return;
    taskStates.set(task.id, task.state);
    emit({
      kind: 'task',
      task: {
        id: task.id,
        worker: task.worker,
        goal: task.goal,
        state: task.state,
      },
    });
  };
  // TaskBoard's wrapRun callback has no task history argument. Carry the
  // lease/admission into its run callback; the worker adapter supplies the
  // task's own history while rebuilding the execute_step ALS stack.
  const scope = new AsyncLocalStorage<{
    lease: ConnectionLease;
    pipeline: PipelineSession;
    traceId: string;
  }>();
  const workers = new Map<string, ISubAgent>();
  for (const [name, worker] of destinationHandle.workers) {
    workers.set(name, {
      name: worker.name,
      description: worker.description,
      capabilities: worker.capabilities,
      async run(input) {
        const ctx = scope.getStore();
        if (!ctx) throw new Error('Background task context unavailable');
        return runWithRequestSystem(ctx.lease.system, () =>
          runWithSessionId(
            key,
            () =>
              runWithRequestConnection(
                ctx.lease.connection,
                async () => {
                  const result = await runWithToolGateBypass(() =>
                    worker.run({
                      ...input,
                      trace: { traceId: ctx.traceId },
                      signal: ctx.pipeline.signal,
                    }),
                  );
                  if (
                    result.errorClass === 'epicfail' ||
                    result.stopped ||
                    result.status === 'awaiting-external'
                  )
                    return result;
                  const verdict = await evaluateGated({
                    content: result.output,
                    records: destinationHandle.recMcp.getToolRecords(
                      ctx.traceId,
                    ),
                    ...getReviewSignals(),
                    llm: destinationHandle.criticLlm,
                    request: input.task,
                    task: input.task,
                    history: getRequestHistory(),
                  });
                  return verdict.ok
                    ? result
                    : {
                        ...result,
                        output: result.output + renderNotice(verdict),
                      };
                },
                ctx.lease.dumpScope,
                factory.exposition,
              ),
            input.history ?? [],
            userId,
          ),
        );
      },
    });
  }
  const store = createDialogueStateStore(userId, key);
  try {
    session = await DialogueSession.open({
      id: key,
      planner: {
        async process(input, options) {
          try {
            return await planner.process(input, options);
          } finally {
            for (const task of session?.snapshot().tasks ?? []) emitTask(task);
          }
        },
      },
      // Library close always deletes. The hub owns deletion by close reason:
      // shutdown preserves the last saved state for revival.
      store: { ...store, delete: async () => {} },
      board: {
        workers,
        maxConcurrent: config.agent.dialogue.executors,
        maxTasks: config.agent.dialogue.maxTasks,
        // TaskBoard owns the outer pool slot, including cancellation and release.
        pool: sharedExecutorPool(),
        baseInput: () => ({ sessionId: key }),
        async wrapRun(task, run) {
          let lease: ConnectionLease | undefined;
          let pipeline: PipelineSession | undefined;
          let healthy = false;
          let state: TaskRecord['state'] = 'failed';
          const traceId = randomUUID();
          emitTask(task);
          try {
            const acquiredLease = await pool.acquire(lifetime.signal);
            lease = acquiredLease;
            const admission = await admitBackground(
              userId,
              key,
              lifetime.signal,
            );
            if (!('admitted' in admission))
              throw new Error(
                'Background task admission refused: session closed or unavailable',
              );
            pipeline = admission.admitted;
            const result: ISubAgentResult = await pipeline.run(() =>
              scope.run(
                {
                  lease: acquiredLease,
                  pipeline: admission.admitted,
                  traceId,
                },
                run,
              ),
            );
            healthy =
              !lifetime.signal.aborted &&
              result.errorClass !== 'epicfail' &&
              !result.stopped &&
              result.status !== 'awaiting-external';
            state = healthy ? 'done' : result.stopped ? 'stopped' : 'failed';
            return result;
          } finally {
            try {
              await pipeline?.drain();
            } finally {
              try {
                pipeline?.release();
              } finally {
                try {
                  await lease?.release(healthy);
                } finally {
                  try {
                    destinationHandle.recMcp.dropRequest(traceId);
                  } catch (error) {
                    cds.log('dialogue-sessions').warn('dropRequest failed', {
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                  emitTask({ ...task, state });
                }
              }
            }
          }
        },
      },
      onMessage(message) {
        if (stopped || !subscribers.size) return;
        emit({ kind: 'message', message });
        session?.takePending();
      },
    });
  } catch (error) {
    releasePlannerAgent(planner);
    await pool.closeAll();
    throw error;
  }
  return {
    session,
    factory,
    pool,
    planner,
    stop() {
      stopped = true;
      lifetime.abort();
      subscribers.clear();
    },
    subscribe(fn) {
      if (!stopped) subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
export function closeDialogue(
  userId: string,
  key: string,
  reason: 'explicit' | 'ttl' | 'shutdown',
  deleteState = true,
): Promise<void> {
  const id = slot(userId, key);
  const inFlight = closing.get(id);
  if (inFlight) return inFlight;
  const pending = handles.get(id);
  const close = (async () => {
    try {
      const h = await pending;
      if (h) {
        h.stop();
        try {
          await h.session.close();
        } finally {
          try {
            await h.pool.closeAll();
          } finally {
            releasePlannerAgent(h.planner);
          }
        }
      }
    } finally {
      handles.delete(id);
      if (reason !== 'shutdown' && deleteState) {
        try {
          await deleteDialogueState(userId, key);
        } catch {
          cds
            .log('dialogue-sessions')
            .warn('Dialogue state deletion failed; TTL sweep will retry');
        }
      }
    }
  })();
  closing.set(id, close);
  void close.finally(() => closing.delete(id)).catch(() => {});
  return close;
}
