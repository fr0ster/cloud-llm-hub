import { isDeepStrictEqual } from 'node:util';
import {
  contextExceededError,
  MODEL_CONTEXT_EXCEEDED,
  normalizeAndValidateExternalTools,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  anthropicEventWithUsage,
  anthropicUsageToWire,
} from './lib/anthropic-usage';
import { type ChatStream, chatStream, streamDialogue } from './lib/chat-stream';
import {
  clientHistoryMessages,
  hasPendingClientTools,
} from './lib/client-history';
import {
  registerClientTools,
  runWithClientTools,
} from './lib/client-tool-trust';
import { collectionRetrieval } from './lib/collection-retrieval';
import { lookupDialogue } from './lib/dialogue-sessions';
import { getExecutionLimits } from './lib/execution-limits';
import {
  captureTokenUsage,
  clientRunFailure,
  contextExceededMessage,
  failureMessage,
  mergeStreamUsage,
  runContextOverflow,
} from './lib/llm-failure';
import { awaitModelCatalog } from './lib/model-catalog';
import { ignoredModelHeader } from './lib/model-policy';
import {
  logRunFailure,
  pipelineFailureLogger,
} from './lib/pipeline-failure-logging';
import { bindCaller, callOptionsFor } from './lib/rag-caller';
import { buildRagToolSchemas, isRagTool } from './lib/rag-tool-catalogue';
import { requestStart } from './lib/request-start';
import {
  applyRoleModelHeaders,
  chatRequestModel,
} from './lib/role-model-headers';
import { getRoleModels } from './lib/role-model-settings';
import {
  chatResponseModel,
  currentRoleModel,
  withRoleModels,
} from './lib/role-models-scope';
import { runWithRequestLlms } from './lib/session-llms';
import {
  assertToolSearchHealthy,
  ToolSearchUnavailableError,
  toolSearchFailure,
} from './lib/tool-search-health';
import {
  measureRequest,
  requestMeasurement,
} from './lib/usage/request-records';
import { usageRuntime } from './lib/usage/runtime';
/**
 * Anthropic Messages API handler for SmartAgent.
 *
 * Endpoint:
 * - POST /v1/messages — Anthropic Messages API (streaming SSE + non-streaming JSON)
 *
 * Delegates all format translation to AnthropicApiAdapter from @mcp-abap-adt/llm-agent.
 * The adapter handles:
 * - Request normalization (Anthropic → internal Message format)
 * - Response formatting (internal → Anthropic response)
 * - Stream transformation (internal chunks → Anthropic SSE events)
 */

import { randomUUID } from 'node:crypto';
import {
  AdapterValidationError,
  AnthropicApiAdapter,
  type ApiSseEvent,
  type NormalizedRequest,
  type TokenUsage,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig, isAiCoreConfigured } from './agent-config';
import {
  closeDestination,
  getCurrentDestination,
  getCurrentModel,
  getSmartAgent,
  isAgentReady,
  isDestinationClosed,
  isProvidersReady,
  retryAfterForDestination,
  runWithRequestConnection,
} from './agent-manager';
import { detachedSink, streamWriter } from './lib/detached-sink';
import { dialogueChat, failedDialogueUsage } from './lib/dialogue-chat';
import { describeCaller } from './lib/exposition';
import { admitPipeline, type PipelineSession } from './lib/gatekeeper';
import { recordDestinationRefusal } from './lib/gatekeeper-metrics';
import { type LongSession, longSessions } from './lib/long-session';
import { describeCause, isOutageError } from './lib/mcp-outage';
import { establishRequestConnection } from './lib/request-connection';
import {
  resolveRequestSystem,
  runWithRequestSystem,
} from './lib/request-system-context';
import {
  acquireSessionConnection,
  type LongSessionRequest,
  releaseRequestConnection,
} from './lib/session-connection';
import {
  recordTurn,
  rememberClientToolTurn,
  resolveClientHistoryTurn,
  waitForSessionTurns,
} from './lib/session-turns';
import {
  anthropicDoorRefusal,
  anthropicErrorPayload,
  anthropicSessionClosed,
  anthropicSessionRunRefusal,
  anthropicUnverifiedWrite,
  destinationClosedText,
  retryAfterHeader,
  statusForError,
  throttleMessage,
  throttleOf,
  unverifiedWriteFor,
} from './lib/throttle-surfacing';
import { hasUnansweredSapWrite } from './lib/tool-journal';
import { isUserMcpName } from './lib/user-mcp-names';
import { runWithSessionId } from './request-session';
import { sessionIdOf, type WithSession } from './session-id';

/** Singleton adapter instance (stateless — safe to share) */
const adapter = new AnthropicApiAdapter();
interface AnthropicRunFailure {
  code: string;
  status: number;
  message: string;
  type: string;
}

function anthropicRunError({ code, message, type }: AnthropicRunFailure) {
  return { type: 'error' as const, error: { type, message, code } };
}

