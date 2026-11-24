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
  PlannerRequestRecord,
  TaskRecord,
  TokenUsage,
  ToolCallRecord,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import {
  addTokenUsage,
  type CallOptions,
  LlmError,
  RagAccessDeniedError,
  type RagCaller,
  retryAfterSecondsOf,
  SmartAgentError,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultPlannerContextBuilder,
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
  clearUnusableCheckerFailures,
  unusableCheckerPlanSteps,
  withCheckerBrief,
} from './checker-verdict';
import { clientHistoryTurnId } from './client-history';
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
import {
  clientTurnId,
  clientTurnMessages,
  turnSource,
} from './dialogue-turn-source';
import { clearExecutionLimits, getExecutionLimits } from './execution-limits';
import { admitBackground, type PipelineSession } from './gatekeeper';
import {
  attributeTokenUsage,
  captureTokenUsage,
  isLlmFailure,
  llmFailure,
  runWithoutLlmSpend,
  safeContextExceeded,
} from './llm-failure';
import { longSessionsIfReady } from './long-session';
import { withModelCatalog } from './model-catalog';
import { parseModelAllowlist, resolveRequestModel } from './model-policy';
import { stripNoMessage } from './no-message';
import {
  planAuthorContextNotes,
  plannerSessionOptions,
} from './planner-memory';
import { bindCaller, callOptionsFor } from './rag-caller';
import { runWithRequestSystem } from './request-system-context';
import { clearRoleModels, getRoleModels } from './role-model-settings';
import {
  chatResponseModel,
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
import { recordTurn, waitForSessionTurns } from './session-turns';
import { cachedSystemIdentity } from './system-identity-cache';
import { createTaskResultStore } from './task-result-store';
import { type TaskView, taskView } from './task-view';
import {
  type ChatRunFailureFacts,
  chatRunFailureFacts,
} from './throttle-surfacing';
import { toolCallDiagnosticsLogger } from './tool-call-diagnostics';
import { type JournalEntry, withWriteActions } from './tool-journal';
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
  ragCaller?: RagCaller;
  userId: string;
  identity: RagCallerIdentity;
}

