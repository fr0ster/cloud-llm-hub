import {
  currentLimit,
  currentSessionLimit,
  effectiveExecutionLimits,
  executionLimitsSchema,
  getExecutionLimits,
  setExecutionLimits,
  validateExecutionLimits,
} from './lib/execution-limits';
import { withModelCatalog } from './lib/model-catalog';
import { parseModelAllowlist } from './lib/model-policy';
import { bindCaller, callOptionsFor } from './lib/rag-caller';
import {
  getRoleModels,
  roleModelSettingsSchema,
  setRoleModels,
  validateRoleModelSettings,
} from './lib/role-model-settings';
import {
  currentRoleModel,
  effectiveRoleModels,
  withRoleModels,
} from './lib/role-models-scope';
import { resolveSessionKey } from './session-id';

export {
  EXECUTE_STEP_DESCRIPTION,
  executeStepSchema,
  listDestinations,
  listDestinationsDefinition,
} from './lib/coordinator-tool-definitions';

import {
  type OrchestrationTool,
  registerOrchestrationTools,
} from './agent-mcp-orchestration';
import {
  EXECUTE_STEP_DESCRIPTION,
  executeStepSchema,
  listDestinations,
  listDestinationsDefinition,
} from './lib/coordinator-tool-definitions';
import { runExecutorStep } from './lib/executor-step';
import { requestStart } from './lib/request-start';
import type { LongSessionRequest } from './lib/session-connection';
import {
  measureRequest,
  requestMeasurement,
} from './lib/usage/request-records';
import type { UsageSession } from './lib/usage/storage-snapshot';
import { tokenUsageToWire } from './lib/usage-wire';
/**
 * Planner/controller MCP surface — a SEPARATE MCP endpoint that exposes
 * tools for an external planner (e.g. Claude Code):
 *
 *   - `list_destinations` — the SAP systems this instance can reach, so the
 *     planner can choose one.
 *   - `execute_step` — delegate exactly ONE operation per call to the SmartAgent executor on
 *     the chosen destination and return its text.
 *
 * The division of labour lives in `execute_step`'s description: the connecting
 * client is the planner/controller; the agent behind the tool is an
 * executor that can continue an explicitly opened session. The full ABAP tool set stays on `/mcp/stream/http`; this is an
 * additive, parallel surface.
 *
 * Auth is unchanged: SAP credentials arrive in `x-sap-login` / `x-sap-password`
 * headers (set by the auth proxy's defaults or overridden by the client). The
 * server binds held connections to the caller credentials. The destination is chosen per call (the
 * `destination` argument), so the SAP connection is built lazily inside the
 * `execute_step` handler — `list_destinations` and the MCP handshake need no
 * connection at all.
 */

import './env-setup';

import { randomUUID } from 'node:crypto';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import type { Message } from '@mcp-abap-adt/llm-agent';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  closeDestination,
  createAgentProfileSource,
  type ExecutorAgentHandle,
  getSmartAgent,
  isDestinationClosed,
  retryAfterForDestination,
  runWithRequestConnection,
} from './agent-manager';
import {
  type RagMcpTool,
  registerRagMcpTools,
  ragTextResult as textResult,
} from './agent-mcp-rag';
import {
  buildConnectionForDestination,
  dumpScopeForConnection,
} from './lib/background-connection';
import type { ExpositionLevel } from './lib/exposition';
import { describeCaller } from './lib/exposition';
import {
  admitPipeline,
  type PipelineAdmission,
  type PipelineSession,
  theDoor,
} from './lib/gatekeeper';
import { recordDestinationRefusal } from './lib/gatekeeper-metrics';
import { type LongSession, longSessions } from './lib/long-session';
import { describeCause, isOutageError } from './lib/mcp-outage';
import type { DumpScope } from './lib/principal';

import {
  resolveRequestSystem,
  runWithRequestSystem,
} from './lib/request-system-context';
import { Semaphore } from './lib/semaphore';
import {
  acquireSessionConnection,
  releaseRequestConnection,
} from './lib/session-connection';
import {
  openSession,
  resolveSession,
  SessionLimitError,
  SessionNotReadyError,
  setSessionAgentsCollection,
  takeRevivalNotice,
} from './lib/session-lifecycle';
import { recordTurn } from './lib/session-turns';
import {
  destinationClosedText,
  executeStepDoorRefusal,
  failureText,
  type RecMcpHandle,
  sessionClosedText,
  throttleMessage,
  throttleOf,
  unverifiedWriteFor,
} from './lib/throttle-surfacing';
import { usageRuntime } from './lib/usage/runtime';
import { runWithSessionId } from './request-session';
import { appendToSession, getSessionHistory } from './session-store';