/**
 * POST /v1/messages
 *
 * Accepts Anthropic Messages API request, delegates to SmartAgent.process() or
 * SmartAgent.streamProcess() depending on `stream` flag.
 */
export function handleAnthropicMessages(
  req: Request,
  res: Response,
): Promise<void> {
  return runWithClientTools(() =>
    runWithRequestLlms((req as LongSessionRequest).longSession, () => {
      requestStart(req);
      const runtime = usageRuntime();
      if (
        !runtime ||
        (!runtime.enabled('request') && !runtime.enabled('session'))
      )
        return handleAnthropicMessagesMeasured(req, res);
      return handleAnthropicMessagesWithUsage(req, res);
    }),
  );
}

async function handleAnthropicMessagesWithUsage(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = sessionIdOf(req);
  if (!sessionId) return handleAnthropicMessagesMeasured(req, res);
  const body: { stream?: boolean } | undefined = req.body;
  const measurement = measureRequest(
    req,
    res,
    {
      userId: cds.context?.user?.id ?? 'anonymous',
      sessionId,
    },
    'anthropic',
    body?.stream === true,
  );
  try {
    await handleAnthropicMessagesMeasured(req, res);
  } catch (error) {
    measurement?.end('error');
    throw error;
  } finally {
    measurement?.finish();
  }
}

async function handleAnthropicMessagesMeasured(
  req: Request,
  res: Response,
): Promise<void> {
  const pendingCatalog = awaitModelCatalog();
  if (pendingCatalog) await pendingCatalog;
  if (
    !applyRoleModelHeaders(
      req,
      res,
      cds.context?.user?.id ?? 'anonymous',
      cds.context?.user?.is('MCP_Admin') === true,
    )
  )
    return;
  const userId = cds.context?.user?.id ?? 'anonymous';
  const session = (req as LongSessionRequest).longSession;
  const own = session?.userId === userId ? session : undefined;
  return withRoleModels(
    own ? getRoleModels(userId, own.key) : {},
    () => handleAnthropicMessagesScoped(req, res),
    own ? getExecutionLimits(userId, own.key) : {},
  );
}

