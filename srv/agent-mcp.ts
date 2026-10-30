import type { TokenUsage } from '@mcp-abap-adt/llm-agent';
import { requestStart } from './lib/request-start';
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
 *   - `execute_step` — delegate ONE concrete step to the SmartAgent executor on
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
import { getAvailableDestinations } from './lib/btp-destinations';
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
import { renderNotice } from './lib/notify-policy';
import type { DumpScope } from './lib/principal';

import { safeStop } from './lib/request-connection';
import {
  resolveRequestSystem,
  runWithRequestSystem,
} from './lib/request-system-context';
import { getReviewSignals } from './lib/review-scope';
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
  takeRevivalNotice,
} from './lib/session-lifecycle';
import { recordTurn } from './lib/session-turns';
import { evaluateGated } from './lib/step-reviewer';
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
import {
  getRequestHistory,
  runWithSessionId,
  runWithToolGateBypass,
} from './request-session';
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

/**
 * The contract. Read by the connecting MCP client (the planner/controller) the
 * moment it lists tools — this is what makes the role split self-documenting.
 */
const EXECUTE_STEP_DESCRIPTION = [
  'Delegate ONE step to the ABAP/SAP executor agent — describe the OUTCOME you want, and get its result.',
  '',
  'You say WHAT, the executor decides HOW. State the goal in plain business/domain terms. Do NOT prescribe the approach — do not name SAP transactions, GUI steps, MCP tools, function modules, or endpoints. Your theoretical knowledge of HOW something is usually done in SAP (e.g. "run ST22", "use SE11") is very likely WRONG here: the executor works through ADT and picks the right tool itself — telling it HOW only pushes it down a wrong path. Name the subject/outcome (the WHAT — e.g. "the latest short dumps", "table VBAK’s definition"), never the method (the HOW). If it cannot do something, it will tell you.',
  '',
  'Roles. The agent is a capable ABAP executor: it knows the system and selects the right MCP tools by analysing your request, but it does NOT plan. It continues the conversation and ABAP connection (debugger, locks) when given a session. YOU are the planner and controller.',
  '',
  'Two kinds of knowledge — keep them apart. GENERAL ABAP knowledge (the language, RAP, CDS, DDIC, the patterns) is yours to bring: if your client supports skills, load `sap-abap` from the `sap-skills` marketplace (invoke it as `sap-abap:sap-abap`) — that exact one, the marketplace ships ~33 similarly named SAP plugins (`sap-abap-cds`, `sap-sqlscript`, `sap-cap-capire` …) which are not it. CONCRETE knowledge about THIS system — what actually exists in it, how it really behaves, which tool reaches it — belongs to the executor, not to you. So use the skill to decide WHAT to build and to write any source you hand over; never use it to prescribe HOW the executor should reach the system.',
  '',
  'ONE object per step — keep every step MINIMAL. Keep one object per step, including when several steps share a session. NEVER batch several objects into a single step: a long step can exceed the client timeout, and a step cut mid-flight leaves objects created-but-INACTIVE and LOCKED by the orphaned session — which then blocks every later attempt to activate them.',
  '',
  'Parallel is allowed — sequencing is only for real dependencies. Steps that do not depend on each other’s result MAY be dispatched in parallel; only a step that needs a previous step’s outcome waits for it. Do not serialise work that has no dependency between its parts.',
  '',
  'Step granularity — always CREATE without activating, ACTIVATE in a separate step. Creating and activating are separate concerns, and combining them in one step is unreliable: a create-and-activate in a single call leaves the ABAP edit-session open when it activates, so the object can be left INACTIVE and reporting "currently being edited" — do NOT ask for "create and activate" in one step. For EVERY object: (1) create it WITHOUT activating (independent objects — domains, data elements, tables — may be created in parallel steps); (2) then ACTIVATE it in a SEPARATE step. Independent objects can each be activated in their own step. Mutually dependent objects (e.g. CDS views linked by composition, a projection view with its behavior definition and implementation) must be created first (each in its own step, without activating) and then activated TOGETHER in ONE shared activation step once all of them exist. Group activation applies only to genuinely co-dependent objects; the create-then-activate split applies to everything.',
  '',
  'Example — building a RAP business object, one object per step in dependency order, always create-without-activate then activate separately: (1) create each domain (own step, parallel) then activate each; (2) create each data element (parallel) then activate, after the domains are active; (3) create then activate each table/structure; (4) create then activate each CDS interface view; (5) create the CDS projection view, its behavior definition and its behavior implementation — each in its OWN step, parallel, WITHOUT activating — then ONE step that activates all three together (mutually dependent, consistent only as a unit); (6) service definition (create, then activate); (7) service binding. Minimal steps throughout; only the mutually dependent set shares an activation step, but no object is created-and-activated in the same step.',
  '',
  "Verify after every step — do NOT trust a step's reply alone. Creating and activating ABAP objects can take time and may not finish (or may fail) even when the step returned text. So after each step run SEPARATE verification step(s) that check the state that step was SUPPOSED to reach: after a CREATE step (which does NOT activate), check the object EXISTS — inactive is the CORRECT expected state there, so never poll it for ACTIVE; after an ACTIVATE step, check the object (or the whole co-dependent set) is ACTIVE. Give it a little time first, then re-check a FEW times (poll) until you confirm the expected state, or you get an error. Only move on once the current step is verified in its expected state. On a confirmed error, analyse it and REACT — fix and retry, change the plan, or ask the user what to do — do not push on as if it succeeded.",
  '',
  'How to use:',
  '- Plan: split the goal into MINIMAL steps that each express ONE concrete outcome for ONE object; one call per step. Mark which steps are independent (dispatch those in parallel) and which must wait for another step’s result. Where a set of objects only becomes consistent as a unit, plan their creates as separate parallel steps and ONE shared activation step after all of them finish. Keep each step about WHAT, not HOW.',
  '- Pick the system: `destination` is OPTIONAL. If THIS MCP server is already bound to one system (a default `X-SAP-Destination` is configured for the connection), omit it — every step runs there. Pass `destination` only when ONE connection can reach several systems and you want to choose per call (see `list_destinations`). To compare two systems, the usual setup is two MCP servers (one per system) — route by server, not by this argument.',
  '- ANALYSE each response before the next step; the executor can err or hallucinate. An impossible request answered confidently is an error or a problem, not success — surface it; do not accept the hallucination.',
  '- CORRECT the plan from what the executor actually returns; do not assume success just because text came back.',
  '',
  'For multi-step work call `session_open` first, pass its key as `session` in every call, and call `session_close` when done. With `session`, execute_step continues the conversation and ABAP connection (debugger, locks). Calls of one session run one after another. Without `session`, each call is independent as before.',
  '',
  'Every result with known usage ends with [usage] prompt=<n> completion=<n> total=<n> time=<seconds>s (one decimal) and includes structuredContent.usage. structuredContent.result holds the reply text. EMPTY_RESULT means the executor replied nothing. When a reviewer runs, its tokens are separate in structuredContent.usage_reviewer and reviewer=<n> in the footer. Use it to track and budget what the executor spends across your plan.',
].join('\n');

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
  input: { session?: string; destination?: string; task: string },
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
      sessionId: input.session ?? '',
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
>(
  req: Request,
  userId: string,
  tool: 'session_open' | 'session_close' | 'list_destinations' | RagMcpTool,
  run: (args: T) => Promise<ReturnType<typeof textResult>>,
): (args: T) => Promise<ReturnType<typeof textResult>> {
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('request') && !runtime.enabled('session')))
    return run;
  return (
    args: T,
  ): Promise<{
    isError?: boolean | undefined;
    content: { type: 'text'; text: string }[];
  }> =>
    measureAgentTool(
      req,
      { userId, sessionId: args.session ?? '', destination: args.destination },
      tool,
      (): Promise<{
        isError?: boolean | undefined;
        content: { type: 'text'; text: string }[];
      }> => run(args),
    );
}