/**
 * The cap on concurrent `execute_step` runs when no door is configured.
 *
 * The ancestor of the gatekeeper's door: parallel steps each spike memory, and
 * an unbounded fan-out OOMed a 1 GB container. With `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`
 * set, this route counts against the shared door instead and the semaphore is
 * not taken — two caps on one resource would each be wrong about the other.
 */
export { buildConnectionForDestination } from './lib/background-connection';

const EXEC_STEP_MAX_CONCURRENCY = 2;
const execStepSemaphore = new Semaphore(EXEC_STEP_MAX_CONCURRENCY);

export interface AgentMcpResult {
  transport: StreamableHTTPServerTransport;
  cleanup: () => Promise<void>;
}

export interface StepCaller {
  userId: string;
  exposition: ExpositionLevel[] | undefined;
}

/**
 * One `execute_step` call. The tool callback delegates here so a test can drive it.
 *
 * `callerSignal` is the MCP request's own signal, which the SDK aborts when the
 * transport closes — the planner's timeout fired and it went away. It reaches
 * the door's queue and nothing else: a waiter nobody is behind leaves, and is
 * never later handed a slot to run the step (and its write) for nobody. Once
 * admitted, the pipeline runs under the admission's signal, which only shutdown
 * aborts.
 */
export function executeStep(
  req: Request,
  caller: StepCaller,
  input: {
    session?: string;
    destination?: string;
    task: string;
    worker?: string;
    model?: string;
  },
  signal?: AbortSignal,
) {
  return withModelCatalog(() =>
    executeStepWithCatalog(req, caller, input, signal),
  );
}

function executeStepWithCatalog(
  req: Request,
  caller: StepCaller,
  input: {
    session?: string;
    destination?: string;
    task: string;
    worker?: string;
    model?: string;
  },
  signal?: AbortSignal,
) {
  requestStart(req);
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('request') && !runtime.enabled('session')))
    return executeStepMeasured(req, caller, input, signal);
  return measureAgentTool(
    req,
    {
      userId: caller.userId,
      sessionId:
        input.session ??
        (req as LongSessionRequest).longSession?.key ??
        resolveSessionKey(req).key,
      destination: input.destination,
    },
    'execute_step',
    (): Promise<{
      isError?: boolean | undefined;
      content: { type: 'text'; text: string }[];
    }> => executeStepMeasured(req, caller, input, signal),
    signal,
  );
}

function measuredAgentCallback<
  T extends { session?: string; destination?: string },
  R extends ReturnType<typeof textResult>,
>(
  req: Request,
  userId: string,
  tool:
    | 'session_open'
    | 'session_set_models'
    | 'session_close'
    | 'list_destinations'
    | RagMcpTool
    | OrchestrationTool,
  run: (args: T) => Promise<R>,
): (args: T) => Promise<R> {
  const callback = run;
  run = (args) => withModelCatalog(() => callback(args));
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('request') && !runtime.enabled('session')))
    return run;
  return (args: T): Promise<R> =>
    measureAgentTool(
      req,
      {
        userId,
        sessionId:
          args.session ??
          (req as LongSessionRequest).longSession?.key ??
          resolveSessionKey(req).key,
        destination: args.destination,
      },
      tool,
      (): Promise<R> => run(args),
    );
}