async function handleAnthropicMessagesScoped(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (toolSearchFailure()) await assertToolSearchHealthy();
  } catch (error) {
    res.status(503).json({
      type: 'error',
      error: {
        message:
          error instanceof ToolSearchUnavailableError
            ? error.message
            : 'Tool search unavailable',
        type: 'api_error',
        code: 'tool_search_unavailable',
      },
    });
    return;
  }
  // Block requests until the providers are built and the agent is available
  if (!isProvidersReady() || !isAgentReady()) {
    const aiCoreAvailable = isAiCoreConfigured();
    const status = aiCoreAvailable ? 503 : 503;
    res.status(status).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: aiCoreAvailable
          ? 'SmartAgent is initializing (MCP connect + tool vectorization). Please retry in a moment.'
          : 'Agent endpoints require SAP AI Core service binding. Enable cloud-llm-hub-ai-core resource in your .mtaext deployment descriptor.',
      },
    });
    return;
  }

  // Normalize request using adapter (validates and converts Anthropic → internal format)
  let normalized: NormalizedRequest;
  try {
    const parsed = z
      .object({ session: z.string().optional() })
      .catchall(z.json())
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid JSON body: session must be a string',
        },
      });
      return;
    }
    const { session: _session, ...body } = parsed.data;
    normalized = adapter.normalizeRequest(body);
    if (normalized.options) {
      delete normalized.options.temperature;
      delete normalized.options.topP;
      delete normalized.options.maxTokens;
    }
  } catch (err) {
    if (err instanceof AdapterValidationError) {
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: err.message },
      });
      return;
    }
    throw err;
  }

  const requestModel = chatRequestModel(
    typeof normalized.context.protocol.model === 'string'
      ? normalized.context.protocol.model
      : undefined,
    cds.context?.user?.is('MCP_Admin') === true,
  );
  if (requestModel.ignored) {
    res.setHeader(
      'x-clh-model-ignored',
      ignoredModelHeader(requestModel.ignored),
    );
    cds
      .log('anthropic-handler')
      .warn('Ignoring request model outside allowlist', {
        model: requestModel.ignored,
      });
  }

  const removed = new Map([
    [
      'rag_list',
      'Use collections_list, collection_records or rag_read with an exact id.',
    ],
    ['rag_add', 'Use collection_create when needed, then record_add.'],
    [
      'rag_correct',
      'Use record_update with record and text (formerly newText).',
    ],
    [
      'rag_deprecate',
      'Use record_set_enabled with enabled: false for retirement, or record_delete for permanent removal.',
    ],
  ]);
  const reject = (message: string): void => {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    });
  };
  normalized.options ??= {};
  const consumerTools: NonNullable<typeof normalized.options.externalTools> =
    [];
  for (const entry of normalized.options.externalTools ?? []) {
    const parsed = z.object({ name: z.string() }).safeParse(entry);
    const name = parsed.success ? parsed.data.name : '';
    if (isUserMcpName(name)) {
      reject('The user__ namespace is reserved for registered session tools.');
      return;
    }
    if (removed.has(name)) {
      reject(`${name} was removed. ${removed.get(name)}`);
      return;
    }
    if (isRagTool(name)) {
      const tool = buildRagToolSchemas().find(
        (candidate) => candidate.function.name === name,
      )?.function;
      if (
        !tool ||
        !isDeepStrictEqual(entry, {
          name,
          description: tool.description,
          input_schema: tool.parameters,
        })
      ) {
        reject(
          `Conflicting definition for host RAG tool ${name}. Use the canonical definition or omit it.`,
        );
        return;
      }
    } else consumerTools.push(entry);
  }
  normalized.options.externalTools = consumerTools;
  registerClientTools(normalizeAndValidateExternalTools(consumerTools).tools);
  const choice = z
    .object({ tool_choice: z.object({ name: z.string() }) })
    .safeParse(req.body);
  if (choice.success && removed.has(choice.data.tool_choice.name)) {
    reject(
      `${choice.data.tool_choice.name} was removed. ${removed.get(choice.data.tool_choice.name)}`,
    );
    return;
  }
  const hostIds = new Set<string>();
  for (const message of normalized.messages) {
    for (const call of message.tool_calls ?? []) {
      if (message.role === 'assistant' && removed.has(call.function.name)) {
        reject(
          `${call.function.name} was removed. ${removed.get(call.function.name)}`,
        );
        return;
      }
      if (isRagTool(call.function.name) || removed.has(call.function.name))
        hostIds.add(call.id);
    }
  }
  if (
    normalized.messages.some(
      (message) =>
        message.role === 'tool' && hostIds.has(message.tool_call_id ?? ''),
    )
  ) {
    reject('External results cannot claim host RAG tool call identities.');
    return;
  }

  // A long session serves its requests one at a time, through the connection
  // it holds; without one the request stands alone, as it always has.
  const authenticatedCaller = {
    userId: cds.context?.user?.id ?? 'anonymous',
    admin: cds.context?.user?.is?.('MCP_Admin') ?? false,
    caller: describeCaller(cds.context?.user),
  };
  const s = (req as LongSessionRequest).longSession;
  const measurement = requestMeasurement(req);
  measurement?.setStream(normalized.stream);
  const early =
    normalized.stream &&
    s &&
    (req.headers['x-sap-destination'] ||
      s.destination ||
      getCurrentDestination(
        cds.context?.user?.id ?? 'anonymous',
        sessionIdOf(req),
      )) &&
    getAgentConfig().agent.chatCoordinator === 'dialogue'
      ? chatStream(res, 'anthropic', s)
      : undefined;
  const capturedFailures = new WeakMap<object, AnthropicRunFailure>();
  try {
    const continuation = s
      ? await longSessions().run(
          s,
          () =>
            serveMessages(
              req,
              res,
              normalized,
              authenticatedCaller,
              capturedFailures,
              s,
              early,
            ),
          () => early?.ensureStream(),
        )
      : await serveMessages(
          req,
          res,
          normalized,
          authenticatedCaller,
          capturedFailures,
          undefined,
          early,
        );
    if (typeof continuation === 'function') await continuation();
    else if (continuation) {
      const refusal = anthropicSessionRunRefusal(continuation.refused);
      if (early?.opened) early.error(refusal.body);
      else {
        res.status(refusal.status).json(refusal.body);
      }
    }
  } catch (error) {
    measurement?.end('error');
    const capturedFailure =
      typeof error === 'object' && error !== null
        ? capturedFailures.get(error)
        : undefined;
    if (capturedFailure || contextExceededError(error)) {
      const payload = capturedFailure
        ? anthropicRunError(capturedFailure)
        : anthropicUnverifiedWrite(
            contextExceededMessage(false),
            'invalid_request_error',
          );
      if (early?.opened) early.error(payload);
      else if (res.headersSent)
        res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      else res.status(capturedFailure?.status ?? 400).json(payload);
      return;
    }
    if (!early?.opened) throw error;
    early.error({
      type: 'error',
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'api_error',
      },
    });
  }
}

