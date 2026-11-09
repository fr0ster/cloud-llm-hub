import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentCallOptions,
  DialogueSignals,
  DialogueState,
  IConcurrencyPool,
  ISignalSubscriber,
  ISmartAgent,
  ISubAgent,
  IUsageRecorder,
  Message,
  PlannerMessage,
  PlannerMessageUsage,
  TaskRecord,
  TokenUsage,
  ToolCallRecord,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import { addTokenUsage } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  PlannerToolsClient,
  SemaphorePool,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import type { Request } from 'express';
import { getAgentConfig } from '../agent-config';
import {
  createAgentProfileSource,
  docsMcp,
  getCollectionRegistry,
  getSmartAgent,
  runWithRequestConnection,
} from '../agent-manager';
import {
  captureToolScope,
  getRagCallerIdentity,
  getRequestUserId,
  type RagCallerIdentity,
  runWithSessionId,
  runWithToolGateBypass,
  runWithToolScope,
} from '../request-session';
import {
  BriefPlanAuthor,
  planAuthorBriefRequest,
  planAuthorMode,
} from './brief-plan-author';
import {
  bindCheckerVerdict,
  checkerInputs,
  checkerVerdictInput,
  clearUnusableCheckerFailures,
  needsCheckerVerdictRetry,
  unusableCheckerPlanSteps,
} from './checker-verdict';
import { submitVerdictTool } from './checker-verdict-tool';
import { runWithContextCapture } from './context-capture';
import { withCoordinatorModel } from './coordinator-model';
import {
  currentDelegateBrief,
  withCoordinatorRun,
  withDelegateBrief,
} from './coordinator-tools-client';
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
  DIALOGUE_TOOL_CONTRACT_VERSION,
  deleteDialogueState,
  getDialogueStoreBackend,
  type HubDialogueState,
  migrateDialogueToolContract,
  touchDialogueState,
} from './dialogue-store';
import { clientTurnId, turnSource } from './dialogue-turn-source';
import { admitBackground, type PipelineSession } from './gatekeeper';
import { isLlmFailure, llmFailure, observeLlmSpend } from './llm-failure';
import { longSessionsIfReady } from './long-session';
import { parseModelAllowlist, resolveRequestModel } from './model-policy';
import { stripNoMessage } from './no-message';
import { renderNotice } from './notify-policy';
import {
  planAuthorContextNotes,
  plannerSessionOptions,
} from './planner-memory';
import { runWithRequestSystem } from './request-system-context';
import { captureReviewProfile } from './review-scope';
import { getRoleModels } from './role-model-settings';
import {
  clearRequestModel,
  currentRoleModel,
  roleOfProfile,
  setRequestModel,
  withRoleModels,
} from './role-models-scope';
import {
  type ConnectionLease,
  SessionConnectionFactory,
  SessionConnectionPool,
} from './session-connection-pool';
import {
  disposeSessionLlms,
  longSessionLlms,
  type SessionLlms,
} from './session-llms';
import { sessionSlot as slot } from './session-slot';
import { evaluateGated } from './step-reviewer';
import { cachedSystemIdentity } from './system-identity-cache';
import { createTaskResultStore } from './task-result-store';
import { type TaskView, taskView } from './task-view';
import { resolverFor, type TrustResolver } from './trust-resolver';
import { usageRuntime } from './usage/runtime';
import {
  type ActivityEvent,
  taskActivity,
  withWorkerActivity,
} from './worker-activity';

type Plan = Exclude<DialogueState['plan'], string | undefined>;
type PlanStep = Plan['steps'][number];
interface TurnCaller {
  userId: string;
  identity: RagCallerIdentity;
}

export interface PlannerCounts {
  toolsSelected?: number;
  toolsAvailable?: number;
  toolCalls?: number;
  maxToolCalls?: number;
}

export type DialogueEvent =
  | ActivityEvent
  | {
      kind: 'turn';
      source: 'webui' | 'api' | 'mcp' | 'background';
      text: string;
      clientTurnId?: string;
    }
  | ({ kind: 'planner' } & PlannerCounts)
  | ({ kind: 'wait' } & DialogueSignals['dialogue.wait'])
  | { kind: 'settled'; outcome: 'ok' | 'failed'; trigger: 'user' | 'event' }
  | { kind: 'message'; message: PlannerMessage }
  | { kind: 'tool-result'; record: ToolCallRecord; written?: () => void }
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
  failedUsage?(): PlannerMessageUsage;
  coordinatorResolver(): Promise<TrustResolver>;
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
    failureCause?: string;
  };
  runStep<T extends { ok: boolean }>(
    run: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T>;
  plannerCounts(counts: PlannerCounts): void;
  hasSubscribers(): boolean;
  drainPending(): Promise<void>;
  factory: SessionConnectionFactory;
  pool: SessionConnectionPool;
  /** Tool-result consumers replay pending results and acknowledge live writes. */
  subscribe(
    fn: (e: DialogueEvent) => void,
    cursor?: string,
    consumesToolResults?: boolean,
  ): () => void;
}
interface LiveHandle extends DialogueHandle {
  selectModel(model?: string): Promise<void>;
  stop(): void;
}
const handles = new Map<string, Promise<LiveHandle>>();
const log = () => cds.log('dialogue');

