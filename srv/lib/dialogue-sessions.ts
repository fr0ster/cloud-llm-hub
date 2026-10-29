import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type {
  DialogueSignals,
  DialogueState,
  IConcurrencyPool,
  ILlm,
  ISubAgent,
  ISubAgentResult,
  IUsageRecorder,
  PlannerMessage,
  TaskRecord,
  TokenUsage,
} from '@mcp-abap-adt/llm-agent';
import { addTokenUsage } from '@mcp-abap-adt/llm-agent';
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
import { runWithContextCapture } from './context-capture';
import { DialogueOutbox, type OutboxEntry } from './dialogue-outbox';
import {
  plannerWithAttachments,
  plannerWithEnvironment,
  plannerWithParagraphs,
} from './dialogue-planner-content';
import { runWithDialogueRagTools } from './dialogue-rag-tools';
import { dialogueSignals } from './dialogue-signals';
import {
  createDialogueStateStore,
  deleteDialogueState,
  getDialogueStoreBackend,
  type HubDialogueState,
  touchDialogueState,
} from './dialogue-store';
import { admitBackground, type PipelineSession } from './gatekeeper';
import { longSessionsIfReady } from './long-session';
import { stripNoMessage } from './no-message';
import { renderNotice } from './notify-policy';
import { plannerSessionOptions } from './planner-memory';
import type { RecordingMcpClient } from './recording-mcp-client';
import { runWithRequestSystem } from './request-system-context';
import { getReviewSignals } from './review-scope';
import {
  type ConnectionLease,
  SessionConnectionFactory,
  SessionConnectionPool,
} from './session-connection-pool';
import { evaluateGated } from './step-reviewer';
import { cachedSystemIdentity } from './system-identity-cache';
import { type TaskView, taskView } from './task-view';
import { usageRuntime } from './usage/runtime';

type Plan = Exclude<DialogueState['plan'], string | undefined>;
type PlanStep = Plan['steps'][number];

export interface PlannerCounts {
  toolsSelected?: number;
  toolsAvailable?: number;
  toolCalls?: number;
  maxToolCalls?: number;
}

export type DialogueEvent =
  | ({ kind: 'planner' } & PlannerCounts)
  | ({ kind: 'wait' } & DialogueSignals['dialogue.wait'])
  | { kind: 'settled'; outcome: 'ok' | 'failed'; trigger: 'user' | 'event' }
  | { kind: 'message'; message: PlannerMessage }
  | { kind: 'usage'; id: string; usage: NonNullable<PlannerMessage['usage']> }
  | { kind: 'plan'; plan: DialoguePlan }
  | {
      kind: 'task';
      task: TaskView;
    };
export interface DialoguePlan {
  text?: string;
  steps?: PlanStep[];
  status: 'active' | 'waiting_user' | 'done';
}

/** Absent plans emit nothing; session reset clears the WebUI locally. */
export function dialoguePlan(
  state: ReturnType<DialogueSession['snapshot']>,
): DialoguePlan | undefined {
  return state.plan === undefined
    ? undefined
    : typeof state.plan === 'string'
      ? { text: state.plan, status: state.planStatus ?? 'active' }
      : {
          steps: state.plan.steps,
          text: state.plan.note,
          status: state.plan.status,
        };
}
export interface DialogueHandle {
  destination: string;
  session: DialogueSession;
  usage?: IUsageRecorder;
  attachments: WeakMap<object, string>;
  replies: WeakMap<object, { id: string; createdAt: number }>;
  outbox: DialogueOutbox;
  state(): {
    turnActive: boolean;
    queuedInputs?: number;
    running: number;
    total: number;
    done: number;
    status?: 'active' | 'waiting_user' | 'done';
    idle: boolean;
    settledSeq: number;
    lastFailedSeq: number;
  };
  plannerCounts(counts: PlannerCounts): void;
  hasSubscribers(): boolean;
  drainPending(): Promise<void>;
  factory: SessionConnectionFactory;
  pool: SessionConnectionPool;
  subscribe(fn: (e: DialogueEvent) => void, cursor?: string): () => void;
}
interface LiveHandle extends DialogueHandle {
  planner: SmartAgent;
  stop(): void;
}
const handles = new Map<string, Promise<LiveHandle>>();
const log = () => cds.log('dialogue');
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
const creationListeners = new Map<
  string,
  Set<(handle: DialogueHandle) => void>