/** The request itself, once the body is valid; `s` is the long session it runs in. */
async function serveMessages(
  req: Request,
  res: Response,
  normalized: NormalizedRequest,
  authenticatedCaller: {
    userId: string;
    admin: boolean;
    caller: ReturnType<typeof describeCaller>;
  },
  capturedFailures: WeakMap<object, AnthropicRunFailure>,
  s?: LongSession,
  early?: ChatStream,
): Promise<(() => Promise<void>) | void> {
  const log = cds.log('anthropic-handler');
  const dialogueMode = getAgentConfig().agent.chatCoordinator === 'dialogue';
  const { stream, options, context } = normalized;
  const resolvedModel = chatRequestModel(
    typeof context.protocol.model === 'string'
      ? context.protocol.model
      : undefined,
    cds.context?.user?.is('MCP_Admin') === true,
  );
  let messages = clientHistoryMessages(
    normalized.messages,
    getAgentConfig().agent.clientHistory,
  );

  log.info('Messages request', {
    stream,
    messageCount: messages.length,
    roles: messages.map((m) => m.role).join(','),
  });

  // Establish the caller's per-request SAP connection BEFORE running the agent.
  // Same fail-closed policy as /v1/chat/completions: no default destination
  // service user — on-premise/NoAuthentication destinations require the caller's
  // x-sap-login/x-sap-password; cloud destinations use the resolved auth (JWT).
  // Without a per-request connection, ABAP tool calls throw in agent-manager.
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;
  const traceId = requestMeasurement(req)?.traceId ?? randomUUID();
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(403).json({
      error: {
        message: 'SESSION_REQUIRED: session middleware must issue a session',
      },
    });
    return;
  }
  const userId = authenticatedCaller.userId;
  const boundCaller = await bindCaller(
    sessionId,
    userId,
    cds.context?.user?.is('MCP_Admin') === true,
  );
  if (!boundCaller.ok) {
    res.status(403).json({ error: { message: boundCaller.error.message } });
    return;
  }
  const ragIdentity = {
    admin: authenticatedCaller.admin,
    channel: 'anthropic' as const,
    userMcpSession: s,
  };
  const destination =
    requestedDestination ||
    s?.destination ||
    getCurrentDestination(userId, sessionId);

  const useDialogue = dialogueMode && !!s && !!destination;
  if (dialogueMode && !useDialogue)
    res.setHeader('x-clh-coordinator', 'adaptive');
  if (useDialogue && s) {
    const handle = await lookupDialogue(userId, s.key);
    try {
      await handle?.factory.assertPrincipal(req.headers, destination);
    } catch (error) {
      if (early?.opened) {
        early.error({
          error: {
            type: 'conflict',
            code: 'DIALOGUE_PRINCIPAL_FIXED',
            message: (error as Error).message,
          },
        });
        return;
      }
      res.status(409).json({
        error: {
          type: 'conflict',
          code: 'DIALOGUE_PRINCIPAL_FIXED',
          message: (error as Error).message,
        },
      });
      return;
    }
  }
  if (
    useDialogue &&
    s?.destination !== undefined &&
    s.destination !== destination
  ) {
    if (early?.opened) {
      early.error({
        error: {
          type: 'conflict',
          code: 'DIALOGUE_DESTINATION_FIXED',
          message:
            'The dialogue destination is fixed for the lifetime of the session',
        },
      });
      return;
    }
    res.status(409).json({
      error: {
        type: 'conflict',
        code: 'DIALOGUE_DESTINATION_FIXED',
        message:
          'The dialogue destination is fixed for the lifetime of the session',
      },
    });
    return;
  }
  // A closed destination refuses before anything is built for it. Connecting
  // first would CSRF-fetch against the system that is down and answer
  // `401 sap_credentials_failed` from inside `establishRequestConnection`, so
  // this 503 with its `Retry-After` would only ever be reached once SAP was
  // back. It also comes before `getSmartAgent`, which throws its own
  // `destination_unreachable` 503 with no `Retry-After`. No connection exists
  // yet, so there is nothing to `safeStop`.
  if (isDestinationClosed(destination)) {
    recordDestinationRefusal(destination);
    const seconds = retryAfterForDestination(destination);
    if (early?.opened) {
      early.error({
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destination),
        },
      });
      return;
    }
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destination),
        },
      }),
    );
    return;
  }

  early?.ensureStream();

  let requestConnection:
    | import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection
    | undefined;
  let requestDumpScope: import('./lib/principal').DumpScope | undefined;
  if (destination && !useDialogue) {
    const established = s
      ? await acquireSessionConnection(s, req, res, destination)
      : await establishRequestConnection(req, res, destination);
    if (established.handled) return;
    requestConnection = established.connection;
    requestDumpScope = established.dumpScope;
  }

  // A client disconnect ends nothing. Tearing the connection down on `close` is
  // the recorded cause of the orphaned ADT locks in SM12: nobody is waiting for
  // the answer, and SAP is waiting for the rest of the chain. So the sink is
  // detached — nothing written afterwards reaches the socket or fails the run —
  // and a caller still queued is removed from the queue.
  const out = detachedSink(res);
  const callerLeft = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    log.info('Caller disconnected; the session runs to its end', { sessionId });
    out.detach();
    callerLeft.abort(new Error('caller disconnected'));
  });

  // Get the SmartAgent handle for the SAME destination the connection was
  // established for (resolved above from x-sap-destination / session). Passing
  // it explicitly ensures the agent's MCP tools match the connection — without
  // it, getSmartAgent would fall to the configured default destination.
  let responseModel: string;
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    await waitForSessionTurns(sessionId, callerLeft.signal);
    responseModel = chatResponseModel(resolvedModel.model, getCurrentModel());
    handle = await getSmartAgent(
      currentRoleModel('coordinator') ?? resolvedModel.model,
      destination,
    );
  } catch (err) {
    await releaseRequestConnection(requestConnection, s);
    if (contextExceededError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (early?.opened) {
      early.error({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Agent initialization failed: ${message}`,
        },
      });
      return;
    }
    log.error('Failed to initialize SmartAgent', { error: message });
    res.status(503).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: `Agent initialization failed: ${message}`,
      },
    });
    return;
  }

  // Unique per-request traceId — required for the recording logger's
  // per-trace bucketing and the finalizer's `getSummary(traceId)` (Verified
  // fact 10). Merge into any `trace` the adapter already normalized from the
  // request rather than clobbering it.

  // The caller's permissions. This channel previously resolved none at all —
  // no role filtering on which tools were offered, and nothing to authorize a
  // tool call against. Both are fixed here from one value, so they agree.
  const caller = authenticatedCaller.caller;
  log.info('MCP caller', caller);
  const callerExposition = caller.exposition;

  context.protocol.model = responseModel;

  let pipeline: PipelineSession;
  try {
    const admission = await admitPipeline(
      userId,
      sessionId,
      callerLeft.signal,
      {
        presented:
          sessionId !== undefined &&
          (req as Request & WithSession).sessionMinted === false,
      },
    );
    if ('refused' in admission) {
      requestMeasurement(req)?.end('limit');
      await releaseRequestConnection(requestConnection, s);
      const refusal = anthropicDoorRefusal(admission.refused);
      if (early?.opened) early.error(refusal.body);
      else out.json(refusal.status, refusal.body);
      return;
    }
    if ('closed' in admission) {
      await releaseRequestConnection(requestConnection, s);
      const closed = anthropicSessionClosed();
      if (early?.opened) early.error(closed.body);
      else out.json(closed.status, closed.body);
      return;
    }
    pipeline = admission.admitted;
    requestMeasurement(req)?.admitted();
  } catch (error) {
    await releaseRequestConnection(requestConnection, s);
    if (early?.opened && !callerLeft.signal.aborted) throw error;
    return;
  }

  const dialogue =
    useDialogue && s
      ? dialogueChat(req, userId, s, destination, res, req, resolvedModel.model)
      : undefined;
  const chatAgent = dialogue ?? handle.agent;
  const unansweredSapWrite = () =>
    dialogue?.hasUnansweredSapWrite() ??
    hasUnansweredSapWrite(handle.recMcp?.getToolRecords(traceId) ?? []);
  const pipelineFailures = pipelineFailureLogger(traceId);
  const typedFailure = <T>(
    error: T,
    mode: 'json' | 'stream' | 'dialogue' = stream ? 'stream' : 'json',
  ): AnthropicRunFailure | undefined => {
    const mapped = clientRunFailure(error, unansweredSapWrite());
    if (!mapped) return;
    let { code, status, message } = mapped;
    let type = 'api_error';
    if (message !== undefined) {
      type = 'invalid_request_error';
    } else if (mode === 'dialogue') {
      message = failureMessage(error);
    } else {
      const limit = throttleOf(error);
      const unverified = unverifiedWriteFor(handle, traceId, error);
      if (limit && mode === 'json') {
        const retryAfter = retryAfterHeader(error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        status = statusForError(error);
        type = 'overloaded_error';
        message = unverified
          ? `${unverified} ${throttleMessage(limit)}`
          : throttleMessage(limit);
      } else if (limit && unverified) {
        type = 'overloaded_error';
        message = `${unverified} ${throttleMessage(limit)}`;
      } else {
        message =
          unverified ??
          (mode === 'stream'
            ? failureMessage(error)
            : error instanceof Error
              ? error.message
              : String(error));
      }
    }
    const failure = { code, status, message, type };
    logRunFailure(log, error, failure, traceId);
    return failure;
  };

  const usage = usageRuntime()
    ?.forSession({
      sessionId,
      userId,
      destination: destination,
    })
    .with({ requestId: traceId, traceId });
  requestMeasurement(req)?.bind(usage);
  const agentOpts = {
    stream,
    ...options,
    requestStartedAt: requestStart(req),
    // After the spread: nothing in `options` may override the admission's signal.
    signal: pipeline.signal,
    ...callOptionsFor(boundCaller.value),
    ragFilter: {
      ...(options as { ragFilter?: Record<string, unknown> })?.ragFilter,
      exposition: callerExposition,
    },
    trace: { ...options?.trace, traceId },
    sessionLogger: { logStep: pipelineFailures.logStep },
    ...(usage ? { usage } : {}),
  };

  // Bind the per-request SAP connection for the whole agent run so MCP tool
  // calls inside the pipeline see it (ALS store survives the async hops), and
  // the caller's exposition so those tool calls can be authorized.
  //
  // The turns before the new user message ride along too: the coordinator
  // composes the executor's prompt as a single string, which the agent reads as
  // a lone message, so without this the conversation stops at the planner and
  // every request looks like a first one.
  const priorTurns = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages.slice(0, i);
    }
    return [];
  })();

  const runAgent = <T>(fn: () => Promise<T>): Promise<T> =>
    pipeline.run(() =>
      runWithSessionId(
        sessionId,
        () => {
          const connection = requestConnection;
          if (!connection) return fn();
          // Admitted, right before the pipeline: this run's responsible person
          // and master system, visible to it alone — `request-system-context.ts`.
          return runWithRequestSystem(resolveRequestSystem(req.headers), () =>
            runWithRequestConnection(
              connection,
              fn,
              requestDumpScope,
              callerExposition,
            ),
          );
        },
        priorTurns,
        userId,
        ragIdentity,
      ),
    );

  const collections = useDialogue
    ? undefined
    : collectionRetrieval(handle.agent);
  const spend = captureTokenUsage();
  try {
    const historySignal = pipeline.signal
      ? AbortSignal.any([pipeline.signal, callerLeft.signal])
      : callerLeft.signal;
    let historyTurn:
      | Awaited<ReturnType<typeof resolveClientHistoryTurn>>
      | undefined;
    try {
      await waitForSessionTurns(sessionId, historySignal);
      if (!useDialogue)
        historyTurn = await resolveClientHistoryTurn(
          boundCaller.value,
          messages,
          historySignal,
          s,
        );
      historySignal.throwIfAborted();
    } catch (error) {
      if (callerLeft.signal.aborted) return;
      throw error;
    }
    if (collections) {
      const retrieval = await spend.run(() =>
        collections.retrieve(
          req,
          messages,
          userId,
          sessionId,
          log,
          res.headersSent,
          agentOpts.usage,
        ),
      );
      if (retrieval.refusal) {
        if (early?.opened) {
          early.error({
            error: { type: 'api_error', message: retrieval.refusal.message },
          });
          return;
        }
        out.json(retrieval.refusal.status, {
          type: 'error',
          error: {
            type:
              retrieval.refusal.kind === 'conflict' ? 'conflict' : 'api_error',
            message: retrieval.refusal.message,
          },
        });
        return;
      }
      messages = retrieval.messages;
    }
    if (stream && dialogue && early) {
      return await streamDialogue({
        stream: early,
        protocol: 'anthropic',
        model: () =>
          chatResponseModel(
            resolvedModel.model,
            responseModel,
            s ? { userId, key: s.key } : undefined,
          ),
        context,
        agent: dialogue,
        source: dialogue.streamProcess(messages, agentOpts),
        run: runAgent,
        onError: (error) => {
          const failure = typedFailure(error, 'dialogue');
          if (failure?.status === 400) return anthropicRunError(failure);
          if (isOutageError(error))
            closeDestination(destination, describeCause(error));
          if (failure) return anthropicRunError(failure);
          return {
            type: 'error',
            error: {
              type: 'api_error',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        },
      });
    }

    // --- Streaming ---
    if (stream) {
      const writeStream = streamWriter(out, {});

      // Independent SSE keep-alive — see openai-handler for the rationale: the
      // DAG coordinator routes the executor's heartbeats to the session log
      // only (llm-agent #166), so a long tool loop would idle the connection
      // past the CF router / client timeout before the finalizer emits. SSE
      // comment lines are ignored by clients, harmless during active streaming.
      const KEEPALIVE_MS = 10_000;
      const keepAlive = setInterval(() => {
        writeStream(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      res.on('close', () => clearInterval(keepAlive));

      // `message_stop`, held back once a chunk has failed so that a notice can
      // still go before it: Anthropic clients, the Claude CLI among them, stop
      // reading at `message_stop`, and a notice after it reaches nobody.
      const measurement = requestMeasurement(req);
      let accumulatedContent = '';
      let streamSucceeded = false;
      let pendingClientTools = false;
      let deliveredContent = false;
      let explicitMessages = false;
      let heldStop: ApiSseEvent | undefined;
      let heldDelta: ApiSseEvent | undefined;
      let spentUsage: TokenUsage | undefined;
      const writeTerminalUsage = () => {
        const tokens = spend.usage(spentUsage);
        if (tokens?.models) log.info('Token usage by model', tokens.models);
        if (heldDelta) {
          const encoded = anthropicEventWithUsage(
            heldDelta,
            tokens,
            responseModel,
          );
          writeStream(`event: ${encoded.event}\ndata: ${encoded.data}\n\n`);
        } else if (tokens) {
          writeStream(
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: anthropicUsageToWire(tokens, responseModel) })}\n\n`,
          );
        }
      };
      try {
        // The adapter consumes failed chunks as a normal close. Hold its final
        // events until the model stream has closed and usage is complete.
        let streamError: unknown;
        await runAgent(() =>
          spend.run(async () => {
            const source = chatAgent.streamProcess(messages, agentOpts);
            const observed = (async function* () {
              for await (const chunk of source) {
                if (chunk.ok) {
                  if (chunk.value.reset) pendingClientTools = false;
                  pendingClientTools ||= hasPendingClientTools(chunk.value);
                }
                if (!chunk.ok && streamError === undefined) {
                  requestMeasurement(req)?.end('error');
                  if (runContextOverflow(chunk.error)) throw chunk.error;
                  streamError = chunk.error;
                }
                if (chunk.ok && !chunk.value.status && chunk.value.content)
                  accumulatedContent += chunk.value.content;
                if (chunk.ok && chunk.value.usage)
                  spentUsage = mergeStreamUsage(spentUsage, chunk.value.usage);
                if (measurement && chunk.ok) {
                  if (!deliveredContent && /\S/.test(chunk.value.content ?? ''))
                    deliveredContent = true;
                  if ('clhMessageEnd' in chunk.value) {
                    explicitMessages = true;
                    if (!out.detached)
                      requestMeasurement(req)?.messageDelivered(1);
                  }
                }
                if (chunk.ok && chunk.value.status) {
                  writeStream(
                    `: status ${JSON.stringify(chunk.value.status)}\n\n`,
                  );
                  continue;
                }
                if (
                  chunk.ok &&
                  ('clhMessageId' in chunk.value ||
                    'clhMessageEnd' in chunk.value ||
                    'clhTurnEnd' in chunk.value)
                )
                  continue;
                if (
                  chunk.ok &&
                  historyTurn &&
                  s &&
                  chunk.value.toolCalls?.length
                ) {
                  const toolCalls = chunk.value.toolCalls.map((call) => ({
                    ...call,
                    id: call.id ?? `toolu_${randomUUID()}`,
                  }));
                  await rememberClientToolTurn(
                    s,
                    historyTurn.id,
                    toolCalls.map((call) => call.id),
                  );
                  yield { ...chunk, value: { ...chunk.value, toolCalls } };
                  continue;
                }
                yield chunk;
              }
            })();
            const sseStream = adapter.transformStream(observed, context);
            for await (const event of sseStream) {
              if (event.event === 'message_delta') {
                heldDelta = event;
                continue;
              }
              // Hold the terminal event until completed history writes are registered.
              if (event.event === 'message_stop') {
                heldStop = event;
                streamSucceeded =
                  streamError === undefined && !agentOpts.signal?.aborted;
                continue;
              }
              const encoded =
                event.event === 'message_start'
                  ? anthropicEventWithUsage(
                      event,
                      spend.streamUsage(spentUsage),
                      responseModel,
                    )
                  : event;
              writeStream(`event: ${encoded.event}\ndata: ${encoded.data}\n\n`);
            }
          }),
        );

        writeTerminalUsage();
        if (streamError !== undefined) streamSucceeded = false;

        // Destination state and unanswered-write notices remain independent of
        // the model cause. Every failed stream must now carry an error event.
        if (streamError !== undefined) {
          if (isOutageError(streamError)) {
            closeDestination(destination, describeCause(streamError));
          }
          const failure = typedFailure(streamError, 'stream');
          const unverified = unverifiedWriteFor(handle, traceId, streamError);
          if (failure) {
            writeStream(
              `event: error\ndata: ${JSON.stringify(anthropicRunError(failure))}\n\n`,
            );
          } else if (unverified) {
            const limit = throttleOf(streamError);
            log.error('Stream error chunk', {
              error: describeCause(streamError),
              throttled: limit?.reason,
            });
            const text = limit
              ? `${unverified} ${throttleMessage(limit)}`
              : unverified;
            writeStream(
              `event: error\ndata: ${JSON.stringify(
                anthropicUnverifiedWrite(
                  text,
                  limit ? 'overloaded_error' : 'api_error',
                ),
              )}\n\n`,
            );
          } else {
            writeStream(
              `event: error\ndata: ${JSON.stringify(anthropicUnverifiedWrite(failureMessage(streamError)))}\n\n`,
            );
          }
        }
      } catch (err) {
        streamSucceeded = false;
        const failure = typedFailure(err);
        if (failure?.status === 400) {
          requestMeasurement(req)?.end('error');
          clearInterval(keepAlive);
          const payload = anthropicRunError(failure);
          if (res.headersSent || failure.code !== MODEL_CONTEXT_EXCEEDED) {
            writeStream(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
            out.end();
          } else out.json(failure.status, payload);
          return;
        }
        writeTerminalUsage();
        requestMeasurement(req)?.end('error');
        if (isOutageError(err))
          closeDestination(destination, describeCause(err));
        if (failure) {
          const payload = anthropicRunError(failure);
          writeStream(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
          clearInterval(keepAlive);
          out.end();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const limit = throttleOf(err);
        log.error('Stream error', { error: message, throttled: limit?.reason });
        // Headers are already sent, so the status code is spent — but the SSE
        // channel is not. Closing in silence leaves the client with a truncated
        // stream and nothing to act on, which for a throttled request is the
        // one case where we know exactly what it should do next.
        const unverified = unverifiedWriteFor(handle, traceId, err);
        const payload = unverified
          ? anthropicUnverifiedWrite(
              limit ? `${unverified} ${throttleMessage(limit)}` : unverified,
              limit ? 'overloaded_error' : 'api_error',
            )
          : anthropicUnverifiedWrite(failureMessage(err));
        writeStream(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      }

      const lastUser = messages
        .filter((message) => message.role === 'user')
        .at(-1);
      if (
        historyTurn &&
        !historyTurn.recorded &&
        streamSucceeded &&
        !pendingClientTools &&
        lastUser &&
        accumulatedContent
      )
        recordTurn(
          boundCaller.value,
          lastUser,
          accumulatedContent,
          historyTurn.id,
          ...(s ? [s] : []),
        );
      // The held `message_stop` closes the message after any notice above.
      if (measurement && !explicitMessages && deliveredContent && !out.detached)
        requestMeasurement(req)?.messageDelivered();
      if (heldStop) {
        writeStream(`event: ${heldStop.event}\ndata: ${heldStop.data}\n\n`);
      }
      clearInterval(keepAlive);
      out.end();
      return;
    }

    // --- Non-streaming ---
    const result = await spend.run(() =>
      runAgent(() => chatAgent.process(messages, agentOpts)),
    );
    const model =
      useDialogue && s
        ? chatResponseModel(resolvedModel.model, responseModel, {
            userId,
            key: s.key,
          })
        : responseModel;
    context.protocol.model = model;
    const resultUsage = result.ok
      ? result.value.usage
      : failedDialogueUsage(result.error);
    const tokens = useDialogue ? resultUsage : spend.usage(resultUsage);
    if (tokens?.models) log.info('Token usage by model', tokens.models);
    const wireUsage = tokens ? anthropicUsageToWire(tokens, model) : undefined;
    const withUsage = <T>(payload: T) =>
      wireUsage && typeof payload === 'object' && payload !== null
        ? { ...payload, usage: wireUsage }
        : payload;
    if (result.ok) {
      if (result.value.toolCalls?.length)
        await rememberClientToolTurn(
          s,
          historyTurn?.id,
          result.value.toolCalls.map((call) => call.id),
        );
      const lastUser = messages
        .filter((message) => message.role === 'user')
        .at(-1);
      if (
        historyTurn &&
        !historyTurn.recorded &&
        lastUser &&
        !agentOpts.signal?.aborted &&
        !hasPendingClientTools(result.value)
      )
        recordTurn(
          boundCaller.value,
          lastUser,
          result.value.content,
          historyTurn.id,
          ...(s ? [s] : []),
        );
      if (
        requestMeasurement(req) &&
        /\S/.test(result.value.content) &&
        !out.detached
      )
        requestMeasurement(req)?.deliverOnResponseEnd();
      out.json(200, withUsage(adapter.formatResult(result.value, context)));
    } else {
      const failure = typedFailure(result.error);
      if (failure?.status === 400) {
        out.json(failure.status, withUsage(anthropicRunError(failure)));
        return;
      }
      if (isOutageError(result.error)) {
        closeDestination(destination, describeCause(result.error));
      }
      if (failure) {
        out.json(failure.status, withUsage(anthropicRunError(failure)));
        return;
      }
      const limit = throttleOf(result.error);
      log.error('Agent processing failed', {
        error: result.error.message,
        throttled: limit?.reason,
      });
      const unverified = unverifiedWriteFor(handle, traceId, result.error);
      if (unverified && limit) {
        // Both apply: the write notice leads, the throttle sentence follows
        // it — but the STATUS and Retry-After stay the throttle path's own.
        // Dropping them to a flat 500 would silently take away the "come back
        // in N seconds" fact a throttled caller still needs.
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        out.json(
          statusForError(result.error),
          withUsage(
            anthropicUnverifiedWrite(
              `${unverified} ${throttleMessage(limit)}`,
              'overloaded_error',
            ),
          ),
        );
      } else if (unverified) {
        out.json(500, withUsage(anthropicUnverifiedWrite(unverified)));
      } else if (limit) {
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        out.json(
          statusForError(result.error),
          withUsage(anthropicErrorPayload(result.error)),
        );
      } else {
        out.json(500, withUsage(adapter.formatError(result.error, context)));
      }
    }
  } catch (error) {
    const failure = typedFailure(error);
    if (failure && typeof error === 'object' && error !== null) {
      if (failure.status !== 400 && isOutageError(error))
        closeDestination(destination, describeCause(error));
      capturedFailures.set(error, failure);
    }
    throw error;
  } finally {
    collections?.restore();
    await pipeline.drain();
    await releaseRequestConnection(requestConnection, s);
    // Free the per-trace telemetry bucket — nobody else calls dropRequest, so
    // omitting this leaks memory per request (Verified fact 10). Guarded: a
    // throw here must not skip the release below, which would hold the slot
    // until restart.
    try {
      handle.recMcp?.dropRequest(traceId);
    } catch (err) {
      log.warn('dropRequest failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    pipeline.release();
  }
}