async function observeProfilePreparation<T>(
  signal: AbortSignal | undefined,
  prepare: () => Promise<T>,
): Promise<T> {
  const aborted = () => {
    const reason = signal?.reason;
    if (reason instanceof Error && /profile.*deadline/i.test(reason.message))
      log().warn('Agent profile/preparation deadline observed');
  };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    return await prepare();
  } finally {
    signal?.removeEventListener('abort', aborted);
  }
}

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
export function sharedExecutorPool(): IConcurrencyPool | undefined {
  const limit = getAgentConfig().agent.dialogue.executorPool;
  if (limit === undefined) return undefined;
  executorPool ??= new SemaphorePool(limit);
  return executorPool;
}

/** Open the shared board without sending a coordinator message. */
export async function headlessDialogueFor(
  req: Request,
  userId: string,
  key: string,
  destination: string,
): Promise<DialogueHandle> {
  const handle = await dialogueFor(userId, key, destination);
  await handle.factory.refresh(
    { headers: req.headers, user: cds.context?.user },
    destination,
  );
  return handle;
}

export function dialogueFor(
  userId: string,
  key: string,
  destination: string,
  model?: string,
): Promise<DialogueHandle> {
  const id = slot(userId, key);
  if (closing.has(id))
    return Promise.reject(new Error('dialogue session closing'));
  const existing = handles.get(id);
  const selected = resolveRequestModel(model, parseModelAllowlist()).model;
  if (existing)
    return lookupDialogue(userId, key, destination).then(async (handle) => {
      await (handle as LiveHandle).selectModel(selected);
      return handle as DialogueHandle;
    });
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
  const llms = longSessionLlms({ userId, key });
  const opening = llms
    .run(() => open(userId, key, destination, selected, llms))
    .catch((error: Error) => {
      disposeSessionLlms({ userId, key });
      throw error;
    })
    .then((handle) => {
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
  model: string | undefined,
  llms: SessionLlms,
): Promise<LiveHandle> {
  const coordinatorToolScope = captureToolScope();
  const turnCallers = new WeakMap<object, TurnCaller>();
  const config = getAgentConfig();
  const destinationHandle = await getSmartAgent(undefined, destination);
  if (
    !destinationHandle.workers ||
    !destinationHandle.recMcp ||
    !destinationHandle.profileRunner
  )
    throw new Error('Destination profile runner unavailable');
  const { recMcp, profileRunner } = destinationHandle;
  let runningWorkers = 0;
  const trustResolver = destinationHandle.trustResolver ?? resolverFor({});
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
  // Cause of the last failed settlement; the turn's own cause is collected
  // separately and becomes it only when that turn settles as failed.
  let failureCause: string | undefined;
  let turnFailureCause: string | undefined;
  // Every planner call of the turn, background corrections included.
  let turnPlannerSpend: TokenUsage | undefined;
  let lastFailureUsage: PlannerMessageUsage | undefined;
  const environment = () => {
    const connection = longSessionsIfReady()?.get(userId, key)?.connection;
    const identity = connection ? cachedSystemIdentity(connection) : undefined;
    return [
      'Environment',
      `Destination: ${destination}`,
      ...factory.environment(destination),
      ...(identity?.masterSystem
        ? [`SAP system id: ${identity.masterSystem}`]
        : []),
      ...(identity?.responsible ? [`SAP login: ${identity.responsible}`] : []),
      `Concurrency limit: ${config.agent.dialogue.executors} (shared executor pool: ${config.agent.dialogue.executorPool ?? 'disabled'})`,
    ].join('\n');
  };
  const decoratePlanner = (planner: ISmartAgent) =>
    plannerWithEnvironment(
      plannerWithAttachments(plannerWithParagraphs(planner), attachments),
      environment,
    );
  const pool = new SessionConnectionPool(
    factory,
    config.agent.dialogue.executors,
  );
  const subscribers = new Map<(e: DialogueEvent) => void, boolean>();
  const pendingToolResults: Extract<DialogueEvent, { kind: 'tool-result' }>[] =
    [];
  const lifetime = new AbortController();
  let stopped = false;
  let session: DialogueSession | undefined;
  const emit = (event: DialogueEvent) => {
    if (stopped) return;
    if (event.kind === 'tool-result') {
      pendingToolResults.push(event);
      if (pendingToolResults.length > 50) pendingToolResults.shift();
      event.written = () => {
        const index = pendingToolResults.indexOf(event);
        if (index >= 0) pendingToolResults.splice(index, 1);
      };
    }
    for (const fn of subscribers.keys()) {
      try {
        fn(event);
      } catch {
        /* Observers cannot break work. */
      }
    }
  };
  const queue = new Map<string, TaskView>();
  const queuedActivity = new Map<
    string,
    { currentAction: string; lastActivityAt: number }
  >();
  const withQueueActivity = (task: TaskView): TaskView => ({
    ...task,
    ...(task.state === 'queued' ? queuedActivity.get(task.id) : {}),
  });
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
    emit({ kind: 'task', task: taskView(withQueueActivity(task)) });
  };
  // Shared by TaskBoard.wrapRun and synchronous coordinator steps.
  async function runAdmitted<
    T extends {
      ok?: boolean;
      errorClass?: string;
      stopped?: boolean;
      status?: string;
    },
  >(
    run: (lease: ConnectionLease, pipeline: PipelineSession) => Promise<T>,
  ): Promise<T> {
    let lease: ConnectionLease | undefined;
    let pipeline: PipelineSession | undefined;
    let healthy = false;
    try {
      lease = await pool.acquire(lifetime.signal);
      const admission = await admitBackground(userId, key, lifetime.signal);
      if (!('admitted' in admission))
        throw new Error(
          'Background task admission refused: session closed or unavailable',
        );
      pipeline = admission.admitted;
      const acquiredLease = lease;
      const admitted = pipeline;
      const result = await withRoleModels(getRoleModels(userId, key), () =>
        admitted.run(() => run(acquiredLease, admitted)),
      );
      healthy =
        !lifetime.signal.aborted &&
        result.ok !== false &&
        result.errorClass !== 'epicfail' &&
        !result.stopped &&
        result.status !== 'awaiting-external';
      return result;
    } finally {
      try {
        await pipeline?.drain();
      } finally {
        try {
          pipeline?.release();
        } finally {
          await lease?.release(healthy);
        }
      }
    }
  }
  // Late evidence is session-local. Keep at most 128 tool records, evicting
  // oldest first. Capability is accumulated before eviction (it already covers
  // attempted writes), so an evicted write still makes claims warn.
  const pendingWorkerRecords: ToolCallRecord[] = [];
  let pendingWorkerWriteCapability = false;
  const retainWorkerEvidence = (traceId: string) => {
    if (stopped) return;
    pendingWorkerWriteCapability ||= recMcp.hadWriteCapability(traceId);
    pendingWorkerRecords.push(...recMcp.getToolRecords(traceId));
    if (pendingWorkerRecords.length > 128)
      pendingWorkerRecords.splice(0, pendingWorkerRecords.length - 128);
  };
  type PlannerTurn = {
    traceId?: string;
    workerTraces: Set<string>;
    workerRecords: ToolCallRecord[];
    active: boolean;
    reviewing: boolean;
  };
  const plannerTrace = new AsyncLocalStorage<PlannerTurn>();
  // Carry task admission into the worker callback and rebuild its request scope.
  // Dialogue workers receive only their brief; no request history is injected.
  const scope = new AsyncLocalStorage<{
    lease: ConnectionLease;
    pipeline: PipelineSession;
    traceId: string;
    writeToolOffered: boolean;
    taskId: string;
    userId: string;
    identity: RagCallerIdentity;
  }>();
  const workers = new Map<string, ISubAgent>();
  const wrapWorker = (
    worker: ISubAgent,
    profile?: WorkerProfile,
    model?: string,
    requestedModel?: string,
  ): ISubAgent => {
    const name = worker.name;
    return {
      name: worker.name,
      description: worker.description,
      capabilities: worker.capabilities,
      async run(input) {
        const ctx = scope.getStore();
        if (!ctx) throw new Error('Background task context unavailable');
        // Stage 2 gap: TaskRecord.model exists, but TaskBoard passes a copy to
        // wrapRun and offers no public setter for the resolved worker model.
        if (
          model !== undefined &&
          requestedModel !== undefined &&
          model !== requestedModel
        )
          log().info('Session role model overrides coordinator choice', {
            taskId: ctx.taskId,
            requestedModel,
            model,
          });
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
                  let { result, profile: resolvedProfile } =
                    await captureReviewProfile(() =>
                      runWithToolGateBypass(() =>
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
                      ),
                    );
                  if (
                    result.errorClass === 'epicfail' ||
                    result.stopped ||
                    result.status === 'awaiting-external'
                  )
                    return result;
                  const isChecker =
                    (profile ?? resolvedProfile)?.result === 'verdict' ||
                    name === 'checker';
                  if (
                    isChecker &&
                    needsCheckerVerdictRetry(
                      result.output,
                      recMcp.getToolRecords(ctx.traceId),
                    )
                  ) {
                    const retry = await captureReviewProfile(() =>
                      runWithToolGateBypass(() =>
                        runWithDialogueRagTools(() =>
                          runWithContextCapture(
                            {
                              component: 'checker',
                              taskId: ctx.taskId,
                              sessionKey: key,
                            },
                            () =>
                              worker.run({
                                ...input,
                                task:
                                  input.task +
                                  `\nYour previous answer had no valid verdict. Call ${submitVerdictTool.name} with {verdict:"pass"} or {verdict:"fail",claims:[{quote,evidence,reason}]}; fail requires at least one claim.`,
                                trace: { traceId: ctx.traceId },
                                signal: ctx.pipeline.signal,
                              }),
                          ),
                        ),
                      ),
                    );
                    result = retry.result;
                    if (
                      result.errorClass === 'epicfail' ||
                      result.stopped ||
                      result.status === 'awaiting-external'
                    )
                      return result;
                  }
                  const checked = isChecker
                    ? bindCheckerVerdict(
                        checkerVerdictInput(
                          result.output,
                          recMcp.getToolRecords(ctx.traceId),
                        ),
                        checkerInputs(
                          session?.snapshot(),
                          ctx.taskId,
                          input.task,
                          recMcp.getToolRecords(ctx.traceId),
                          currentDelegateBrief(),
                        ),
                      )
                    : result.output;
                  if (isChecker) return { ...result, output: checked };
                  const verdict = await evaluateGated({
                    content: checked,
                    records: recMcp.getToolRecords(ctx.traceId),
                    writeToolOffered:
                      ctx.writeToolOffered ||
                      recMcp.hadWriteCapability(ctx.traceId),
                  });
                  return {
                    ...result,
                    output: verdict.ok
                      ? checked
                      : checked + renderNotice(verdict),
                  };
                },
                ctx.lease.dumpScope,
                factory.exposition,
              ),
            undefined,
            ctx.userId,
            ctx.identity,
          ),
        );
      },
    };
  };
  for (const [name, worker] of destinationHandle.workers)
    workers.set(name, wrapWorker(worker));
  const store = createDialogueStateStore(userId, key);
  const backend = getDialogueStoreBackend();
  let savedState: HubDialogueState | undefined;
  try {
    savedState = await backend.load(userId, key);
    if (savedState) savedState = migrateDialogueToolContract(savedState);
  } catch (error) {
    await pool.closeAll();
    throw error;
  }
  const restoredModel = resolveRequestModel(
    savedState?.coordinatorModel,
    parseModelAllowlist(),
  );
  if (restoredModel.ignored)
    log().warn(
      'Saved coordinator model no longer allowed; using deploy default',
      {
        model: restoredModel.ignored,
      },
    );
  let selectedModel = model ?? restoredModel.model;
  if (selectedModel !== undefined) setRequestModel(userId, key, selectedModel);
  let saving = Promise.resolve();
  const persist = (
    outboxMessages: OutboxEntry[],
    ackMode: boolean,
  ): Promise<void> => {
    const state = session?.snapshot() ?? savedState;
    if (!state) return Promise.resolve();
    const row = {
      ...state,
      coordinatorModel: selectedModel,
      toolContractVersion: DIALOGUE_TOOL_CONTRACT_VERSION,
      ...(savedState?.agentsCollectionId !== undefined
        ? { agentsCollectionId: savedState.agentsCollectionId }
        : {}),
      pending: [],
      outbox: outboxMessages,
      ackMode,
    };
    saving = saving.catch(() => {}).then(() => backend.save(userId, key, row));
    return saving;
  };
  const outbox: DialogueOutbox = new DialogueOutbox(
    savedState?.outbox ?? [],
    (messages, ackMode) => persist(messages, ackMode),
    savedState?.ackMode,
  );
  const drainPending = async () => {
    await outbox.add(withFailedWorkerUsage(session?.takePending() ?? []));
  };
  const signals = dialogueSignals();
  const dialogueIdentity = (): RagCallerIdentity => {
    const { admin, channel } = getRagCallerIdentity();
    return {
      admin,
      channel,
      onToolResult: (record) => emit({ kind: 'tool-result', record }),
    };
  };
  const taskCallers = new Map<string, TurnCaller>();
  const pendingEventCallers: TurnCaller[] = [];
  const pendingEventTasks: string[] = [];
  let eventCaller: TurnCaller | undefined;
  const unsubscribeTaskCaller = signals.on(
    'dialogue.task.state',
    ({ payload: { task, previous } }) => {
      if (task.state === 'queued' || task.state === 'running')
        queue.set(task.id, task);
      else queue.delete(task.id);
      let ahead = 0;
      for (const entry of queue.values()) {
        if (entry.state !== 'queued') continue;
        const currentAction = `queued (${ahead++} ahead)`;
        if (queuedActivity.get(entry.id)?.currentAction === currentAction)
          continue;
        const lastActivityAt = Date.now();
        queuedActivity.set(entry.id, { currentAction, lastActivityAt });
        emitTask(entry);
        emit({
          kind: 'activity',
          taskId: entry.id,
          worker: entry.worker,
          action: currentAction,
          at: lastActivityAt,
        });
      }
      if (task.state !== 'queued') queuedActivity.delete(task.id);
      if (task.state === 'queued' && previous === undefined) {
        taskCallers.set(task.id, {
          userId: getRequestUserId() ?? userId,
          identity: dialogueIdentity(),
        });
      }
      if (
        task.state === 'done' ||
        task.state === 'failed' ||
        task.state === 'stopped'
      ) {
        pendingEventTasks.push(task.id);
        const caller = taskCallers.get(task.id);
        if (caller) pendingEventCallers.push(caller);
        taskCallers.delete(task.id);
      }
    },
    { source: slot(userId, key) },
  );
  const unsubscribeTurnCaller = signals.on(
    'dialogue.turn.started',
    ({ payload: { trigger } }) => {
      eventCaller = undefined;
      if (trigger !== 'event') return;
      const callers = pendingEventCallers.splice(0);
      const origin = callers[0];
      if (origin)
        eventCaller = {
          ...origin,
          // A batched event turn must not gain privileges from another task.
          identity: {
            ...origin.identity,
            admin: callers.every(
              (caller) =>
                caller.identity.admin && caller.userId === origin.userId,
            ),
          },
        };
    },
    { source: slot(userId, key) },
  );
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
      // running includes queued tasks; queuedInputs also includes deferred outcomes.
      if (payload.running > 0 || payload.turnActive) {
        if (!releaseHold && longSession)
          releaseHold = registry?.hold(longSession);
      } else releaseLifetime();
    },
    { source: slot(userId, key) },
  );
  const unsubscribeClosed = signals.on(
    'dialogue.session.closed',
    () => {
      disposeSessionLlms({ userId, key });
      stopLifetime();
    },
    { source: slot(userId, key) },
  );
  // Snapshot before settlement clears the live reply; a later successful turn
  // must not erase the spend belonging to the retained failure sequence.
  // TaskBoard passes wrapRun a copy and drops usage on rejection. Success
  // records remain authoritative; retain only rejected runs as a fallback.
  const failedWorkerSpend = new Map<string, TokenUsage>();
  function failedTurnUsage(): PlannerMessageUsage {
    const accountedTasks = new Set(
      outbox
        .history()
        .flatMap(
          (message) => message.usage?.tasks?.map((task) => task.id) ?? [],
        ),
    );
    return {
      planner:
        turnPlannerSpend &&
        turnPlannerSpend.totalTokens > (turnReplyUsage?.totalTokens ?? 0)
          ? turnPlannerSpend
          : turnReplyUsage,
      tasks: (session?.snapshot().tasks ?? []).flatMap((task) => {
        const usage = task.usage ?? failedWorkerSpend.get(task.id);
        return usage && !accountedTasks.has(task.id)
          ? [
              {
                id: task.id,
                worker: task.worker,
                usage,
                ...(task.startedAt !== undefined &&
                task.finishedAt !== undefined
                  ? {
                      durationMs: Math.max(0, task.finishedAt - task.startedAt),
                    }
                  : {}),
              },
            ]
          : [];
      }),
    };
  }
  function withFailedWorkerUsage(messages: PlannerMessage[]): PlannerMessage[] {
    const available = (failedTurnUsage().tasks ?? []).filter((task) =>
      failedWorkerSpend.has(task.id),
    );
    const unique = new Map(messages.map((message) => [message.id, message]));
    return [...unique.values()].map((message) => {
      // A later save can republish the library's original message without our
      // fallback usage. Preserve the spend already attached to that message.
      const retained =
        outbox.history().find((entry) => entry.id === message.id)?.usage
          ?.tasks ?? [];
      const extras = [
        ...retained.filter((task) => failedWorkerSpend.has(task.id)),
        ...available.splice(0),
      ].filter(
        (task) =>
          !message.usage?.tasks?.some((existing) => existing.id === task.id),
      );
      return extras.length
        ? {
            ...message,
            usage: {
              ...message.usage,
              tasks: [...(message.usage?.tasks ?? []), ...extras],
            },
          }
        : message;
    });
  }
  let settledSeq = 0;
  let lastFailedSeq = 0;
  const unsubscribeStarted = signals.on(
    'dialogue.turn.started',
    ({ payload: { trigger } }) => {
      if (trigger === 'event')
        emit({
          kind: 'turn',
          source: 'background',
          text: `after task ${pendingEventTasks.splice(0).join(', ') || 'update'}`.slice(
            0,
            300,
          ),
        });
    },
    { source: slot(userId, key) },
  );
  const unsubscribeSettled = signals.on(
    'dialogue.turn.settled',
    async ({ payload: { outcome, trigger } }) => {
      settledSeq++;
      if (outcome === 'failed') {
        lastFailedSeq = settledSeq;
        lastFailureUsage = failedTurnUsage();
        failureCause = turnFailureCause;
      }
      turnFailureCause = undefined;
      turnPlannerSpend = undefined;
      turnReply = undefined;
      turnReplyUsage = undefined;
      await outbox.flushed();
      emit({ kind: 'settled', outcome, trigger });
    },
    { source: slot(userId, key) },
  );
  const unsubscribeWait = signals.on(
    'dialogue.wait',
    ({ payload: { tasks } }) => emit({ kind: 'wait', tasks }),
    { source: slot(userId, key) },
  );
  const stopLifetime = () => {
    pendingWorkerRecords.length = 0;
    pendingWorkerWriteCapability = false;
    recMcp.closeSession(userId, key);
    pendingToolResults.length = 0;
    unsubscribeTaskCaller();
    unsubscribeTurnCaller();
    unsubscribeWait();
    unsubscribeActivity();
    unsubscribeClosed();
    unsubscribeStarted();
    unsubscribeSettled();
    releaseLifetime();
  };
  const processPlanner = async (
    planner: ISmartAgent,
    input: Message[],
    options: AgentCallOptions,
  ) =>
    withRoleModels(getRoleModels(userId, key), () =>
      runWithToolScope(coordinatorToolScope, async () => {
        // Reset the library's legacy malformed-verdict failure before decisions.
        const current = session?.snapshot();
        const resetSteps = current && unusableCheckerPlanSteps(current);
        if (resetSteps) {
          const reset = await new PlannerToolsClient().callTool('plan_update', {
            steps: resetSteps,
          });
          if (!reset.ok || reset.value.isError)
            throw new Error('Unable to reset unusable checker verdict');
          input = input.map((message, index) =>
            index === input.length - 1
              ? {
                  ...message,
                  content: `${message.content}\nChecker verdict correction: unusable verdicts are undecided, not failures. Their check steps are pending. Decide whether to rerun, revise or skip with a reason.`,
                }
              : message,
          );
        }
        const caller = (options.trace && turnCallers.get(options.trace)) ??
          eventCaller ?? {
            userId,
            // Restored tasks and timer events have no authenticated originating turn.
            identity: { admin: false, channel: 'openai' as const },
          };
        const reply = options.trace && replies.get(options.trace);
        turnReply = undefined;
        turnReplyUsage = options.trace
          ? replyUsage.get(options.trace)
          : undefined;
        let spent: TokenUsage | undefined;
        let contentStreamed = false;
        const turn: PlannerTurn = {
          traceId: options.trace?.traceId,
          workerTraces: new Set<string>(),
          workerRecords: [],
          active: true,
          reviewing: false,
        };
        // Set when content is reviewed; empty/failed turns settle at the generation
        // current when they end, so their own capability does not leak forward.
        let reviewedGeneration: number | undefined;
        try {
          let result = await observeLlmSpend(
            () =>
              runWithContextCapture(
                { component: 'planner', sessionKey: key },
                () =>
                  runWithSessionId(
                    key,
                    () =>
                      recMcp.withSession(userId, key, () =>
                        plannerTrace.run(turn, () =>
                          decoratePlanner(planner).process(input, {
                            ...options,
                            onPartial(chunk) {
                              if (chunk.kind === 'content' && chunk.delta)
                                contentStreamed = true;
                              options.onPartial?.(chunk);
                            },
                          }),
                        ),
                      ),
                    undefined,
                    caller.userId,
                    caller.identity,
                  ),
              ),
            (usage) => {
              spent = addTokenUsage(spent, usage);
              turnPlannerSpend = addTokenUsage(turnPlannerSpend, usage);
            },
          );
          if (result.ok && result.value.content) {
            turn.reviewing = true;
            reviewedGeneration = recMcp.writeGeneration(userId, key);
            const writeToolOffered =
              pendingWorkerWriteCapability ||
              recMcp.hadWriteCapability(turn.traceId) ||
              recMcp.hadSessionWriteCapability(userId, key) ||
              [...turn.workerTraces].some((id) =>
                recMcp.hadWriteCapability(id),
              );
            const records = [
              ...pendingWorkerRecords.splice(0),
              ...recMcp.getToolRecords(turn.traceId),
              ...turn.workerRecords,
              ...[...turn.workerTraces].flatMap((id) =>
                recMcp.getToolRecords(id),
              ),
            ];
            pendingWorkerWriteCapability = false;
            if (writeToolOffered || records.length) {
              const verdict = await evaluateGated({
                content: result.value.content,
                records,
                writeToolOffered,
              });
              if (!verdict.ok) {
                const notice = `\n\n${renderNotice(verdict)}`;
                options.onPartial?.({
                  kind: 'content',
                  delta: (contentStreamed ? '' : result.value.content) + notice,
                });
                result = {
                  ...result,
                  value: {
                    ...result.value,
                    content: result.value.content + notice,
                  },
                };
              }
            }
          }
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
          if (!result.ok) {
            turnReplyUsage = addTokenUsage(turnReplyUsage, spent);
            // Only a model failure is replaced by its content-free cause.
            turnFailureCause = isLlmFailure(result.error)
              ? llmFailure(result.error)
              : undefined;
          }
          return result;
        } catch (error) {
          turnReplyUsage = addTokenUsage(turnReplyUsage, spent);
          if (!isLlmFailure(error)) {
            turnFailureCause = undefined;
            throw error;
          }
          turnFailureCause = llmFailure(error);
          throw new Error(turnFailureCause);
        } finally {
          // Preserve evidence arriving during review, or during an empty/failed turn.
          if (runningWorkers === 0) {
            recMcp.markReviewed(
              userId,
              key,
              reviewedGeneration ?? recMcp.writeGeneration(userId, key),
            );
            // An empty or failed turn never reviews, so evidence buffered before it
            // is settled here. Evidence arriving during a review stays pending.
            if (reviewedGeneration === undefined) {
              pendingWorkerRecords.length = 0;
              pendingWorkerWriteCapability = false;
            }
          }
          turn.active = false;
          turn.workerTraces.clear();
          turn.workerRecords.length = 0;
          const traceId = options.trace?.traceId;
          if (
            recMcp.hadWriteCapability(traceId) ||
            recMcp.getToolRecords(traceId).length
          )
            recMcp.dropRequest(traceId);
          for (const task of session?.snapshot().tasks ?? []) emitTask(task);
        }
      }),
    );
  const source = createAgentProfileSource(
    userId,
    () =>
      longSessionsIfReady()?.get(userId, key)?.agentsCollectionId ??
      savedState?.agentsCollectionId ??
      config.profiles?.collectionId ??
      'agents',
  );
  const coordinatorResolver = async (): Promise<TrustResolver> => {
    const prompts = await source.getPrompts();
    return trustResolver.forProfile({
      trust: prompts.ok ? prompts.value.trust?.coordinator : undefined,
    });
  };
  recMcp.openSession(userId, key);
  try {
    const retrieval = await plannerSessionOptions(
      userId,
      key,
      coordinatorResolver,
    );
    let coordinatorToolResolver = await coordinatorResolver();
    session = await DialogueSession.open({
      resultStore: createTaskResultStore(() => getCollectionRegistry(), {
        userId,
        sessionKey: key,
      }),
      toolTrust: (name) =>
        destinationHandle.toolTrustFor?.(coordinatorToolResolver)(name),
      profileSource: source,
      planAuthor: new BriefPlanAuthor({
        source,
        runner: profileRunner,
        notes: async (options) => {
          const workers = await source.list(options);
          if (!workers.ok) throw new Error(workers.error.message);
          const request = session
            ?.snapshot()
            .requests?.find((record) => record.closedAt === undefined);
          const authorPrompts = await source.getPrompts(options);
          const role =
            planAuthorMode() === 'create' ? 'plannerCreate' : 'plannerRevise';
          const authorResolver = trustResolver.forProfile({
            trust: authorPrompts.ok
              ? authorPrompts.value.trust?.[role]
              : undefined,
          });
          const authorRetrieval = await plannerSessionOptions(
            userId,
            key,
            authorResolver,
          );
          const context = await planAuthorContextNotes(
            authorRetrieval,
            key,
            request ?? planAuthorBriefRequest(),
            options,
          );
          return [
            ...context,
            environment(),
            `[worker profiles] ${JSON.stringify(docsMcp().describeWorkers(workers.value))}`,
          ];
        },
      }),
      // Omission leaves preparation bounded only by caller cancellation.
      ...(config.profiles?.timeoutMs === undefined
        ? {}
        : { profileTimeoutMs: config.profiles.timeoutMs }),
      profileRunner: {
        validateModel: (model) => profileRunner.validateModel(model),
        createWorker: async (input, options) =>
          withRoleModels(getRoleModels(userId, key), async () => {
            const model =
              currentRoleModel(roleOfProfile(input.profile)) ?? input.model;
            const result = await observeProfilePreparation(
              options?.signal,
              () => profileRunner.createWorker({ ...input, model }, options),
            );
            return result.ok
              ? {
                  ok: true,
                  value: wrapWorker(
                    result.value,
                    input.profile,
                    model ?? input.profile.model ?? config.llm.model,
                    input.model,
                  ),
                }
              : result;
          }),
        preparePlanner: async (input, options) =>
          withRoleModels(getRoleModels(userId, key), () =>
            runWithToolScope(coordinatorToolScope, async () => {
              coordinatorToolResolver = trustResolver.forProfile(input);
              const result = await withCoordinatorRun(
                async (run) =>
                  (await dialogueFor(userId, key, destination)).runStep(run),
                () =>
                  withCoordinatorModel(
                    currentRoleModel('coordinator') ?? selectedModel,
                    () =>
                      observeProfilePreparation(options?.signal, () =>
                        profileRunner.preparePlanner(input, options),
                      ),
                  ),
              );
              if (!result.ok) {
                if (/timeout|timed out|deadline/i.test(result.error.message))
                  log().warn('Agent profile/preparation deadline observed');
                return result;
              }
              const prepared = result.value;
              return {
                ok: true as const,
                value: new Proxy(prepared, {
                  get(target, property, receiver) {
                    if (property === 'process')
                      return (input: Message[], options: AgentCallOptions) =>
                        processPlanner(prepared, input, options);
                    return Reflect.get(target, property, receiver);
                  },
                }),
              };
            }),
          ),
      },
      logger: {
        warn(message) {
          log().warn(
            /profile|prepar|timeout|timed out|deadline/i.test(message)
              ? 'Agent profile/preparation or background turn failure observed'
              : 'Dialogue library warning',
          );
        },
      },
      timeZone: config.timeZone,
      // The coordinator still needs this context for conversational turns that
      // do not invoke plan_create or plan_revise.
      ...retrieval,
      ...(usage ? { usage } : {}),
      id: key,
      // Keep the library's memory/usage identity logical; only the hub bus
      // needs the user-scoped identity for routing and retirement.
      signals: {
        ...({
          last(name, source, entityKey) {
            const signal = signals.last(name, slot(userId, key), entityKey);
            return signal ? { ...signal, source } : undefined;
          },
        } satisfies Pick<ISignalSubscriber<DialogueSignals>, 'last'>),
        emit(name, payload, _source, entityKey) {
          signals.emit(name, payload, slot(userId, key), entityKey);
        },
        retire() {
          signals.retire(slot(userId, key));
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
          clearUnusableCheckerFailures(state);
          savedState = {
            ...state,
            coordinatorModel: selectedModel,
            toolContractVersion: DIALOGUE_TOOL_CONTRACT_VERSION,
            ...(savedState?.agentsCollectionId !== undefined
              ? { agentsCollectionId: savedState.agentsCollectionId }
              : {}),
          };
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
            withFailedWorkerUsage(state.pending),
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
          // TaskBoard starts execution in the scheduling planner scope; its
          // async context survives pool waits and later user turns.
          const caller = {
            userId: getRequestUserId() ?? userId,
            identity: dialogueIdentity(),
          };
          const turn = plannerTrace.getStore();
          const writeToolOffered = recMcp.hadWriteCapability(turn?.traceId);
          runningWorkers++;
          const startedAt = Date.now();
          // No free text from goals or errors reaches the logs: a goal may carry
          // whatever the user typed, credentials included. Ids correlate with
          // the task events the WebUI shows.
          log().info('task started', {
            id: task.id,
            worker: task.worker,
            goalChars: task.goal.length,
          });
          let state: TaskRecord['state'] = 'failed';
          let spent: TokenUsage | undefined;
          const traceId = randomUUID();
          if (turn?.active) turn.workerTraces.add(traceId);
          emitTask(task);
          try {
            const result = await recMcp.withSession(userId, key, () =>
              runAdmitted(async (acquiredLease, pipeline) =>
                scope.run(
                  {
                    lease: acquiredLease,
                    pipeline,
                    traceId,
                    writeToolOffered,
                    taskId: task.id,
                    ...caller,
                  },
                  () =>
                    runWithContextCapture(
                      { component: 'other', taskId: task.id, sessionKey: key },
                      // Workers report spend on TaskRecord, outside the planner bucket.
                      () =>
                        observeLlmSpend(
                          () =>
                            withWorkerActivity(
                              taskActivity(
                                task.id,
                                task.worker,
                                (action) => {
                                  session?.noteActivity(task.id, action);
                                },
                                emit,
                              ),
                              run,
                            ),
                          (usage) => {
                            spent = addTokenUsage(spent, usage);
                          },
                        ),
                    ),
                ),
              ),
            );
            const healthy =
              !lifetime.signal.aborted &&
              result.errorClass !== 'epicfail' &&
              !result.stopped &&
              result.status !== 'awaiting-external';
            state = healthy ? 'done' : result.stopped ? 'stopped' : 'failed';
            return result;
          } catch (error) {
            if (spent) failedWorkerSpend.set(task.id, spent);
            throw error;
          } finally {
            runningWorkers--;
            if (turn?.active && !turn.reviewing) {
              turn.workerRecords.push(...recMcp.getToolRecords(traceId));
              turn.workerTraces.delete(traceId);
            } else {
              retainWorkerEvidence(traceId);
            }
            try {
              recMcp.dropRequest(traceId);
            } catch (error) {
              cds.log('dialogue-sessions').warn('dropRequest failed', {
                errorType: error instanceof Error ? error.name : typeof error,
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
        },
      },
      onMessage(message) {
        if (stopped) return;
        void outbox
          .add(
            withFailedWorkerUsage([message, ...(session?.takePending() ?? [])]),
          )
          .catch(() => {
            /* Retain in memory and retry persistence on next save. */
          });
      },
    });
    await drainPending();
  } catch (error) {
    recMcp.closeSession(userId, key);
    stopLifetime();
    await session?.close();
    await pool.closeAll();
    throw error;
  }
  const snapshot = session.snapshot.bind(session);
  session.snapshot = () => {
    const state = snapshot();
    clearUnusableCheckerFailures(state);
    return {
      ...state,
      tasks: state.tasks.map((task) => ({
        ...task,
        ...withQueueActivity(task),
      })),
    };
  };
  lastPlan = dialoguePlan(session.snapshot());
  const callTool = session.callTool.bind(session);
  session.callTool = (...args) =>
    llms.run(async () => {
      const steps = unusableCheckerPlanSteps(session.snapshot());
      if (steps) {
        const reset = await callTool('plan_update', { steps });
        if (!reset.ok || reset.value.isError) return reset;
      }
      return withDelegateBrief(args[0], args[1], () => callTool(...args));
    });
  const send = session.send.bind(session);
  session.send = (text, options = {}) => {
    emit({
      kind: 'turn',
      source: turnSource.getStore() ?? 'mcp',
      ...(clientTurnId.getStore()
        ? { clientTurnId: clientTurnId.getStore() }
        : {}),
      text: text.slice(0, 300),
    });
    // Each queued input owns its snapshot even if callers reuse a trace object.
    const trace = options.trace
      ? { ...options.trace }
      : { traceId: randomUUID() };
    const attachment = options.trace && attachments.get(options.trace);
    if (attachment !== undefined) attachments.set(trace, attachment);
    const reply = options.trace && replies.get(options.trace);
    if (reply) replies.set(trace, reply);
    turnCallers.set(trace, {
      userId: getRequestUserId() ?? userId,
      identity: dialogueIdentity(),
    });
    return llms.run(() =>
      send(text, { ...options, trace }).finally(drainPending),
    );
  };
  return {
    async selectModel(model) {
      if (model === undefined || model === selectedModel) return;
      selectedModel = model;
      setRequestModel(userId, key, model);
      await outbox.upsert([]);
    },
    destination,
    session,
    ...(usage ? { usage } : {}),
    attachments,
    coordinatorResolver,
    replies,
    outbox,
    failedUsage: () => lastFailureUsage ?? failedTurnUsage(),
    state() {
      const activity = signals.last(
        'dialogue.activity',
        slot(userId, key),
      )?.payload;
      const plan = signals.last(
        'dialogue.plan.changed',
        slot(userId, key),
      )?.payload;
      return {
        settledSeq,
        lastFailedSeq,
        failureCause,
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
    async runStep(run) {
      const release = await sharedExecutorPool()?.acquire(lifetime.signal);
      try {
        return await runAdmitted((lease, pipeline) =>
          runWithRequestSystem(lease.system, () =>
            runWithRequestConnection(
              lease.connection,
              () => llms.run(() => run(pipeline.signal)),
              lease.dumpScope,
              factory.exposition,
            ),
          ),
        );
      } finally {
        release?.();
      }
    },
    plannerCounts: (counts) => emit({ kind: 'planner', ...counts }),
    hasSubscribers: () => subscribers.size > 0,
    factory,
    pool,
    stop() {
      stopLifetime();
      disposeSessionLlms({ userId, key });
      stopped = true;
      lifetime.abort();
      subscribers.clear();
    },
    subscribe(fn, cursor, consumesToolResults = false) {
      if (stopped) return () => {};
      subscribers.set(fn, consumesToolResults);
      for (const event of consumesToolResults ? [...pendingToolResults] : []) {
        try {
          fn(event);
        } catch {
          /* Observers cannot break work. */
        }
      }
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
          await h.pool.closeAll();
        }
      }
    } finally {
      handles.delete(id);
      clearRequestModel(userId, key);
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