interface HistoryTurn {
  id: string;
  caller: RagCaller;
  text: string;
  answer: string;
  tasks: Set<string>;
  taskAnswers: Map<string, string>;
  consumerMessages: Message[];
  clientLoop: Message[];
  transcript: NonNullable<PlannerRequestRecord['transcript']>;
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

type DialogueFailure = ChatRunFailureFacts & { cause?: string };

function sanitizePlannerFailure<T>(error: T) {
  const overflow = safeContextExceeded(error);
  const { code, ...facts } = chatRunFailureFacts(overflow ?? error);
  const details =
    typeof error === 'object' && error !== null ? error : undefined;
  facts.retryAfterSeconds ??= retryAfterSecondsOf(details);
  const errorCode = code ?? terminalRunError(error)?.code;
  const cause =
    overflow?.message ?? (isLlmFailure(error) ? llmFailure(error) : undefined);
  const failure: DialogueFailure | undefined =
    cause || errorCode || facts.status !== undefined
      ? { ...facts, code: errorCode, cause }
      : undefined;
  // The library can persist the error's message in the request record.
  const message = 'Planner turn failed.';
  const safeCode = errorCode ?? 'PLANNER_ERROR';
  const safeError =
    overflow ??
    (cause
      ? new LlmError(message, safeCode)
      : new SmartAgentError(message, safeCode));
  return { error: Object.assign(safeError, facts), failure };
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
  readonly caller: RagCaller;
  destination: string;
  session: DialogueSession;
  usage?: IUsageRecorder;
  failedUsage?(): PlannerMessageUsage;
  coordinatorResolver(): Promise<TrustResolver>;
  toolJournal(): ReadonlyMap<string, JournalEntry>;
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
    failure?: DialogueFailure;
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
  caller?: RagCaller,
): Promise<DialogueHandle> {
  const handle = await dialogueFor(userId, key, destination, undefined, caller);
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
  caller?: RagCaller,
): Promise<DialogueHandle> {
  return withModelCatalog(() =>
    dialogueForWithCatalog(userId, key, destination, model, caller),
  );
}

function dialogueForWithCatalog(
  userId: string,
  key: string,
  destination: string,
  model?: string,
  caller?: RagCaller,
): Promise<DialogueHandle> {
  if (caller && (caller.sessionId !== key || caller.userId !== userId))
    return Promise.reject(
      new RagAccessDeniedError('Caller does not match dialogue session'),
    );
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
    .run(() => open(userId, key, destination, selected, llms, caller))
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
  caller?: RagCaller,
): Promise<LiveHandle> {
  const boundCaller = caller
    ? { ok: true as const, value: caller }
    : await bindCaller(
        key,
        userId,
        cds.context?.user?.is('MCP_Admin') === true,
      );
  if (!boundCaller.ok) throw boundCaller.error;
  const coordinatorToolScope = captureToolScope();
  const turnCallers = new WeakMap<object, TurnCaller>();
  const trustedCaller = new AsyncLocalStorage<RagCaller>();
  const config = getAgentConfig();
  const destinationHandle = await getSmartAgent(undefined, destination);
  if (
    !destinationHandle.workers ||
    !destinationHandle.recMcp ||
    !destinationHandle.profileRunner
  )
    throw new Error('Destination profile runner unavailable');
  const { recMcp, profileRunner } = destinationHandle;
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
  // Facts of the last failed settlement; the turn's own failure is collected
  // separately and becomes it only when that turn settles as failed.
  let failure: DialogueFailure | undefined;
  let turnFailure: DialogueFailure | undefined;
  // Every planner call of the turn, background corrections included.
  let turnPlannerUsage: TokenUsage | undefined;
  let turnRetrieval: ReturnType<typeof captureTokenUsage> | undefined;
  const replyRetrieval = new Map<string, TokenUsage>();
  let lastFailureUsage: PlannerMessageUsage | undefined;
  function observeRetrieval<T>(run: () => T): T {
    // Retrieval from planner tools is already covered by the planner observer.
    return turnRetrieval && !plannerTrace.getStore()?.active
      ? turnRetrieval.run(run)
      : run();
  }
  function addRetrieval(
    planner: TokenUsage | undefined,
    retrieval: TokenUsage | undefined,
  ): TokenUsage | undefined {
    if (!retrieval) return planner;
    return addTokenUsage(
      planner && !planner.models
        ? attributeTokenUsage(
            planner,
            chatResponseModel(selectedModel, config.llm.model, { userId, key }),
          )
        : planner,
      retrieval,
    );
  }
  function withRetrieval(
    message: PlannerMessage,
    retrieval: TokenUsage | undefined,
  ): PlannerMessage {
    return retrieval
      ? {
          ...message,
          usage: {
            ...message.usage,
            planner: addRetrieval(message.usage?.planner, retrieval),
          },
        }
      : message;
  }
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
      const result = await withSessionSettings(userId, key, () =>
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
  // A continued plan shares its evidence with background tasks and corrections.
  // Tasks from a superseded request retain their own bucket until they settle.
  let journalRequest: string | undefined;
  let requestJournal = new Map<string, JournalEntry>();
  const activeWorkerTraces = new Map<Map<string, JournalEntry>, Set<string>>();
  const currentJournal = () => {
    const request = (session?.snapshot() ?? savedState)?.requests?.at(-1)?.id;
    if (request !== journalRequest) {
      journalRequest = request;
      requestJournal = new Map();
    }
    return requestJournal;
  };
  const addJournal = (journal: Map<string, JournalEntry>, traceId?: string) => {
    const entries = recMcp.getToolJournal(traceId);
    for (const entry of entries) {
      if (entry.system) journal.set(entry.call.id, entry);
    }
    return entries.length > 0;
  };
  const journalForTurn = (traceId?: string, journal = currentJournal()) => {
    const entries = new Map(journal);
    addJournal(entries, traceId);
    for (const trace of activeWorkerTraces.get(journal) ?? [])
      addJournal(entries, trace);
    return entries;
  };
  const plannerTrace = new AsyncLocalStorage<{
    traceId?: string;
    active: boolean;
  }>();
  // Carry task admission into the worker callback and rebuild its request scope.
  // Dialogue workers receive only their brief; no request history is injected.
  const scope = new AsyncLocalStorage<{
    lease: ConnectionLease;
    pipeline: PipelineSession;
    traceId: string;
    journal: ReadonlyMap<string, JournalEntry>;
    taskId: string;
    ragCaller: RagCaller;
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
        const taskSignal =
          input.signal && ctx.pipeline.signal
            ? AbortSignal.any([input.signal, ctx.pipeline.signal])
            : (input.signal ?? ctx.pipeline.signal);
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
                () =>
                  runWithToolGateBypass(() =>
                    runWithDialogueRagTools(() =>
                      runWithContextCapture(
                        {
                          component:
                            profile?.result === 'verdict' || name === 'checker'
                              ? 'checker'
                              : 'executor',
                          taskId: ctx.taskId,
                          sessionKey: key,
                        },
                        () =>
                          withCheckerBrief(
                            {
                              claims: currentDelegateBrief(),
                              journal: ctx.journal,
                            },
                            () =>
                              worker.run({
                                ...input,
                                ...callOptionsFor(ctx.ragCaller),
                                trace: { traceId: ctx.traceId },
                                signal: taskSignal,
                              }),
                          ),
                      ),
                    ),
                  ),
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
    if (savedState) {
      savedState = migrateDialogueToolContract(savedState);
      const journal = savedState.toolJournal;
      if (journal && journal.requestId === savedState.requests?.at(-1)?.id) {
        journalRequest = journal.requestId;
        requestJournal = new Map(
          journal.entries.map((entry) => [entry.call.id, entry]),
        );
      }
    }
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
    const entries = [
      ...journalForTurn(plannerTrace.getStore()?.traceId).values(),
    ];
    const row = {
      ...state,
      toolJournal: entries.length
        ? { requestId: journalRequest, entries }
        : undefined,
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
    await outbox.add(withAdditionalTaskUsage(session?.takePending() ?? []));
  };
  const signals = dialogueSignals();
  const dialogueIdentity = (): RagCallerIdentity => {
    const { admin, channel, userMcpSession } = getRagCallerIdentity();
    return {
      admin,
      channel,
      userMcpSession,
      onToolResult: (record) => emit({ kind: 'tool-result', record }),
    };
  };
  const taskCallers = new Map<string, TurnCaller>();
  // Client turns survive any number of internal planner turns and task events.
  // Task ownership, rather than message roles or the latest send(), ties late
  // replies back to their original request, including when sends are queued.
  const historyTurns = new Map<string, HistoryTurn>();
  const recordedHistoryTurns = new Set<string>();
  const queuedHistoryTurns: Pick<
    HistoryTurn,
    'id' | 'caller' | 'text' | 'consumerMessages' | 'clientLoop'
  >[] = [];
  const taskHistoryTurns = new Map<string, HistoryTurn[]>();
  const completedHistoryTasks = new Set<string>();
  let activeHistoryTurns: HistoryTurn[] = [];
  let historyBoundary: { requestId?: string; offset: number } = { offset: 0 };
  const currentTurnTranscript = (request: PlannerRequestRecord | undefined) => {
    const transcript = request?.transcript ?? [];
    const offset =
      request?.id === historyBoundary.requestId ? historyBoundary.offset : 0;
    // Library transcript bounds can remove older entries while appending.
    return transcript.slice(
      Math.min(offset, Math.max(0, transcript.length - 1)),
    );
  };
  const historyAnswer = (text: string) => {
    for (const turn of activeHistoryTurns) turn.answer = stripNoMessage(text);
  };
  const finishHistory = (turns: Iterable<HistoryTurn>, succeeded: boolean) => {
    for (const turn of turns) {
      if (turn.tasks.size) continue;
      if (historyTurns.get(turn.id) === turn) historyTurns.delete(turn.id);
      if (
        succeeded &&
        turn.answer.trim() &&
        !recordedHistoryTurns.has(turn.id)
      ) {
        recordedHistoryTurns.add(turn.id);
        recordTurn(
          turn.caller,
          { role: 'user', content: turn.text },
          turn.answer,
          turn.id,
        );
      }
      turn.text = '';
      turn.answer = '';
      turn.consumerMessages = [];
      turn.clientLoop = [];
      turn.transcript = [];
      turn.taskAnswers.clear();
    }
  };
  const pendingEventTasks: string[] = [];
  let eventCaller: TurnCaller | undefined;
  let historyEventTurn = false;
  const resolveEventHistory = (request: PlannerRequestRecord | undefined) => {
    if (!historyEventTurn) return;
    // The library's turn-start signal has no event payload. Read task IDs from
    // its tagged event entries (including corrective notes), never client prose.
    // This covers inactivity/long-running notices as well as terminal outcomes.
    const ids = new Set<string>();
    for (const message of currentTurnTranscript(request)) {
      if (message.internalKind !== 'events' && message.internalKind !== 'note')
        continue;
      for (const line of (message.content ?? '').split('\n')) {
        const match = line.match(
          /^\[(?:task events|actions)\](?: from [^:]+:)? (?:- |task )?(\S+)/,
        );
        if (match && taskHistoryTurns.has(match[1])) ids.add(match[1]);
      }
    }
    activeHistoryTurns = [
      ...new Set([...ids].flatMap((id) => taskHistoryTurns.get(id) ?? [])),
    ];
    for (const id of ids)
      if (completedHistoryTasks.has(id))
        for (const turn of taskHistoryTurns.get(id) ?? [])
          turn.tasks.delete(id);
    const callers = [...ids].flatMap((id) => {
      const caller = taskCallers.get(id);
      return caller ? [caller] : [];
    });
    const origin = callers[0];
    eventCaller = origin
      ? {
          ...origin,
          identity: {
            ...origin.identity,
            userMcpSession: callers.every(
              (caller) =>
                caller.identity.userMcpSession ===
                origin.identity.userMcpSession,
            )
              ? origin.identity.userMcpSession
              : undefined,
            admin: callers.every(
              (caller) =>
                caller.identity.admin && caller.userId === origin.userId,
            ),
          },
        }
      : undefined;
  };
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
        taskHistoryTurns.set(task.id, [...activeHistoryTurns]);
        for (const turn of activeHistoryTurns) turn.tasks.add(task.id);
        taskCallers.set(task.id, {
          userId: getRequestUserId() ?? userId,
          ragCaller: trustedCaller.getStore() ?? boundCaller.value,
          identity: dialogueIdentity(),
        });
      }
      if (
        task.state === 'done' ||
        task.state === 'failed' ||
        task.state === 'stopped'
      ) {
        for (const turn of taskHistoryTurns.get(task.id) ?? []) {
          if (!turn.taskAnswers.has(task.id))
            turn.taskAnswers.set(
              task.id,
              task.error ?? task.output ?? `Task ${task.id} ${task.state}.`,
            );
        }
        completedHistoryTasks.add(task.id);
        pendingEventTasks.push(task.id);
      }
    },
    { source: slot(userId, key) },
  );
  const unsubscribeTurnCaller = signals.on(
    'dialogue.turn.started',
    ({ payload: { trigger } }) => {
      eventCaller = undefined;
      historyEventTurn = trigger === 'event';
      const request = session
        ?.snapshot()
        .requests?.find((item) => item.closedAt === undefined);
      // Every library turn owns only its new transcript entries. Late events
      // prepend their client owner's saved work, never an intervening turn.
      historyBoundary = {
        requestId: request?.id,
        offset: request?.transcript?.length ?? 0,
      };
      if (trigger !== 'event') {
        const queued = queuedHistoryTurns.shift();
        activeHistoryTurns = [];
        if (queued) {
          const turn: HistoryTurn = historyTurns.get(queued.id) ?? {
            ...queued,
            answer: '',
            tasks: new Set(),
            taskAnswers: new Map(),
            transcript: [],
          };
          turn.transcript = [];
          turn.consumerMessages = queued.consumerMessages;
          turn.clientLoop = queued.clientLoop;
          historyTurns.set(turn.id, turn);
          activeHistoryTurns = [turn];
        }
        return;
      }
      activeHistoryTurns = [];
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
  // TaskBoard stores a successful worker's usage. Rejections and result-store
  // embeddings occur outside that accounting.
  const additionalTaskSpend = new Map<string, TokenUsage>();
  const tasksWithoutRecordedWorkerUsage = new Set<string>();
  const addTaskSpend = (id: string, usage: TokenUsage | undefined) => {
    const spent = addTokenUsage(additionalTaskSpend.get(id), usage);
    if (spent) additionalTaskSpend.set(id, spent);
  };
  const withTaskSpend = (task: TaskRecord): TaskRecord => {
    const additional = additionalTaskSpend.get(task.id);
    return additional
      ? { ...task, usage: addTokenUsage(task.usage, additional) }
      : task;
  };
  function failedTurnUsage(): PlannerMessageUsage {
    const accountedTasks = new Set(
      outbox
        .history()
        .flatMap(
          (message) => message.usage?.tasks?.map((task) => task.id) ?? [],
        ),
    );
    return {
      planner: addRetrieval(turnPlannerUsage, turnRetrieval?.usage()),
      tasks: (session?.snapshot().tasks ?? []).flatMap((task) => {
        const usage = task.usage;
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
  function withRecordedTaskUsage(usage: PlannerMessageUsage | undefined) {
    if (!usage?.tasks?.some((task) => additionalTaskSpend.has(task.id)))
      return usage;
    return {
      ...usage,
      tasks: usage.tasks.map((task) => {
        const additional = additionalTaskSpend.get(task.id);
        return additional
          ? {
              ...task,
              usage: addTokenUsage(task.usage, additional) ?? task.usage,
            }
          : task;
      }),
    };
  }
  function withAdditionalTaskUsage(
    messages: PlannerMessage[],
  ): PlannerMessage[] {
    const available = (failedTurnUsage().tasks ?? []).filter((task) =>
      tasksWithoutRecordedWorkerUsage.has(task.id),
    );
    const unique = new Map(messages.map((message) => [message.id, message]));
    return [...unique.values()].map((message) => {
      // A later save can republish the library's original message without our
      // fallback usage. Preserve the spend already attached to that message.
      const retained =
        outbox.history().find((entry) => entry.id === message.id)?.usage
          ?.tasks ?? [];
      const extras = [
        ...retained.filter((task) => additionalTaskSpend.has(task.id)),
        ...available.splice(0),
      ].filter(
        (task) =>
          !message.usage?.tasks?.some((existing) => existing.id === task.id),
      );
      const usage = withRecordedTaskUsage(message.usage);
      return extras.length || usage !== message.usage
        ? {
            ...message,
            usage: {
              ...usage,
              tasks: [...(usage?.tasks ?? []), ...extras],
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
      turnRetrieval = captureTokenUsage();
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
    async ({ payload: { outcome, trigger, messageId } }) => {
      const request = session
        ?.snapshot()
        .requests?.find((item) => item.closedAt === undefined);
      const transcript = currentTurnTranscript(request);
      for (const turn of activeHistoryTurns)
        turn.transcript.push(...transcript);
      // Corrections may consume completed task events within the same library
      // turn. Otherwise retain ownership until the background event is handled.
      const activity = signals.last('dialogue.activity', slot(userId, key));
      const consumedHistoryTurns = new Set<HistoryTurn>();
      if ((activity?.payload.queuedInputs ?? 0) <= queuedHistoryTurns.length) {
        for (const id of completedHistoryTasks) {
          for (const turn of taskHistoryTurns.get(id) ?? []) {
            turn.tasks.delete(id);
            consumedHistoryTurns.add(turn);
          }
          taskHistoryTurns.delete(id);
          taskCallers.delete(id);
        }
        completedHistoryTasks.clear();
      }
      // A later client turn can consume an earlier turn's task events during
      // correction. The earlier turn gets its own full task results; only the
      // active turn gets the coordinator's combined final answer.
      const earlierHistoryTurns: HistoryTurn[] = [];
      for (const turn of consumedHistoryTurns)
        if (!activeHistoryTurns.includes(turn)) {
          turn.answer = [...turn.taskAnswers.values()].join('\n\n');
          earlierHistoryTurns.push(turn);
        }
      // Their results are final even if the later correction itself failed.
      finishHistory(earlierHistoryTurns, true);
      finishHistory(activeHistoryTurns, outcome === 'ok');
      activeHistoryTurns = [];
      settledSeq++;
      if (outcome === 'failed') {
        lastFailedSeq = settledSeq;
        lastFailureUsage = failedTurnUsage();
        const terminalError = request?.terminalError;
        const overflow = safeContextExceeded(terminalError);
        failure = overflow
          ? { ...chatRunFailureFacts(overflow), cause: overflow.message }
          : (turnFailure ??
            (terminalError && chatRunFailureFacts(terminalError)));
      } else if (trigger === 'user' && messageId) {
        const retrieval = turnRetrieval?.usage();
        if (retrieval) replyRetrieval.set(messageId, retrieval);
      }
      turnFailure = undefined;
      turnPlannerUsage = undefined;
      turnRetrieval = undefined;
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
    activeWorkerTraces.clear();
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
    withSessionSettings(userId, key, () =>
      runWithToolScope(coordinatorToolScope, async () => {
        await waitForSessionTurns(key, options.signal);
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
        const spend = captureTokenUsage();
        let reported: TokenUsage | undefined;
        const turn = { traceId: options.trace?.traceId, active: true };
        try {
          const result = await spend.run(() =>
            runWithContextCapture(
              { component: 'planner', sessionKey: key },
              () =>
                runWithSessionId(
                  key,
                  () =>
                    trustedCaller.run(
                      caller.ragCaller ?? options.caller ?? boundCaller.value,
                      () =>
                        plannerTrace.run(turn, () =>
                          withWriteActions(
                            () => journalForTurn(turn.traceId).values(),
                            () =>
                              decoratePlanner(planner).process(input, {
                                ...options,
                                ...callOptionsFor(
                                  caller.ragCaller ??
                                    options.caller ??
                                    boundCaller.value,
                                ),
                              }),
                          ),
                        ),
                    ),
                  undefined,
                  caller.userId,
                  caller.identity,
                ),
            ),
          );
          // The library appends this successful result before its final save.
          if (result.ok) {
            reported = spend.usage(result.value.usage);
            result.value.usage = reported;
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
            turnReplyUsage = addTokenUsage(turnReplyUsage, spend.usage());
            const { error, failure } = sanitizePlannerFailure(result.error);
            turnFailure = failure;
            return { ok: false as const, error };
          }
          return result;
        } catch (error) {
          turnReplyUsage = addTokenUsage(turnReplyUsage, spend.usage());
          const safe = sanitizePlannerFailure(error);
          turnFailure = safe.failure;
          throw safe.error;
        } finally {
          turnPlannerUsage = addTokenUsage(
            turnPlannerUsage,
            spend.usage(reported),
          );
          turn.active = false;
          if (addJournal(currentJournal(), turn.traceId))
            recMcp.dropRequest(turn.traceId);
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
  try {
    const retrieval = await plannerSessionOptions(
      userId,
      key,
      coordinatorResolver,
    );
    let coordinatorToolResolver = await coordinatorResolver();
    const taskResultStore = createTaskResultStore(
      () => getCollectionRegistry(),
      {
        userId,
        sessionKey: key,
      },
    );
    session = await DialogueSession.open({
      plannerContextBuilder: {
        build(input) {
          resolveEventHistory(input.open);
          const currentTranscript = [
            ...activeHistoryTurns.flatMap((turn) => turn.transcript),
            ...currentTurnTranscript(input.open),
          ];
          const clientLoop = activeHistoryTurns.flatMap(
            (turn) => turn.clientLoop,
          );
          const current = new DefaultPlannerContextBuilder().build({
            ...input,
            memory: [],
            open: input.open
              ? { ...input.open, transcript: currentTranscript }
              : undefined,
          });
          // The library's prose projector drops null-content tool-call messages.
          if (clientLoop.length) current.splice(1, 0, ...clientLoop);
          // Earlier dialogue transcripts are storage, not an alternate prompt source.
          // Only the consumer's explicit messages can precede the current turn on on.
          const supplied =
            config.agent.clientHistory === 'on'
              ? activeHistoryTurns.flatMap((turn) => turn.consumerMessages)
              : [];
          return [...supplied, ...current];
        },
      },
      caller: boundCaller.value,
      resultStore: {
        ...taskResultStore,
        async put(entry, options) {
          const spend = captureTokenUsage();
          try {
            // Keep the final task output before a correction consumes its event.
            for (const turn of taskHistoryTurns.get(entry.id) ?? [])
              turn.taskAnswers.set(entry.id, entry.output);
            return await spend.run(() => taskResultStore.put(entry, options));
          } finally {
            addTaskSpend(entry.id, spend.usage());
          }
        },
      },
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
          withSessionSettings(userId, key, async () => {
            const result = await observeProfilePreparation(
              options?.signal,
              () => profileRunner.createWorker(input, options),
            );
            return result.ok
              ? {
                  ok: true,
                  value: wrapWorker(
                    result.value,
                    input.profile,
                    currentRoleModel(roleOfProfile(input.profile)) ??
                      input.model ??
                      input.profile.model ??
                      config.llm.model,
                    input.model,
                  ),
                }
              : result;
          }),
        preparePlanner: async (input, options) =>
          withSessionSettings(userId, key, () =>
            runWithToolScope(coordinatorToolScope, async () => {
              resolveEventHistory(
                session
                  ?.snapshot()
                  .requests?.find((item) => item.closedAt === undefined),
              );
              coordinatorToolResolver = trustResolver.forProfile(input);
              const result = await withCoordinatorRun(
                async (run) =>
                  (await dialogueFor(userId, key, destination)).runStep(run),
                () =>
                  withCoordinatorModel(
                    currentRoleModel('coordinator') ?? selectedModel,
                    () =>
                      observeRetrieval(() =>
                        observeProfilePreparation(options?.signal, () =>
                          profileRunner.preparePlanner(input, options),
                        ),
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
      plannerMemory: retrieval.plannerMemory && {
        ...retrieval.plannerMemory,
        rag: new Proxy(retrieval.plannerMemory.rag, {
          get(target, property) {
            if (property === 'query') {
              const query: typeof target.query = (...args) =>
                observeRetrieval(() => target.query(...args));
              return query;
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      },
      plannerKnowledge: retrieval.plannerKnowledge?.map(
        (source) =>
          new Proxy(source, {
            get(target, property) {
              if (property === 'search') {
                const search: typeof target.search = (...args) =>
                  observeRetrieval(() => target.search(...args));
                return search;
              }
              return Reflect.get(target, property, target);
            },
          }),
      ),
      ...(usage ? { usage } : {}),
      id: boundCaller.value.sessionId,
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
            tasks: state.tasks.map(withTaskSpend),
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
          // The library has now applied corrections and recomputed plan status.
          // User sends have no onMessage callback; read their final saved reply.
          if (activeHistoryTurns.length) {
            const lastAssistant = [...state.conversation]
              .reverse()
              .find((message) => message.role === 'assistant');
            historyAnswer(
              typeof lastAssistant?.content === 'string'
                ? lastAssistant.content
                : '',
            );
          }
          const planner = addRetrieval(turnReplyUsage, turnRetrieval?.usage());
          await outbox.upsert(
            turnReply && text.trim()
              ? [
                  {
                    id: turnReply.id,
                    createdAt: turnReply.createdAt,
                    text,
                    trigger: 'user',
                    ...(planner ? { usage: { planner } } : {}),
                  },
                ]
              : [],
            withAdditionalTaskUsage(state.pending),
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
        baseInput: () => ({
          sessionId: key,
          sessionLogger: toolCallDiagnosticsLogger({ channel: 'dialogue' }),
        }),
        async wrapRun(task, run) {
          // TaskBoard starts execution in the scheduling planner scope; its
          // async context survives pool waits and later user turns.
          const caller = taskCallers.get(task.id) ?? {
            ragCaller: trustedCaller.getStore() ?? boundCaller.value,
            userId: getRequestUserId() ?? userId,
            identity: dialogueIdentity(),
          };
          const turn = plannerTrace.getStore();
          const journal = currentJournal();
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
          let overflow: ReturnType<typeof safeContextExceeded>;
          const spend = captureTokenUsage();
          const traceId = randomUUID();
          const traces = activeWorkerTraces.get(journal) ?? new Set<string>();
          activeWorkerTraces.set(journal, traces);
          traces.add(traceId);
          emitTask(task);
          try {
            const result = await runAdmitted(async (acquiredLease, pipeline) =>
              scope.run(
                {
                  lease: acquiredLease,
                  pipeline,
                  traceId,
                  journal: journalForTurn(
                    turn?.active ? turn.traceId : undefined,
                    journal,
                  ),
                  taskId: task.id,
                  ...caller,
                  ragCaller: caller.ragCaller ?? boundCaller.value,
                },
                () =>
                  runWithContextCapture(
                    { component: 'other', taskId: task.id, sessionKey: key },
                    // Workers report spend on TaskRecord, outside the planner bucket.
                    () =>
                      spend.run(() =>
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
            const usage = spend.usage(result.usage);
            if (!usage) tasksWithoutRecordedWorkerUsage.add(task.id);
            return usage ? { ...result, usage } : result;
          } catch (error) {
            tasksWithoutRecordedWorkerUsage.add(task.id);
            addTaskSpend(task.id, spend.usage());
            overflow = safeContextExceeded(error);
            throw overflow ?? error;
          } finally {
            if (!stopped) addJournal(journal, traceId);
            traces.delete(traceId);
            if (!traces.size) activeWorkerTraces.delete(journal);
            try {
              recMcp.dropRequest(traceId);
            } catch (error) {
              cds.log('dialogue-sessions').warn('dropRequest failed', {
                errorType: error instanceof Error ? error.name : typeof error,
              });
            }
            emitTask({
              ...task,
              state,
              ...(overflow && {
                error: overflow.message,
                terminalErrorCode: overflow.code,
              }),
            });
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
        historyAnswer(message.text);
        const pending = session?.takePending() ?? [];
        void outbox
          .add(
            withAdditionalTaskUsage([
              withRetrieval(message, turnRetrieval?.usage()),
              ...pending.filter((entry) => entry.id !== message.id),
            ]),
          )
          .catch(() => {
            /* Retain in memory and retry persistence on next save. */
          });
      },
    });
    await drainPending();
  } catch (error) {
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
        ...withTaskSpend(task),
        ...withQueueActivity(task),
      })),
    };
  };
  lastPlan = dialoguePlan(session.snapshot());
  // Requests may bind a new caller; the library session owns one caller object.
  const sessionOptions = (options: CallOptions = {}): CallOptions => {
    if (
      (options.caller &&
        (options.caller.sessionId !== key ||
          options.caller.userId !== userId)) ||
      (options.sessionId !== undefined && options.sessionId !== key)
    )
      throw new RagAccessDeniedError('Caller does not match dialogue session');
    return { ...options, ...callOptionsFor(boundCaller.value) };
  };
  const callTool = session.callTool.bind(session);
  session.callTool = (...args) =>
    llms.run(async () => {
      const options = sessionOptions(args[2]);
      const steps = unusableCheckerPlanSteps(session.snapshot());
      if (steps) {
        const reset = await callTool('plan_update', { steps }, options);
        if (!reset.ok || reset.value.isError) return reset;
      }
      return trustedCaller.run(boundCaller.value, () =>
        withDelegateBrief(args[0], args[1], () =>
          callTool(args[0], args[1], options),
        ),
      );
    });
  const send = session.send.bind(session);
  session.send = (text, options = {}) => {
    options = sessionOptions(options);
    // send accepts only the new client text. All later planner/delegation
    // histories are hub-owned and must pass through without role-based cuts.
    const clientMessages = clientTurnMessages.getStore() ?? [];
    const historyId = `dialogue:${clientTurnId.getStore() ?? clientHistoryTurnId(clientMessages) ?? randomUUID()}`;
    let clientUserIndex = clientMessages.length - 1;
    while (
      clientUserIndex >= 0 &&
      clientMessages[clientUserIndex].role !== 'user'
    )
      clientUserIndex--;
    const queued = {
      id: historyId,
      caller: options.caller ?? boundCaller.value,
      text,
      consumerMessages:
        config.agent.clientHistory === 'on' && clientUserIndex > 0
          ? clientMessages.slice(0, clientUserIndex)
          : [],
      clientLoop:
        clientUserIndex < 0
          ? []
          : clientMessages
              .slice(clientUserIndex + 1)
              .filter((message) => message.role !== 'system'),
    };
    queuedHistoryTurns.push(queued);
    emit({
      kind: 'turn',
      source: turnSource.getStore() ?? 'mcp',
      ...(clientTurnId.getStore()
        ? { clientTurnId: clientTurnId.getStore() }
        : {}),
      text,
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
      ragCaller: options.caller ?? boundCaller.value,
      identity: dialogueIdentity(),
    });
    // The library can drain several users and task events in one async chain.
    // The turn and TaskBoard callbacks own their spend independently.
    return llms.run(() =>
      runWithoutLlmSpend(() => send(text, { ...options, trace }))
        .then((reply) => {
          const retrieval = replyRetrieval.get(reply.id);
          replyRetrieval.delete(reply.id);
          const message = withRetrieval(reply, retrieval);
          const usage = withRecordedTaskUsage(message.usage);
          return usage === message.usage ? message : { ...message, usage };
        })
        .finally(() => {
          const index = queuedHistoryTurns.indexOf(queued);
          if (index !== -1) queuedHistoryTurns.splice(index, 1);
          return drainPending();
        }),
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
    caller: boundCaller.value,
    toolJournal: journalForTurn,
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
        failure,
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
      clearExecutionLimits(userId, key);
      clearRoleModels(userId, key);
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

function withSessionSettings<T>(
  userId: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRoleModels(
    getRoleModels(userId, key),
    fn,
    getExecutionLimits(userId, key),
  );
}