async function measureAgentTool<R extends ReturnType<typeof textResult>>(
  req: Request,
  session: Omit<UsageSession, 'sessionId'> & { sessionId?: string },
  tool:
    | 'execute_step'
    | 'session_open'
    | 'session_set_models'
    | 'session_close'
    | 'list_destinations'
    | RagMcpTool
    | OrchestrationTool,
  run: () => Promise<R>,
  signal?: AbortSignal,
) {
  if (!session.sessionId) return run();
  const measurement = measureRequest(
    req,
    req.res,
    { ...session, sessionId: session.sessionId },
    'mcp-agent',
    false,
    tool,
  );
  if (!measurement) return run();
  const disconnected = (): void => measurement.responseEnded('disconnected');
  if (signal?.aborted) disconnected();
  signal?.addEventListener('abort', disconnected, { once: true });
  try {
    const result = await run();
    if (result.isError) measurement?.end('error');
    if (!req.res)
      measurement?.outputBytes(Buffer.byteLength(JSON.stringify(result)));
    return result;
  } catch (error) {
    measurement?.end('error');
    throw error;
  } finally {
    signal?.removeEventListener('abort', disconnected);
    measurement?.finish();
  }
}

async function executeStepMeasured(
  req: Request,
  caller: StepCaller,
  args: {
    session?: string;
    destination?: string;
    task: string;
    worker?: string;
    model?: string;
  },
  callerSignal?: AbortSignal,
) {
  const key =
    args.session?.trim() ||
    (req as LongSessionRequest).longSession?.key ||
    resolveSessionKey(req).key;
  if (!key)
    return textResult(
      'SESSION_REQUIRED: supply the x-clh-session header',
      true,
    );
  try {
    const s = await resolveSession(caller.userId, key);
    if (!s) return textResult('SESSION_NOT_FOUND', true);
    const result = await longSessions().run(s, () =>
      withRoleModels(
        getRoleModels(caller.userId, s.key),
        async () => {
          if (
            s.destination !== undefined &&
            args.destination !== undefined &&
            args.destination.trim() !== s.destination
          ) {
            return textResult(
              `Destination "${args.destination}" differs from session destination "${s.destination}".`,
              true,
            );
          }
          return executeStepRun(
            req,
            caller,
            { ...args, destination: s.destination ?? args.destination },
            callerSignal,
            s,
          );
        },
        getExecutionLimits(caller.userId, s.key),
      ),
    );
    return 'refused' in result ? textResult(result.refused, true) : result;
  } catch (err) {
    return textResult(
      err instanceof SessionLimitError
        ? 'SESSION_LIMIT'
        : err instanceof SessionNotReadyError
          ? 'SESSION_STORE_UNAVAILABLE: the hub is starting, retry shortly'
          : `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

async function executeStepRun(
  req: Request,
  caller: StepCaller,
  {
    destination,
    task,
    worker = 'executor',
    model,
  }: { destination?: string; task: string; worker?: string; model?: string },
  callerSignal: AbortSignal | undefined,
  longSession: LongSession,
) {
  const stepStartedAt = requestStart(req);
  const measurement = requestMeasurement(req);
  const log = cds.log('agent-mcp');
  const { userId, exposition } = caller;
  // With a door, this route counts against it; without one, today's semaphore.
  const releaseSemaphore = theDoor()
    ? undefined
    : await execStepSemaphore.acquire();
  let connection: IAbapConnection | undefined;
  // Handle + traceId are assigned inside the try below but read from the
  // `finally` (dropRequest), so they must be declared in the outer scope.
  let handle: Awaited<ReturnType<typeof getSmartAgent>> | undefined;
  let traceId: string | undefined;
  let pipeline: PipelineSession | undefined;
  // Read from the `catch` below to close a destination an outage error
  // names, so it must be declared in the outer scope like the others.
  let targetDestination: string | undefined;
  // NOTE: no `req.on('close', ...)` safe-stop hook here. For Node/Express,
  // the request stream's `close` event fires once the BODY is consumed —
  // right after this JSON-RPC call starts — NOT reliably on client abort.
  // Wiring safeStop(connection) to it could tear down the ABAP session
  // (closeSession) while a tool call is still in flight, which is exactly
  // the orphaned-state failure we're trying to avoid. `callerSignal` is only
  // ever used to leave the queue; teardown is left entirely to the `finally`
  // below, which releases the held connection once the step completes.
  try {
    // Destination from the arg, else the connection's default header.
    const headerDestination = (
      req.headers['x-sap-destination'] as string | undefined
    )?.trim();
    targetDestination = destination?.trim() || headerDestination;
    if (!targetDestination) {
      return textResult(
        'ERROR: No destination. Pass a `destination` argument, or configure a default `X-SAP-Destination` header on this MCP server. See list_destinations.',
        true,
      );
    }

    // A closed destination refuses before the caller takes a place — before
    // a connection is even built for it. No `res`/connection exist yet here;
    // the `finally` below already handles an undefined `connection`.
    if (isDestinationClosed(targetDestination)) {
      recordDestinationRefusal(targetDestination);
      const seconds = retryAfterForDestination(targetDestination);
      const when =
        seconds !== undefined ? ` Try again in about ${seconds} seconds.` : '';
      return textResult(
        `${destinationClosedText(targetDestination)}${when}`,
        true,
      );
    }

    handle = await getSmartAgent(
      undefined,
      targetDestination,
      currentRoleModel('executor') !== undefined ||
        currentLimit('executor', 'maxIterations') !== undefined ||
        currentLimit('executor', 'maxToolCalls') !== undefined ||
        currentSessionLimit('historyTokenBudget') !== undefined ||
        currentSessionLimit('toolResultMaxChars') !== undefined,
    );
    const agentHandle = handle as ExecutorAgentHandle;

    traceId = requestMeasurement(req)?.traceId ?? `agent-step-${randomUUID()}`;
    const sessionId = longSession.key;
    const boundCaller = await bindCaller(
      sessionId,
      userId,
      cds.context?.user?.is('MCP_Admin') === true,
    );
    if (!boundCaller.ok) return textResult(boundCaller.error.message, true);

    // Admitted after the agent is resolved, like every channel, and before a
    // connection is built: a queued step holds no CSRF-fetched SAP session.
    let admission: PipelineAdmission;
    try {
      admission = await admitPipeline(userId, sessionId, callerSignal);
    } catch {
      // Left while queued (or the process is shutting down). Nothing was
      // started and no connection exists, so nothing is owed; nobody reads
      // this result, the transport it would go back on is already closed.
      log.info('execute_step caller left before admission', {
        destination: targetDestination,
      });
      return textResult(
        'ERROR: the caller left before this step was admitted; nothing was run.',
        true,
      );
    }
    if ('refused' in admission) {
      return textResult(executeStepDoorRefusal(admission.refused), true);
    }
    if ('closed' in admission) {
      // Unreachable: a step mints its own session and never presents one. The
      // union still has to be answered.
      return textResult(sessionClosedText(), true);
    }
    pipeline = admission.admitted;
    const admitted = pipeline;

    let dumpScope: DumpScope | undefined;
    let notice: string | undefined;
    if (longSession) {
      let refusal = '';
      const response = {
        writeHead() {},
        end(body?: string) {
          refusal = body ?? '';
        },
        setHeader() {},
      } as unknown as Response;
      const acquired = await acquireSessionConnection(
        longSession,
        req,
        response,
        targetDestination,
      );
      if (acquired.handled) return textResult(refusal, true);
      connection = acquired.connection;
      dumpScope = acquired.dumpScope;
      notice = acquired.notice;
    } else {
      const built = await buildConnectionForDestination(req, targetDestination);
      connection = built.connection;
      dumpScope = dumpScopeForConnection(built, userId);
    }

    const usage = usageRuntime()
      ?.forSession({
        sessionId,
        userId,
        destination: targetDestination,
      })
      .with({ requestId: traceId, traceId });
    requestMeasurement(req)?.bind(usage, {
      userId,
      sessionId,
      destination: targetDestination,
    });
    measurement?.admitted();
    const opts = {
      requestStartedAt: requestStart(req),
      stream: false,
      externalTools: [],
      ...callOptionsFor(boundCaller.value),
      ragFilter: {
        namespace: `${userId}:${targetDestination}`,
        exposition,
      },
      trace: { traceId },
      ...(usage ? { usage } : {}),
      // Surface skill selection on the planner path (chat has its own
      // sessionLogger; execute_step had none, so skill matching was invisible).
      sessionLogger: {
        logStep(name: string, data: unknown) {
          if (
            name === 'skills_selected' ||
            name === 'skill_select_rag_fallback'
          ) {
            log.info(name, { destination: targetDestination, data });
          }
        },
      },
      // The admission's signal, which only shutdown aborts.
      signal: admitted.signal,
    };

    const history = longSession ? getSessionHistory(sessionId, userId) : [];
    const conn = connection;
    const r = await admitted.run(() => {
      // Admitted, right before the run: this step's responsible person and
      // master system, visible to it alone — see `lib/request-system-context.ts`.
      const system = resolveRequestSystem(req.headers);
      return runWithRequestSystem(system, () =>
        runWithSessionId(
          sessionId,
          () =>
            runWithRequestConnection(
              conn,
              async () => {
                // An external agent uses this hub as its subagent: the executor
                // runs alone, no controller. The honesty check the controller's
                // NoticeFinalizer gives chat runs here instead, with the same
                // inputs and the same trailing NOTICE.
                return runExecutorStep(
                  createAgentProfileSource,
                  agentHandle,
                  userId,
                  task,
                  worker,
                  opts,
                  history,
                  model,
                );
              },
              dumpScope,
              exposition,
            ),
          history,
          userId,
          {
            admin: cds.context?.user?.is('MCP_Admin') ?? false,
            channel: 'mcp-agent',
          },
        ),
      );
    });

    if (!r.ok) {
      if (isOutageError(r.error)) {
        closeDestination(targetDestination, describeCause(r.error));
      }
      log.info('execute_step done', {
        ok: false,
        destination: targetDestination,
      });
      const limit = throttleOf(r.error);
      const unverified = unverifiedWriteFor(handle, traceId, r.error);
      const message = unverified
        ? limit
          ? `${unverified} ${throttleMessage(limit)}`
          : unverified
        : failureText(r.error);
      return textResult(
        `ERROR on destination "${targetDestination}": ${message}`,
        true,
      );
    }

    const rawContent = r.value.content ?? '';
    if (measurement && /\S/.test(rawContent) && !callerSignal?.aborted)
      measurement?.deliverOnResponseEnd();
    log.info('execute_step done', {
      ok: true,
      destination: targetDestination,
      iterations: r.value.iterations,
      toolCallCount: r.value.toolCallCount,
      totalTokens: r.value.usage?.totalTokens,
      stopReason: r.value.stopReason,
    });
    if (longSession) {
      const lastUser: Message = { role: 'user', content: task };
      appendToSession(sessionId, userId, lastUser, {
        role: 'assistant',
        content: rawContent,
      });
      recordTurn(boundCaller.value, lastUser, rawContent);
    }
    if (longSession && takeRevivalNotice(longSession)) notice = 'revived';
    const durationMs = Date.now() - stepStartedAt;
    const tokens = tokenUsageToWire(r.value.usage);
    const wireUsage = tokens
      ? { ...tokens, duration_ms: durationMs }
      : undefined;
    const emptyResult = !/\S/.test(rawContent);
    const reply = emptyResult
      ? `EMPTY_RESULT on destination "${targetDestination}": The executor finished without a reply. The system state of the step is unknown and must be verified by a separate read step.${r.value.iterations !== undefined ? ` iterations=${r.value.iterations}` : ''}${r.value.toolCallCount !== undefined ? ` toolCallCount=${r.value.toolCallCount}` : ''}${r.value.stopReason !== undefined ? ` stopReason=${r.value.stopReason}` : ''}`
      : rawContent;
    const content = notice ? `${notice}\n${reply}` : reply;
    return {
      ...textResult(
        wireUsage
          ? `${content}\n[usage]${wireUsage ? ` prompt=${wireUsage.prompt_tokens} completion=${wireUsage.completion_tokens} total=${wireUsage.total_tokens}` : ''} time=${(durationMs / 1000).toFixed(1)}s`
          : content,
        emptyResult,
      ),
      ...(wireUsage
        ? {
            structuredContent: {
              result: content,
              ...(wireUsage ? { usage: wireUsage } : {}),
            },
          }
        : {}),
    };
  } catch (err) {
    if (targetDestination && isOutageError(err)) {
      closeDestination(targetDestination, describeCause(err));
    }
    const unverified = unverifiedWriteFor(handle, traceId, err);
    const message =
      unverified ?? (err instanceof Error ? err.message : String(err));
    measurement?.end('error');
    log.warn('execute_step failed', { destination, error: message });
    return textResult(`ERROR: ${message}`, true);
  } finally {
    // Drain calls before releasing the connection, pipeline slot and semaphore.
    // The long session keeps its connection until session close. Refused/closed
    // admission never ran the pipeline, so there is no per-trace bucket to
    // free — dropRequest only makes sense once the pipeline actually ran.
    await pipeline?.drain();
    await releaseRequestConnection(connection, longSession);
    if (pipeline) {
      // Free the per-trace telemetry bucket — nobody else calls dropRequest,
      // so omitting this leaks memory per call (Verified fact 10). Guarded: a
      // throw here must not skip the release below, which would hold the slot
      // until restart.
      try {
        (handle as unknown as RecMcpHandle)?.recMcp?.dropRequest(traceId);
      } catch (err) {
        log.warn('dropRequest failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    pipeline?.release();
    releaseSemaphore?.();
  }
}

/**
 * Build the per-request single-purpose MCP server for `/mcp/agent/stream/http`.
 * No SAP connection or agent is resolved here — both tool handlers do their own
 * lazy work, so the MCP handshake and `list_destinations` never depend on a
 * destination being reachable.
 */
export async function createAgentMcpServerForRequest(
  req: Request,
): Promise<AgentMcpResult> {
  requestStart(req);
  const log = cds.log('agent-mcp');

  // Captured once (the user/roles are stable for the request); the destination
  // is per call, so it is read from the tool arguments below.
  const caller = describeCaller(cds.context?.user);
  log.info('MCP caller', caller);
  const userId = caller.id;
  const exposition = caller.exposition;

  const server = new McpServer({
    name: 'cloud-llm-hub-agent',
    version: '1.0.0',
  });

  registerRagMcpTools(server, req, userId, (name, run) =>
    measuredAgentCallback(req, userId, name, run),
  );

  await registerOrchestrationTools(
    server,
    req,
    { userId, exposition },
    (name, run) => measuredAgentCallback(req, userId, name, run),
  );

  // --- list_destinations --------------------------------------------------
  server.registerTool(
    'list_destinations',
    listDestinationsDefinition,
    measuredAgentCallback(req, userId, 'list_destinations', listDestinations),
  );

  const admin = cds.context?.user?.is('MCP_Admin') ?? false;
  const settingsSchema = {
    models: roleModelSettingsSchema.optional(),
    limits: executionLimitsSchema.optional(),
  };
  type SettingsInput = {
    models?: z.input<typeof roleModelSettingsSchema>;
    limits?: z.input<typeof executionLimitsSchema>;
  };
  const validateSettings = (input: SettingsInput) => {
    if (!admin && (input.models !== undefined || input.limits !== undefined))
      return {
        field: input.models !== undefined ? 'models' : 'limits',
        reason: 'MCP_Admin is required',
      };
    const models = validateRoleModelSettings(input.models ?? {}, {
      allow: parseModelAllowlist(),
      channel: 'mcp',
      paramsEnabled: false,
    });
    if (!models.ok) return models.error;
    if (input.limits?.coordinator !== undefined)
      return {
        field: 'coordinator',
        reason: 'The connecting agent is the coordinator on MCP',
      };
    const limits = validateExecutionLimits(input.limits ?? {}, {
      libraryLimitsEnabled: false,
    });
    if (!limits.ok) return limits.error;
    return undefined;
  };
  const applySettings = (key: string, input: SettingsInput) => {
    const models = validateRoleModelSettings(input.models ?? {}, {
      allow: parseModelAllowlist(),
      channel: 'mcp',
      paramsEnabled: false,
    });
    const limits = validateExecutionLimits(input.limits ?? {}, {
      libraryLimitsEnabled: false,
    });
    if (!models.ok || !limits.ok)
      throw new Error('Settings changed during validation');
    if (input.models !== undefined) setRoleModels(userId, key, models.value);
    if (input.limits !== undefined)
      setExecutionLimits(userId, key, limits.value);
    return {
      settings: getRoleModels(userId, key),
      effective: effectiveRoleModels(userId, key),
      limits: getExecutionLimits(userId, key),
      effectiveLimits: effectiveExecutionLimits(userId, key),
    };
  };
  if (admin)
    server.registerTool(
      'session_set_models',
      {
        description:
          'Replace role models and execution limits for an owned session.',
        inputSchema: { session: z.string(), ...settingsSchema },
      },
      measuredAgentCallback(
        req,
        userId,
        'session_set_models',
        async (input: SettingsInput & { session: string }) => {
          const session = await resolveSession(userId, input.session);
          if (!session) return textResult('SESSION_NOT_FOUND', true);
          const error = validateSettings(input);
          if (error) return textResult(JSON.stringify({ error }), true);
          return textResult(JSON.stringify(applySettings(session.key, input)));
        },
      ),
    );

  server.registerTool(
    'session_open',
    {
      description:
        'Open a session for multi-step work sharing conversation and ABAP connection.',
      inputSchema: z.strictObject({
        destination: z.string().optional(),
        agentsCollectionId: z.string().optional(),
        ...(admin ? settingsSchema : {}),
        session: z.string().optional(),
      }),
    },
    (args) =>
      measuredAgentCallback(
        req,
        userId,
        'session_open',
        async ({
          destination,
          agentsCollectionId,
          session,
          models,
          limits,
        }: SettingsInput & {
          destination?: string;
          agentsCollectionId?: string;
          session?: string;
        }): Promise<{
          isError?: boolean | undefined;
          content: { type: 'text'; text: string }[];
        }> => {
          const error = validateSettings({ models, limits });
          if (error) return textResult(JSON.stringify({ error }), true);
          const headerDestination = req.headers['x-sap-destination'];
          const target =
            destination?.trim() ||
            (typeof headerDestination === 'string'
              ? headerDestination.trim()
              : undefined);
          let s: Awaited<ReturnType<typeof openSession>>;
          try {
            if (session !== undefined) {
              const existing = await resolveSession(userId, session);
              if (!existing) return textResult('SESSION_NOT_FOUND', true);
              await setSessionAgentsCollection(existing, agentsCollectionId);
              s = existing;
            } else s = await openSession(userId, target, agentsCollectionId);
          } catch (error) {
            return textResult(
              error instanceof Error
                ? error.message
                : 'Invalid agentsCollectionId',
              true,
            );
          }
          if (!('refused' in s)) applySettings(s.key, { models, limits });
          if (!('refused' in s))
            requestMeasurement(req)?.bind(undefined, {
              userId,
              sessionId: s.key,
              destination: s.destination,
            });
          return 'refused' in s
            ? textResult(s.refused, true)
            : textResult(
                JSON.stringify({
                  session: s.key,
                  ttlSeconds: longSessions().ttlMs / 1000,
                  destination: s.destination,
                  agentsCollectionId: s.agentsCollectionId,
                }),
              );
        },
      )(
        z
          .object({
            destination: z.string().optional(),
            agentsCollectionId: z.string().optional(),
            session: z.string().optional(),
            ...settingsSchema,
          })
          .parse(args),
      ),
  );
  server.registerTool(
    'session_close',
    {
      description:
        'Close a session and release its ABAP connection and conversation.',
      inputSchema: { session: z.string() },
    },
    measuredAgentCallback(
      req,
      userId,
      'session_close',
      async ({
        session,
      }: {
        session: string;
      }): Promise<{
        isError?: boolean | undefined;
        content: { type: 'text'; text: string }[];
      }> => {
        let s: LongSession | undefined;
        try {
          s = await resolveSession(userId, session);
        } catch (err) {
          if (err instanceof SessionLimitError)
            return textResult('SESSION_LIMIT', true);
          throw err;
        }
        if (!s) return textResult('SESSION_NOT_FOUND', true);
        try {
          await longSessions().close(userId, session, 'explicit');
        } catch (err) {
          log.warn('session close cleanup failed', { error: String(err) });
        }
        return textResult(JSON.stringify({ closed: true }));
      },
    ),
  );

  // --- execute_step -------------------------------------------------------
  server.registerTool(
    'execute_step',
    {
      description: EXECUTE_STEP_DESCRIPTION,
      inputSchema: executeStepSchema,
    },
    // `extra.signal` is aborted by the SDK when the transport closes; it lets a
    // step still queued at the door leave, and reaches nothing after admission.
    async (
      args: {
        session?: string;
        destination?: string;
        task: string;
        worker?: string;
        model?: string;
      },
      extra,
    ) => executeStep(req, { userId, exposition }, args, extra.signal),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless transport
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });
  await server.connect(transport);

  const cleanup = async () => {
    try {
      await transport.close();
    } catch (err) {
      log.warn('transport close failed', { error: String(err) });
    }
  };

  return { transport, cleanup };
}