>();
export function lookupDialogue(
  userId: string,
  key: string,
  destination?: string,
): Promise<DialogueHandle | undefined> {
  return Promise.resolve(handles.get(slot(userId, key))).then((handle) => {
    if (
      handle &&
      destination !== undefined &&
      handle.destination !== destination
    )
      throw destinationFixed();
    return handle;
  });
}
function destinationFixed() {
  return Object.assign(
    new Error(
      'The dialogue destination is fixed for the lifetime of the session',
    ),
    { code: 'DIALOGUE_DESTINATION_FIXED', statusCode: 409 },
  );
}
export function onDialogueCreated(
  userId: string,
  key: string,
  fn: (handle: DialogueHandle) => void,
): () => void {
  const id = slot(userId, key);
  const listeners = creationListeners.get(id) ?? new Set();
  creationListeners.set(id, listeners);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) creationListeners.delete(id);
  };
}
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
  if (existing)
    return lookupDialogue(userId, key, destination) as Promise<DialogueHandle>;
  const registry = longSessionsIfReady();
  const session = registry?.get(userId, key);
  if (session) {
    if (
      session.destination !== undefined &&
      session.destination !== destination
    )
      return Promise.reject(destinationFixed());
    session.destination = destination;
    registry?.touch(userId, key);
  }
  const opening = open(userId, key, destination).then((handle) => {
    for (const fn of creationListeners.get(id) ?? []) {
      try {
        fn(handle);
      } catch {
        /* Observer isolation. */
      }
    }
    return handle;
  });
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
  const usage = usageRuntime()?.forSession({
    sessionId: key,
    userId,
    destination,
  });
  const factory = new SessionConnectionFactory(userId, key);
  const attachments = new WeakMap<object, string>();
  const replies = new WeakMap<object, { id: string; createdAt: number }>();
  let turnReply: { id: string; createdAt: number } | undefined;
  // Planner usage of the user turn, summed over corrective calls; published with
  // the reply so live subscribers see it on first emission.
  const replyUsage = new WeakMap<object, TokenUsage>();
  let turnReplyUsage: TokenUsage | undefined;
  const turnPlanner = plannerWithEnvironment(
    plannerWithAttachments(plannerWithParagraphs(planner), attachments),
    () => {
      const connection = longSessionsIfReady()?.get(userId, key)?.connection;
      const identity = connection
        ? cachedSystemIdentity(connection)
        : undefined;
      return [
        'Environment',
        `Destination: ${destination}`,
        ...factory.environment(destination),
        ...(identity?.masterSystem
          ? [`SAP system id: ${identity.masterSystem}`]
          : []),
        ...(identity?.responsible
          ? [`SAP login: ${identity.responsible}`]
          : []),
        'Available workers:',
        ...[...destinationHandle.workers].map(
          ([name, worker]) => `${name}: ${worker.description}`,
        ),
        `Concurrency limit: ${config.agent.dialogue.executors} (shared executor pool: ${config.agent.dialogue.executorPool})`,
      ].join('\n');
    },
  );
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
  let lastPlan: DialoguePlan | undefined;
  const emitPlan = (state: DialogueState) => {
    const plan = dialoguePlan(state);
    if (plan && JSON.stringify(plan) !== JSON.stringify(lastPlan))
      emit({ kind: 'plan', plan });
    lastPlan = plan;
  };
  const emitTask = (task: TaskView) => {
    if (taskStates.get(task.id) === task.state) return;
    taskStates.set(task.id, task.state);
    emit({ kind: 'task', task: taskView(task) });
  };
  // Carry task admission into the worker callback and rebuild its request scope.
  // Dialogue workers receive only their brief; no request history is injected.
  const scope = new AsyncLocalStorage<{
    lease: ConnectionLease;
    pipeline: PipelineSession;
    traceId: string;
    taskId: string;
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
        input.stopSignal?.addEventListener(
          'abort',
          () => {
            log().info('stop requested', {
              id: ctx.taskId,
              reason: 'cooperative stop',
            });
          },
          { once: true },
        );
        return runWithRequestSystem(ctx.lease.system, () =>
          runWithSessionId(
            key,
            () =>
              runWithRequestConnection(
                ctx.lease.connection,
                async () => {
                  const result = await runWithToolGateBypass(() =>
                    runWithDialogueRagTools(() =>
                      runWithContextCapture(
                        {
                          component:
                            name === 'checker' ? 'checker' : 'executor',
                          taskId: ctx.taskId,
                          sessionKey: key,
                        },
                        () =>
                          worker.run({
                            ...input,
                            trace: { traceId: ctx.traceId },
                            signal: ctx.pipeline.signal,
                          }),
                      ),
                    ),
                  );
                  if (
                    result.errorClass === 'epicfail' ||
                    result.stopped ||
                    result.status === 'awaiting-external'
                  )
                    return result;
                  const verdict = await evaluateGated({
                    usage: input.usage,
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
                  return {
                    ...result,
                    usage: addTokenUsage(result.usage, verdict.usage),
                    output: verdict.ok
                      ? result.output
                      : result.output + renderNotice(verdict),
                  };
                },
                ctx.lease.dumpScope,
                factory.exposition,
              ),
            undefined,
            userId,
          ),
        );
      },
    });
  }
  const store = createDialogueStateStore(userId, key);
  const backend = getDialogueStoreBackend();
  let savedState: HubDialogueState | undefined;
  try {
    savedState = await backend.load(userId, key);
  } catch (error) {
    releasePlannerAgent(planner);
    await pool.closeAll();
    throw error;
  }
  let saving = Promise.resolve();
  const persist = (
    outboxMessages: OutboxEntry[],
    ackMode: boolean,
  ): Promise<void> => {
    const state = session?.snapshot() ?? savedState;
    if (!state) return Promise.resolve();
    const row = { ...state, pending: [], outbox: outboxMessages, ackMode };
    saving = saving.catch(() => {}).then(() => backend.save(userId, key, row));
    return saving;
  };
  const outbox: DialogueOutbox = new DialogueOutbox(
    savedState?.outbox ?? [],
    (messages, ackMode) => persist(messages, ackMode),
    savedState?.ackMode,
  );
  const drainPending = async () => {
    await outbox.add(session?.takePending() ?? []);
  };
  const signals = dialogueSignals();
  const registry = longSessionsIfReady();
  const longSession = registry?.get(userId, key);
  let releaseHold: (() => void) | undefined;
  const releaseLifetime = () => {
    releaseHold?.();
    releaseHold = undefined;
  };
  const unsubscribeActivity = signals.on(
    'dialogue.activity',
    ({ payload }) => {
      if (
        payload.running > 0 ||
        payload.turnActive ||
        payload.queuedInputs > 0
      ) {
        if (!releaseHold && longSession)
          releaseHold = registry?.hold(longSession);
      } else releaseLifetime();
    },
    { source: key },
  );
  const unsubscribeClosed = signals.on(
    'dialogue.session.closed',
    () => stopLifetime(),
    { source: key },
  );
  let settledSeq = 0;
  let lastFailedSeq = 0;
  const unsubscribeSettled = signals.on(
    'dialogue.turn.settled',
    async ({ payload: { outcome, trigger } }) => {
      settledSeq++;
      if (outcome === 'failed') lastFailedSeq = settledSeq;
      turnReply = undefined;
      turnReplyUsage = undefined;
      await outbox.flushed();
      emit({ kind: 'settled', outcome, trigger });
    },
    { source: key },
  );
  const unsubscribeWait = signals.on(
    'dialogue.wait',
    ({ payload: { tasks } }) => emit({ kind: 'wait', tasks }),
    { source: key },
  );
  const stopLifetime = () => {
    unsubscribeWait();
    unsubscribeActivity();
    unsubscribeClosed();
    unsubscribeSettled();
    releaseLifetime();
  };
  try {
    session = await DialogueSession.open({
      ...(await plannerSessionOptions(userId, key)),
      ...(usage ? { usage } : {}),
      id: key,
      signals,
      planner: {
        async process(input, options) {
          const reply = options.trace && replies.get(options.trace);
          turnReply = undefined;
          turnReplyUsage = undefined;
          try {
            const result = await runWithContextCapture(
              { component: 'planner', sessionKey: key },
              () => turnPlanner.process(input, options),
            );
            // The library appends this successful result before its final save.
            if (result.ok) {
              turnReply = reply;
              const trace = options.trace;
              const usage =
                reply && trace
                  ? addTokenUsage(replyUsage.get(trace), result.value.usage)
                  : undefined;
              if (trace && usage) replyUsage.set(trace, usage);
              turnReplyUsage = usage;
            }
            return result;
          } finally {
            for (const task of session?.snapshot().tasks ?? []) emitTask(task);
          }
        },
      },
      // Library close always deletes. The hub owns deletion by close reason:
      // shutdown preserves the last saved state for revival.
      store: {
        ...store,
        load: async () => {
          if (!savedState) return undefined;
          const { outbox: _outbox, ...state } = savedState;
          return state;
        },
        save: async (_id, state) => {
          savedState = state;
          // turn() has recomputed plan status before persisting, including
          // turns triggered by background task events.
          emitPlan(state);
          const assistant = turnReply
            ? [...state.conversation]
                .reverse()
                .find((message) => message.role === 'assistant')
            : undefined;
          const text = stripNoMessage(
            typeof assistant?.content === 'string' ? assistant.content : '',
          );
          await outbox.upsert(
            turnReply && text.trim()
              ? [
                  {
                    id: turnReply.id,
                    createdAt: turnReply.createdAt,
                    text,
                    trigger: 'user',
                    ...(turnReplyUsage
                      ? { usage: { planner: turnReplyUsage } }
                      : {}),
                  },
                ]
              : [],
            state.pending,
          );
        },
        delete: async () => {},
      },
      taskOutputChars: config.agent.dialogue.taskOutputChars,
      maxCorrections: config.agent.dialogue.maxCorrections,
      waitTickMs: config.agent.dialogue.waitTickMs,
      longTaskMs: config.agent.dialogue.longTaskMs,
      board: {
        workers,
        maxConcurrent: config.agent.dialogue.executors,
        maxTasks: config.agent.dialogue.maxTasks,
        // TaskBoard owns the outer pool slot, including cancellation and release.
        pool: sharedExecutorPool(),
        baseInput: () => ({ sessionId: key }),
        async wrapRun(task, run) {
          const startedAt = Date.now();
          // No free text from goals or errors reaches the logs: a goal may carry
          // whatever the user typed, credentials included. Ids correlate with
          // the task events the WebUI shows.
          log().info('task started', {
            id: task.id,
            worker: task.worker,
            goalChars: task.goal.length,
          });
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
                  taskId: task.id,
                },
                () =>
                  runWithContextCapture(
                    { component: 'other', taskId: task.id, sessionKey: key },
                    run,
                  ),
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
                      errorType:
                        error instanceof Error ? error.name : typeof error,
                    });
                  }
                  emitTask({ ...task, state });
                  log().info('task finished', {
                    id: task.id,
                    state,
                    durationMs: Date.now() - startedAt,
                  });
                  if (stopped)
                    log().info('close progress', {
                      keyHash: keyHash(key),
                      tasksRemaining: [...taskStates.values()].filter(
                        (s) => s === 'running' || s === 'queued',
                      ).length,
                    });
                }
              }
            }
          }
        },
      },
      onMessage(message) {
        if (stopped) return;
        void outbox
          .add([message, ...(session?.takePending() ?? [])])
          .catch(() => {
            /* Retain in memory and retry persistence on next save. */
          });
      },
    });
    await drainPending();
  } catch (error) {
    stopLifetime();
    await session?.close();
    releasePlannerAgent(planner);
    await pool.closeAll();
    throw error;
  }
  lastPlan = dialoguePlan(session.snapshot());
  const send = session.send.bind(session);
  session.send = (...args) => send(...args).finally(drainPending);
  return {
    destination,
    session,
    ...(usage ? { usage } : {}),
    attachments,
    replies,
    outbox,
    state() {
      const activity = signals.last('dialogue.activity', key)?.payload;
      const plan = signals.last('dialogue.plan.changed', key)?.payload;
      return {
        settledSeq,
        lastFailedSeq,
        turnActive: activity?.turnActive ?? false,
        queuedInputs: activity?.queuedInputs,
        running: activity?.running ?? 0,
        total: plan?.total ?? 0,
        done: plan?.done ?? 0,
        status: plan?.status,
        idle:
          plan?.status === 'active' &&
          activity !== undefined &&
          !activity.turnActive &&
          activity.queuedInputs === 0 &&
          activity.running === 0 &&
          activity.ready === 0,
      };
    },
    drainPending,
    plannerCounts: (counts) => emit({ kind: 'planner', ...counts }),
    hasSubscribers: () => subscribers.size > 0,
    factory,
    pool,
    planner,
    stop() {
      stopLifetime();
      stopped = true;
      lifetime.abort();
      subscribers.clear();
    },
    subscribe(fn, cursor) {
      if (stopped) return () => {};
      subscribers.add(fn);
      const unsubscribeMessages = outbox.subscribe(
        (message) => fn({ kind: 'message', message }),
        cursor,
        (id, usage) => fn({ kind: 'usage', id, usage }),
      );
      return () => {
        unsubscribeMessages();
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
  const startedAt = Date.now();
  log().info('session close requested', { keyHash: keyHash(key), reason });
  log().info('stop requested', { id: 'all', reason });
  const close = (async () => {
    try {
      const h = await pending;
      if (h) {
        h.stop();
        log().info('close progress', {
          keyHash: keyHash(key),
          tasksRemaining: h.session
            .snapshot()
            .tasks.filter((t) => t.state === 'running' || t.state === 'queued')
            .length,
        });
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
      log().info('close finished', {
        keyHash: keyHash(key),
        durationMs: Date.now() - startedAt,
      });
    }
  })();
  closing.set(id, close);
  void close.finally(() => closing.delete(id)).catch(() => {});
  return close;
}

export async function touchDialogue(
  userId: string,
  key: string,
): Promise<void> {
  const pending = handles.get(slot(userId, key));
  await touchDialogueState(
    userId,
    key,
    pending
      ? async () => {
          const handle = await pending;
          await handle.drainPending();
        }
      : undefined,
  );
}