async function measureAgentTool(
  req: Request,
  session: UsageSession,
  tool:
    | 'execute_step'
    | 'session_open'
    | 'session_close'
    | 'list_destinations'
    | RagMcpTool,
  run: () => Promise<ReturnType<typeof textResult>>,
  signal?: AbortSignal,
) {
  const measurement = measureRequest(
    req,
    req.res,
    session,
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
  args: { session?: string; destination?: string; task: string },
  callerSignal?: AbortSignal,
) {
  if (args.session === undefined)
    return executeStepRun(req, caller, args, callerSignal);
  try {
    const s = await resolveSession(caller.userId, args.session);
    if (!s) return textResult('SESSION_NOT_FOUND', true);
    const result = await longSessions().run(s, async () => {
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
    });
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
  { destination, task }: { destination?: string; task: string },
  callerSignal?: AbortSignal,
  longSession?: LongSession,
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
  // below, which always runs safeStop(connection) once the step completes.
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

    handle = await getSmartAgent(undefined, targetDestination);
    const agentHandle = handle as ExecutorAgentHandle;

    // Ephemeral session per call → the executor loads/saves no history.
    // Doubles as the per-trace telemetry id (Verified fact 10): unique per
    // call, threaded below as `trace.traceId`, dropped in the `finally`.
    traceId = requestMeasurement(req)?.traceId ?? `agent-step-${randomUUID()}`;
    const sessionId = longSession?.key ?? traceId;

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
        sessionId: sessionId ?? traceId,
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
      sessionId,
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
    let reviewerUsage: TokenUsage | undefined;
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
                const result = await runWithToolGateBypass(() =>
                  (agentHandle.executor ?? agentHandle.agent).process(
                    [...history, { role: 'user', content: task }],
                    opts,
                  ),
                );
                if (result.ok && agentHandle.executor) {
                  const verdict = await evaluateGated({
                    usage: opts.usage,
                    content: result.value.content ?? '',
                    records: agentHandle.recMcp.getToolRecords(traceId),
                    ...getReviewSignals(),
                    llm: agentHandle.criticLlm,
                    request: task,
                    task,
                    history: getRequestHistory(),
                  });
                  reviewerUsage = verdict.usage;
                  if (!verdict.ok) {
                    return {
                      ...result,
                      value: {
                        ...result.value,
                        content:
                          (result.value.content ?? '') + renderNotice(verdict),
                      },
                    };
                  }
                }
                return result;
              },
              dumpScope,
              exposition,
            ),
          history,
          userId,
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
      recordTurn(sessionId, userId, lastUser, rawContent);
    }
    if (longSession && takeRevivalNotice(longSession)) notice = 'revived';
    const durationMs = Date.now() - stepStartedAt;
    const tokens = tokenUsageToWire(r.value.usage);
    const wireUsage = tokens
      ? { ...tokens, duration_ms: durationMs }
      : undefined;
    const wireReviewerUsage = tokenUsageToWire(reviewerUsage);
    const emptyResult = !/\S/.test(rawContent);
    const reply = emptyResult
      ? `EMPTY_RESULT on destination "${targetDestination}": The executor finished without a reply. The system state of the step is unknown and must be verified by a separate read step.${r.value.iterations !== undefined ? ` iterations=${r.value.iterations}` : ''}${r.value.toolCallCount !== undefined ? ` toolCallCount=${r.value.toolCallCount}` : ''}${r.value.stopReason !== undefined ? ` stopReason=${r.value.stopReason}` : ''}`
      : rawContent;
    const content = notice ? `${notice}\n${reply}` : reply;
    return {
      ...textResult(
        wireUsage || wireReviewerUsage
          ? `${content}\n[usage]${wireUsage ? ` prompt=${wireUsage.prompt_tokens} completion=${wireUsage.completion_tokens} total=${wireUsage.total_tokens}` : ''}${wireReviewerUsage ? ` reviewer=${wireReviewerUsage.total_tokens}` : ''} time=${(durationMs / 1000).toFixed(1)}s`
          : content,
        emptyResult,
      ),
      ...(wireUsage || wireReviewerUsage
        ? {
            structuredContent: {
              result: content,
              ...(wireUsage ? { usage: wireUsage } : {}),
              ...(wireReviewerUsage
                ? { usage_reviewer: wireReviewerUsage }
                : {}),
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
    // Wait for the calls this step started, then end the ADT session, then
    // release — the slot last, and the semaphore with it. Refused/closed
    // admission never ran the pipeline, so there is no per-trace bucket to
    // free — dropRequest only makes sense once the pipeline actually ran.
    await pipeline?.drain();
    if (longSession) await releaseRequestConnection(connection, longSession);
    else await safeStop(connection);
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

  // --- list_destinations --------------------------------------------------
  server.registerTool(
    'list_destinations',
    {
      description:
        'List the SAP systems (destinations) this instance can reach. Pick one and pass its `name` as the `destination` argument of execute_step. Reachability is confirmed when you actually run a step — if a destination is down the executor reports it.',
      inputSchema: {},
    },
    measuredAgentCallback(req, userId, 'list_destinations', async () => {
      const dests = await getAvailableDestinations();
      const list = dests.map(
        (d: Awaited<ReturnType<typeof getAvailableDestinations>>[number]) => ({
          name: d.name,
          proxyType: d.proxyType,
          authentication: d.authentication,
        }),
      );
      return textResult(JSON.stringify({ destinations: list }, null, 2));
    }),
  );

  server.registerTool(
    'session_open',
    {
      description:
        'Open a session for multi-step work sharing conversation and ABAP connection.',
      inputSchema: { destination: z.string().optional() },
    },
    measuredAgentCallback(
      req,
      userId,
      'session_open',
      async ({
        destination,
      }: {
        destination?: string;
      }): Promise<{
        isError?: boolean | undefined;
        content: { type: 'text'; text: string }[];
      }> => {
        const headerDestination = req.headers['x-sap-destination'];
        const target =
          destination?.trim() ||
          (typeof headerDestination === 'string'
            ? headerDestination.trim()
            : undefined);
        const s = await openSession(userId, target);
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
              }),
            );
      },
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
      inputSchema: {
        session: z
          .string()
          .optional()
          .describe('Session key returned by session_open.'),
        destination: z
          .string()
          .optional()
          .describe(
            'OPTIONAL. The SAP system to run this step against (a destination name from list_destinations). Omit it when this MCP server is already bound to a system via a default `X-SAP-Destination` header; only pass it when one connection can reach several systems.',
          ),
        task: z
          .string()
          .describe(
            'What outcome you want (the WHAT, in plain domain terms — not the HOW).',
          ),
      },
    },
    // `extra.signal` is aborted by the SDK when the transport closes; it lets a
    // step still queued at the door leave, and reaches nothing after admission.
    async (
      args: { session?: string; destination?: string; task: string },
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
