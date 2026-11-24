import { isDeepStrictEqual } from 'node:util';
import { MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
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
  failureMessage,
  llmFailure,
  runContextOverflow,
} from './lib/llm-failure';
import { capabilitiesFor } from './lib/model-capabilities';
import { awaitModelCatalog, ensureModelCatalog } from './lib/model-catalog';
import {
  ignoredModelHeader,
  parseModelAllowlist,
  usesModelCatalog,
} from './lib/model-policy';
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
import { summarizeToolResult } from './lib/tool-result-summary';
import {
  assertToolSearchHealthy,
  ToolSearchUnavailableError,
  toolSearchFailure,
} from './lib/tool-search-health';
import {
  measureRequest,
  requestMeasurement,
} from './lib/usage/request-records';
import { emptyOpenAiUsage, openAiUsageToWire } from './lib/usage-wire';
/**
 * OpenAI-compatible HTTP handlers for SmartAgent.
 *
 * Endpoints:
 * - POST /v1/chat/completions — chat (streaming SSE + non-streaming JSON)
 * - GET  /v1/models           — model list
 * - GET  /v1/usage            — token usage
 *
 * Logic ported from SmartServer._handleChat in @mcp-abap-adt/llm-agent.
 */

import { randomUUID } from 'node:crypto';
import {
  type Message,
  normalizeAndValidateExternalTools,
  type TokenUsage,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig, isAiCoreConfigured } from './agent-config';
import {
  closeDestination,
  getCurrentClassifierModel,
  getCurrentDestination,
  getCurrentModel,
  getCurrentPlannerModel,
  getDestinationDiscoveryState,
  getDestinationStates,
  getSmartAgent,
  isAgentReady,
  isDestinationClosed,
  isProvidersReady,
  retryAfterForDestination,
  runWithRequestConnection,
  setSessionDestination,
} from './agent-manager';
import { getAvailableModels } from './lib/ai-core-models';
import { detachedSink, streamWriter } from './lib/detached-sink';
import { dialogueChat, failedDialogueUsage } from './lib/dialogue-chat';
import { describeCaller, type ExpositionLevel } from './lib/exposition';
import { admitPipeline, type PipelineSession } from './lib/gatekeeper';
import { recordDestinationRefusal } from './lib/gatekeeper-metrics';
import { type LongSession, longSessions } from './lib/long-session';
import { describeCause, isOutageError } from './lib/mcp-outage';
import { classifyProbe } from './lib/probe-classifier';
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
  extractText,
  recordTurn,
  rememberClientToolTurn,
  resolveClientHistoryTurn,
  waitForSessionTurns,
} from './lib/session-turns';
import {
  type ChatRunFailure,
  chatRunFailure,
  destinationClosedText,
  openAiDoorRefusal,
  openAiSessionClosed,
  openAiSessionRunRefusal,
  throttleMessage,
  throttleOf,
  unverifiedWriteFor,
} from './lib/throttle-surfacing';
import { hasUnansweredSapWrite } from './lib/tool-journal';
import { usageRuntime } from './lib/usage/runtime';
import { isUserMcpName } from './lib/user-mcp-names';
import { runWithSessionId } from './request-session';
import { honouredSessionId, sessionIdOf, type WithSession } from './session-id';
import {
  amendSessionMessage,
  appendToSession,
  clearSession,
  getSessionHistory,
} from './session-store';

/** Get authenticated user ID from CAP context (XSUAA JWT or mocked auth) */
function getUserId(): string {
  // `??`, as the middleware, the other channels and the RAG routes read it: with
  // `||` an empty id would key this channel's state differently from theirs.
  return cds.context?.user?.id ?? 'anonymous';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: string): string {
  if (r === 'tool_calls' || r === 'tool_use') return 'tool_calls';
  return r === 'stop' ? 'stop' : 'length';
}

function openAiError(message: string, type: string, code?: string) {
  return { error: { message, type, ...(code && { code }) } };
}

function jsonError(message: string, type: string): string {
  return JSON.stringify(openAiError(message, type));
}

function openAiRunError(failure: ChatRunFailure) {
  return openAiError(
    failure.message,
    failure.status === 400 ? 'invalid_request_error' : 'server_error',
    failure.code === MODEL_CONTEXT_EXCEEDED
      ? 'context_length_exceeded'
      : failure.code,
  );
}

/**
 * Run `fn` with the per-request SAP connection bound for its whole async subtree
 * (so MCP tool calls inside the agent pipeline see it). When there is no
 * per-request connection (LLM-only / no destination), run `fn` directly.
 */
function withRequestConnection<T>(
  connection:
    | import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection
    | undefined,
  dumpScope: import('./lib/principal').DumpScope | undefined,
  fn: () => Promise<T>,
  exposition?: ExpositionLevel[],
): Promise<T> {
  return connection
    ? runWithRequestConnection(connection, fn, dumpScope, exposition)
    : fn();
}

// ---------------------------------------------------------------------------
// Rate-limit retry helpers
// ---------------------------------------------------------------------------

// Re-exported: tests and other modules imported these from the handler.
export { appendToSession, clearSession, getSessionHistory };

// ---------------------------------------------------------------------------
// OpenAI request types
// ---------------------------------------------------------------------------

const openAIChatRequestSchema = z
  .object({
    session: z.string().optional(),
    messages: z.array(
      z.object({
        role: z.string(),
        content: z.json().optional(),
        tool_call_id: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.string(),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
      }),
    ),
    tool_choice: z
      .union([
        z.string(),
        z.object({
          type: z.string(),
          function: z.object({ name: z.string() }),
        }),
      ])
      .optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .optional(),
    tools: z.array(z.json()).optional(),
    model: z.string().optional(),
    rag_collections: z.json().optional(),
    classifier_model: z.string().optional(),
    presentation_model: z.string().optional(),
  })
  .catchall(z.json());
type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/chat/completions
 *
 * Accepts OpenAI-format request, delegates to SmartAgent.process() or
 * SmartAgent.streamProcess() depending on `stream` flag.
 */
export function handleChatCompletions(
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
        return handleChatCompletionsMeasured(req, res);
      return handleChatCompletionsWithUsage(req, res);
    }),
  );
}

async function handleChatCompletionsWithUsage(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = sessionIdOf(req);
  if (!sessionId) return handleChatCompletionsMeasured(req, res);
  const body: { stream?: boolean } | undefined = req.body;
  const measurement = measureRequest(
    req,
    res,
    { userId: getUserId(), sessionId },
    'openai',
    body?.stream === true,
  );
  try {
    await handleChatCompletionsMeasured(req, res);
  } catch (error) {
    measurement?.end('error');
    throw error;
  } finally {
    measurement?.finish();
  }
}

async function handleChatCompletionsMeasured(
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
    () => handleChatCompletionsScoped(req, res),
    own ? getExecutionLimits(userId, own.key) : {},
  );
}

async function handleChatCompletionsScoped(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (toolSearchFailure()) await assertToolSearchHealthy();
  } catch (error) {
    res.status(503).json({
      error: {
        message:
          error instanceof ToolSearchUnavailableError
            ? error.message
            : 'Tool search unavailable',
        type: 'service_unavailable',
        code: 'tool_search_unavailable',
      },
    });
    return;
  }
  // Block requests until the providers are built and the agent is available
  if (!isProvidersReady() || !isAgentReady()) {
    const aiCoreAvailable = isAiCoreConfigured();
    res.status(503).json({
      error: {
        message: aiCoreAvailable
          ? 'SmartAgent is initializing (MCP connect + tool vectorization). Please retry in a moment.'
          : 'Agent endpoints require SAP AI Core service binding. Enable cloud-llm-hub-ai-core resource in your .mtaext deployment descriptor.',
        type: 'service_unavailable',
      },
    });
    return;
  }

  // Parse body (Express may have already parsed it if json middleware is active,
  // but for raw body we parse manually)
  let body: OpenAIChatRequest;
  try {
    if (typeof req.body === 'object' && req.body !== null) {
      body = openAIChatRequestSchema.parse(req.body);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      body = openAIChatRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf-8')),
      );
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
    return;
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(body.messages)
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      jsonError('messages must be a non-empty array', 'invalid_request_error'),
    );
    return;
  }

  delete body.session;

  const userMessages = body.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(
        'at least one message with role "user" is required',
        'invalid_request_error',
      ),
    );
    return;
  }

  const migrations = new Map([
    [
      'rag_list',
      'Use collections_list for discovery, collection_records for paging, or rag_read with an exact document id.',
    ],
    ['rag_add', 'Use collection_create when needed, then record_add.'],
    [
      'rag_correct',
      'Use record_update with record and text (formerly newText).',
    ],
    [
      'rag_deprecate',
      'Use record_set_enabled with id and enabled: false for retirement, or record_delete with record for permanent removal.',
    ],
  ]);
  const rejectTool = (message: string): void => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError(message, 'invalid_request_error'));
  };
  const canonical = buildRagToolSchemas();
  const consumerTools: NonNullable<OpenAIChatRequest['tools']> = [];
  for (const entry of body.tools ?? []) {
    const parsed = z
      .object({ function: z.object({ name: z.string() }) })
      .safeParse(entry);
    const name = parsed.success ? parsed.data.function.name : '';
    const migration = migrations.get(name);
    if (migration) {
      rejectTool(`${name} was removed. ${migration}`);
      return;
    }
    if (isRagTool(name)) {
      if (
        !isDeepStrictEqual(
          entry,
          canonical.find((tool) => tool.function.name === name),
        )
      ) {
        rejectTool(
          `Conflicting definition for host RAG tool ${name}. Use the canonical definition or omit it.`,
        );
        return;
      }
    } else consumerTools.push(entry);
  }
  const forced =
    typeof body.tool_choice === 'object'
      ? body.tool_choice.function?.name
      : undefined;
  if (forced && migrations.has(forced)) {
    rejectTool(`${forced} was removed. ${migrations.get(forced)}`);
    return;
  }
  const hostIds = new Set<string>();
  for (const message of body.messages) {
    for (const call of message.tool_calls ?? []) {
      if (message.role === 'assistant' && migrations.has(call.function.name)) {
        rejectTool(
          `${call.function.name} was removed. ${migrations.get(call.function.name)}`,
        );
        return;
      }
      if (isRagTool(call.function.name) || migrations.has(call.function.name))
        hostIds.add(call.id);
    }
  }
  if (
    body.messages.some(
      (message) =>
        message.role === 'tool' && hostIds.has(message.tool_call_id ?? ''),
    )
  ) {
    rejectTool('External results cannot claim host RAG tool call identities.');
    return;
  }
  body = { ...body, tools: consumerTools };
  const requestModel = chatRequestModel(
    body.model,
    cds.context?.user?.is('MCP_Admin') === true,
  );
  if (requestModel.ignored) {
    res.setHeader(
      'x-clh-model-ignored',
      ignoredModelHeader(requestModel.ignored),
    );
    cds.log('openai-handler').warn('Ignoring request model outside allowlist', {
      model: requestModel.ignored,
    });
  }

  // A long session serves its requests one at a time, through the connection
  // it holds; without one the request stands alone, as it always has.
  const authenticatedCaller = {
    userId: getUserId(),
    admin: cds.context?.user?.is?.('MCP_Admin') ?? false,
    caller: describeCaller(cds.context?.user),
  };
  const s = (req as LongSessionRequest).longSession;
  const measurement = requestMeasurement(req);
  measurement?.setStream(body.stream === true);
  const early =
    body.stream &&
    s &&
    (req.headers['x-sap-destination'] ||
      s.destination ||
      getCurrentDestination(getUserId(), sessionIdOf(req))) &&
    getAgentConfig().agent.chatCoordinator === 'dialogue'
      ? chatStream(res, 'openai', s)
      : undefined;
  const capturedFailures = new WeakMap<object, ChatRunFailure>();
  try {
    const continuation = s
      ? await longSessions().run(
          s,
          () =>
            serveChatCompletions(
              req,
              res,
              body,
              authenticatedCaller,
              capturedFailures,
              s,
              early,
            ),
          () => early?.ensureStream(),
        )
      : await serveChatCompletions(
          req,
          res,
          body,
          authenticatedCaller,
          capturedFailures,
          undefined,
          early,
        );
    if (typeof continuation === 'function') await continuation();
    else if (continuation) {
      const refusal = openAiSessionRunRefusal(continuation.refused);
      if (early?.opened) early.error(refusal.body);
      else {
        res.writeHead(refusal.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(refusal.body));
      }
    }
  } catch (error) {
    measurement?.end('error');
    const capturedFailure =
      typeof error === 'object' && error !== null
        ? capturedFailures.get(error)
        : undefined;
    const failure =
      capturedFailure ??
      chatRunFailure(error, {
        protocol: 'openai',
        stream: body.stream,
        setHeader: detachedSink(res).setHeader,
      });
    if (failure) {
      if (!capturedFailure)
        logRunFailure(
          cds.log('openai-handler'),
          error,
          failure,
          measurement?.traceId,
        );
      const payload = openAiRunError(failure);
      if (early?.opened) early.error(payload, true);
      else if (res.headersSent)
        res.end(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      else res.status(failure.status).json(payload);
      return;
    }
    if (!early?.opened) throw error;
    early.error({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'server_error',
      },
    });
  }
}

/** The chat itself, once the body is valid; `s` is the long session it runs in. */
async function serveChatCompletions(
  req: Request,
  res: Response,
  body: OpenAIChatRequest,
  authenticatedCaller: {
    userId: string;
    admin: boolean;
    caller: ReturnType<typeof describeCaller>;
  },
  capturedFailures: WeakMap<object, ChatRunFailure>,
  s?: LongSession,
  early?: ChatStream,
): Promise<(() => Promise<void>) | void> {
  const log = cds.log('openai-handler');
  const dialogueMode = getAgentConfig().agent.chatCoordinator === 'dialogue';

  // Validate and normalize external tools (passed to SmartAgent for client adapter detection)
  const externalToolsValidation = normalizeAndValidateExternalTools(body.tools);
  const externalTools = externalToolsValidation.tools.filter(
    (tool) => !isUserMcpName(tool.name),
  );
  const externalToolErrors =
    externalToolsValidation.errors.length +
    externalToolsValidation.tools.length -
    externalTools.length;
  const invalidToolsHeader: Record<string, string> =
    externalToolErrors > 0
      ? { 'x-smartagent-invalid-tools': String(externalToolErrors) }
      : {};
  registerClientTools(externalTools);
  if (externalToolErrors > 0) {
    log.debug('Invalid external tools detected', {
      count: externalToolErrors,
    });
  }

  const traceId = requestMeasurement(req)?.traceId ?? randomUUID();
  // A session the caller presented and we kept. A freshly minted one is not
  // explicit: a stateless API client sending its full history must never be
  // truncated to its last message.
  const explicitSessionId = honouredSessionId(req);
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(403).json({
      error: {
        message: 'SESSION_REQUIRED: session middleware must issue a session',
      },
    });
    return;
  }
  const t0 = requestStart(req);

  // Explicit sessions and client-managed requests share the same history policy.
  const serverManaged = !!explicitSessionId;

  // Resolve user identity early — needed for user-keyed session store lookups below.
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

  const caller = authenticatedCaller.caller;
  log.info('MCP caller', caller);
  const callerExposition = caller.exposition;

  /** `withRequestConnection` with this caller's permissions already bound, so
   *  no call site can forget them. */
  const withRequestConnectionAuthorized = <T>(
    connection:
      | import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection
      | undefined,
    dumpScope: import('./lib/principal').DumpScope | undefined,
    fn: () => Promise<T>,
  ): Promise<T> =>
    withRequestConnection(connection, dumpScope, fn, callerExposition);

  let normalizedMessages: Message[];

  // Client history mode: normalize all client messages
  normalizedMessages = body.messages
    .map((m) => {
      const role = m.role as Message['role'];
      const msg: Message = { role, content: extractText(m.content) };
      if (role === 'tool') {
        if (typeof m.tool_call_id === 'string' && m.tool_call_id.trim()) {
          msg.tool_call_id = m.tool_call_id;
        } else {
          return null;
        }
      }
      if (role === 'assistant' && Array.isArray(m.tool_calls)) {
        const toolCalls = m.tool_calls
          .filter(
            (tc) =>
              typeof tc === 'object' &&
              tc !== null &&
              typeof tc.id === 'string' &&
              tc.type === 'function' &&
              typeof tc.function?.name === 'string' &&
              typeof tc.function?.arguments === 'string',
          )
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
          if (!msg.content) msg.content = null;
        }
      }
      return msg;
    })
    .filter((m): m is Message => m !== null);

  const rawHistorySize = normalizedMessages.length;
  normalizedMessages = clientHistoryMessages(
    normalizedMessages,
    getAgentConfig().agent.clientHistory,
  );

  log.info('Chat completions request', {
    stream: body.stream ?? false,
    traceId,
    sessionId,
    mode: serverManaged ? 'server-session' : 'client-history',
    rawHistorySize,
    historySize: normalizedMessages.length,
    roles: normalizedMessages.map((m) => m.role).join(','),
  });

  // Resolve the request model without changing deployment defaults.
  const modelResolution = chatRequestModel(
    typeof body.model === 'string' ? body.model : undefined,
    cds.context?.user?.is('MCP_Admin') === true,
  );
  const requestedModel = modelResolution.model;
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;

  // Track destination before/after to detect switches
  const destBefore = getCurrentDestination(userId, sessionId);
  const destAfter = requestedDestination || s?.destination || destBefore;
  const useDialogue = dialogueMode && !!s && !!destAfter;
  // The caller's permissions, resolved ONCE and used for two different jobs:
  // the RAG filter (which tools are offered) and the ALS binding (which tools
  // may actually run). They must agree, so they come from the same value.
  let writeToolResult: ((chunk: string) => void) | undefined;
  const ragIdentity = {
    admin: authenticatedCaller.admin,
    channel: 'openai' as const,
    userMcpSession: s,
    onToolResult: useDialogue
      ? undefined
      : (record: import('@mcp-abap-adt/llm-agent').ToolCallRecord): void => {
          if (
            body.stream &&
            req.headers['x-clh-tool-results']?.toString().toLowerCase() ===
              'summary'
          )
            writeToolResult?.(
              `: tool-result ${JSON.stringify(summarizeToolResult(record))}\n\n`,
            );
        },
  };
  if (dialogueMode && !useDialogue)
    res.setHeader('x-clh-coordinator', 'adaptive');
  if (useDialogue && s) {
    const handle = await lookupDialogue(userId, s.key);
    try {
      await handle?.factory.assertPrincipal(req.headers, destAfter);
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
    s.destination !== destAfter
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
  let requestConnection:
    | import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection
    | undefined;
  let requestDumpScope: import('./lib/principal').DumpScope | undefined;

  log.debug('Destination tracking', {
    sessionId,
    destBefore,
    destAfter,
    requestedDestination: requestedDestination || '(none)',
  });

  // A closed destination refuses before anything is built for it. Connecting
  // first would CSRF-fetch against the system that is down — often waiting out
  // a tunnel timeout — and answer `401 sap_credentials_failed` from inside
  // `establishRequestConnection`, so this 503 with its `Retry-After` would only
  // ever be reached once SAP was back. It also comes before `getSmartAgent`,
  // which throws its own `destination_unreachable` 503 with no `Retry-After`.
  // No connection exists yet, so there is nothing to `safeStop`.
  if (isDestinationClosed(destAfter)) {
    recordDestinationRefusal(destAfter);
    const seconds = retryAfterForDestination(destAfter);
    if (early?.opened) {
      early.error({
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destAfter),
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
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destAfter),
        },
      }),
    );
    return;
  }

  const streamHeaders = {
    'X-SAP-Active-Destination': destAfter,
    ...invalidToolsHeader,
  };
  early?.ensureStream(streamHeaders);

  if (destAfter && !useDialogue) {
    const established = s
      ? await acquireSessionConnection(s, req, res, destAfter)
      : await establishRequestConnection(req, res, destAfter);
    if (established.handled) return;
    requestConnection = established.connection;
    requestDumpScope = established.dumpScope;
  }

  /** Called admitted, right before the run: this request's responsible person
   *  and master system, visible to this run alone (`request-system-context.ts`). */
  const inRequestSystem = <T>(fn: () => Promise<T>): Promise<T> =>
    requestConnection
      ? runWithRequestSystem(resolveRequestSystem(req.headers), fn)
      : fn();

  // A client disconnect ends nothing. Tearing the connection down on `close` is
  // the recorded cause of the orphaned ADT locks in SM12: nobody is waiting for
  // the answer, and SAP is waiting for the rest of the chain. So the sink is
  // detached — nothing written afterwards reaches the socket or fails the run —
  // and a caller still queued is removed from the queue.
  const out = detachedSink(res);
  const setErrorHeaders = () => {
    const headers = body.stream
      ? streamHeaders
      : { 'Content-Type': 'application/json', ...invalidToolsHeader };
    for (const [name, value] of Object.entries(headers))
      out.setHeader(name, value);
  };
  const callerLeft = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    log.info('Caller disconnected; the session runs to its end', { sessionId });
    out.detach();
    callerLeft.abort(new Error('caller disconnected'));
  });

  let responseModel: string;
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    await waitForSessionTurns(sessionId, callerLeft.signal);
    responseModel = chatResponseModel(requestedModel, getCurrentModel());
    // Use destAfter (header OR session/default) — the same destination the
    // connection was established for. requestedDestination alone is undefined
    // for session-scoped chats, which would fall to the configured default.
    handle = await getSmartAgent(
      currentRoleModel('coordinator') ?? requestedModel,
      destAfter,
    );
  } catch (err) {
    await releaseRequestConnection(requestConnection, s);
    if (runContextOverflow(err)) {
      setErrorHeaders();
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (early?.opened) {
      early.error({
        error: {
          type: 'server_error',
          message: `Agent initialization failed: ${message}`,
        },
      });
      return;
    }
    // Propagate the structured destination_unreachable error from getSmartAgent
    // so clients can distinguish "your SAP system isn't reachable" from generic
    // server faults (see issue #83). Falls through to generic 503 otherwise.
    const errObj = err as {
      statusCode?: number;
      code?: string;
      destination?: string;
      destinationStatus?: string;
    };
    log.error('Failed to initialize SmartAgent', {
      error: message,
      code: errObj.code,
      destination: errObj.destination,
      destinationStatus: errObj.destinationStatus,
    });
    const status = errObj.statusCode ?? 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (errObj.code === 'destination_unreachable') {
      // Run the shared classifier (#85) on the last-known probe error so
      // non-UI clients (curl, MCP, IDE integrations) get the same triage
      // info the WebUI DIAG button shows — without paying for a live probe.
      let classified: { status: string; hint: string } = {
        status: 'unknown',
        hint: '',
      };
      try {
        // Pull the cached destination state through the public listing so
        // we don't widen agent-manager's surface; status carries the
        // last-known raw error if any.
        const states = getDestinationStates();
        const state = states.find((s) => s.name === errObj.destination);
        classified = classifyProbe(
          0,
          state?.error || message,
          // proxyType not exposed on state; default to onpremise hint set
          // which is the common case for this product.
          'OnPremise',
        );
      } catch {
        // classification is best-effort; never block the error response
      }
      res.end(
        JSON.stringify({
          error: {
            type: 'destination_unreachable',
            message,
            destination: errObj.destination,
            destination_status: errObj.destinationStatus,
            classified_status: classified.status,
            hint: classified.hint,
            diagnose_url: '/odata/v4/mcp-proxy/DiagnoseDestinations()',
          },
        }),
      );
    } else {
      res.end(
        jsonError(`Agent initialization failed: ${message}`, 'server_error'),
      );
    }
    return;
  }

  const dialogue =
    useDialogue && s
      ? dialogueChat(
          req,
          userId,
          s,
          destAfter,
          res,
          {
            headers: req.headers,
            body,
          },
          requestedModel,
        )
      : undefined;
  const chatAgent = dialogue ?? handle.agent;
  const unansweredSapWrite = () =>
    dialogue?.hasUnansweredSapWrite() ??
    hasUnansweredSapWrite(handle.recMcp?.getToolRecords(traceId) ?? []);
  const pipelineFailures = pipelineFailureLogger(traceId);
  const typedFailure = <T>(error: T) => {
    const failure = chatRunFailure(error, {
      protocol: 'openai',
      stream: body.stream,
      unansweredSapWrite: unansweredSapWrite(),
      writeNotice: () => unverifiedWriteFor(handle, traceId, llmFailure(error)),
      setHeader: out.setHeader,
    });
    if (failure) {
      setErrorHeaders();
      logRunFailure(log, error, failure, traceId);
    }
    return failure;
  };

  // Admitted after the agent is resolved: a caller waiting for a destination to
  // warm waits outside the door, holding a request and no session.
  let pipeline: PipelineSession;
  try {
    const admission = await admitPipeline(
      userId,
      sessionId,
      callerLeft.signal,
      {
        presented: (req as Request & WithSession).sessionMinted === false,
      },
    );
    if ('refused' in admission) {
      requestMeasurement(req)?.end('limit');
      await releaseRequestConnection(requestConnection, s);
      const refusal = openAiDoorRefusal(admission.refused);
      if (early?.opened) early.error(refusal.body);
      else out.json(refusal.status, refusal.body);
      return;
    }
    if ('closed' in admission) {
      // Logged out while this request waited for its agent. Running now would
      // bring the session back under the id the caller asked us to destroy.
      await releaseRequestConnection(requestConnection, s);
      const closed = openAiSessionClosed();
      if (early?.opened) early.error(closed.body);
      else out.json(closed.status, closed.body);
      return;
    }
    pipeline = admission.admitted;
    requestMeasurement(req)?.admitted();
  } catch (error) {
    // Left while queued. Nothing was started, so nothing is owed but the connection.
    await releaseRequestConnection(requestConnection, s);
    if (early?.opened && !callerLeft.signal.aborted) throw error;
    return;
  }

  // Install stores only after admission; restore them in finally.
  const collections = useDialogue
    ? undefined
    : collectionRetrieval(handle.agent);

  try {
    // Track which destination this session is using. A switch keeps the
    // conversation: its history and session collections stay (spec goal 10);
    // only the ABAP session is new, and a long session has already replaced
    // its connection above. Recorded only now, admitted: a request refused,
    // answered 410 or gone while queued started nothing, so it changes
    // nothing. Read again here rather than at arrival: a run of this session
    // that ended while this request waited may have moved it.
    const lastDestination = getCurrentDestination(userId, sessionId);
    if (lastDestination !== destAfter && serverManaged) {
      log.info('Destination switch, session history kept', {
        from: lastDestination,
        to: destAfter,
        sessionId,
      });
    }
    // Under the admission's lease: a logout's removal waits for it, so this
    // entry cannot be written back after the session it names is gone.
    setSessionDestination(userId, sessionId, destAfter);

    /**
     * Everything before this request's new user message.
     *
     * The coordinator composes the executor's prompt from the LAST user message
     * alone, so the executor needs the turns that came before it — and only
     * those, or the new message would appear twice. Bound to the request scope
     * below and read back inside the executor.
     */
    const priorTurns = (() => {
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === 'user')
          return normalizedMessages.slice(0, i);
      }
      return [];
    })();

    const usage = usageRuntime()
      ?.forSession({
        sessionId,
        userId,
        destination: destAfter,
      })
      .with({ requestId: traceId, traceId });
    requestMeasurement(req)?.bind(usage);
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
          normalizedMessages,
          historySignal,
          s,
        );
      historySignal.throwIfAborted();
    } catch (error) {
      if (callerLeft.signal.aborted) return;
      throw error;
    }
    const spend = captureTokenUsage();
    // The parsed body: a raw request carries it only in `body`, not `req.body`.
    if (collections) {
      const retrieval = await spend.run(() =>
        collections.retrieve(
          { headers: req.headers, body },
          normalizedMessages,
          userId,
          sessionId,
          log,
          res.headersSent,
          usage,
        ),
      );
      if (retrieval.refusal) {
        if (early?.opened) {
          early.error({
            error: { message: retrieval.refusal.message, type: 'server_error' },
          });
          return;
        }
        res.writeHead(retrieval.refusal.status, {
          'Content-Type': 'application/json',
        });
        res.end(jsonError(retrieval.refusal.message, retrieval.refusal.kind));
        return;
      }
      normalizedMessages = retrieval.messages;
    }

    const pipelineLog = cds.log('smart-pipeline');
    const opts = {
      requestStartedAt: requestStart(req),
      stream: body.stream,
      // External tools (attempt_completion, read_file, etc.) from client — passed to SmartAgent
      // for ClineClientAdapter detection and external tool_call routing.
      externalTools,
      ...callOptionsFor(boundCaller.value),
      // The admission's signal, which only shutdown aborts. Not the caller's.
      signal: pipeline.signal,
      // RAG filtering: namespace isolates user/destination data, exposition filters tools by role.
      // ExpositionFilteringRag strips namespace (tools have none) and post-filters by exposition.
      ragFilter: {
        namespace: `${userId}:${destAfter}`,
        exposition: callerExposition,
      },
      trace: { traceId },
      ...(usage ? { usage } : {}),
      sessionLogger: {
        logStep(
          name: Parameters<typeof pipelineFailures.logStep>[0],
          data: Parameters<typeof pipelineFailures.logStep>[1],
        ) {
          if (pipelineFailures.logStep(name, data)) return;
          if (
            name === 'tools_selected' ||
            name === 'skills_selected' ||
            name === 'skill_select_rag_fallback' ||
            name.startsWith('rag_query') ||
            name === 'classification_skipped' ||
            name === 'tool_select_rag_fallback' ||
            name.startsWith('custom_classify') ||
            name.startsWith('custom_tool_select') ||
            name.startsWith('final_context') ||
            name.startsWith('llm_request') ||
            name.startsWith('llm_response') ||
            name.startsWith('external_tools')
          ) {
            pipelineLog.info(name, data);
          }
        },
      },
    };

    if (body.stream && dialogue && early) {
      let assistant: Message | undefined;
      const lastUser = normalizedMessages
        .filter((m) => m.role === 'user')
        .at(-1);
      return await streamDialogue({
        stream: early,
        protocol: 'openai',
        model: () =>
          chatResponseModel(
            requestedModel,
            responseModel,
            s ? { userId, key: s.key } : undefined,
          ),
        agent: dialogue,
        source: dialogue.streamProcess(normalizedMessages, opts),
        run: (fn) =>
          pipeline.run(() =>
            runWithSessionId(sessionId, fn, priorTurns, userId, ragIdentity),
          ),
        onError: (error) => {
          const failure = typedFailure(error);
          if (failure?.status === 400) return openAiRunError(failure);
          if (isOutageError(error))
            closeDestination(destAfter, describeCause(error));
          if (failure) return openAiRunError(failure);
          return {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'server_error',
            },
          };
        },
        onTurnEnd: (text) => {
          if (callerLeft.signal.aborted || opts.signal?.aborted) return;
          if (lastUser) {
            if (text) assistant = { role: 'assistant', content: text };
            appendToSession(
              sessionId,
              userId,
              lastUser,
              ...(assistant ? [assistant] : []),
            );
          }
        },
        onEnd: (text) => {
          if (assistant)
            amendSessionMessage(sessionId, userId, assistant, text);
          else if (
            text &&
            lastUser &&
            getSessionHistory(sessionId, userId).includes(lastUser)
          ) {
            assistant = { role: 'assistant', content: text };
            appendToSession(sessionId, userId, assistant);
          }
        },
      });
    }

    // --- Streaming ---
    if (body.stream) {
      const writeStream = streamWriter(out, streamHeaders);
      writeToolResult = writeStream;

      // Independent SSE keep-alive. Under the DAG coordinator the executor's
      // heartbeats are routed to the session log only (llm-agent #166), so
      // during a long tool loop NOTHING flows on the wire until the finalizer
      // emits — the CF router / browser would close the idle connection
      // (observed: dump queries "No response" at ~22s). This comment-only tick
      // keeps the socket alive regardless of what the coordinator forwards.
      // Comments are ignored by SSE clients, so it is harmless during active
      // streaming too.
      const KEEPALIVE_MS = 10_000;
      const keepAlive = setInterval(() => {
        writeStream(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      res.on('close', () => clearInterval(keepAlive));

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      let firstChunk = true;
      let chunkCount = 0;
      let finishReasonSent = false;
      let accumulatedContent = ''; // Accumulate full response for session history
      let streamSucceeded = false;
      let pendingClientTools = false;
      let lastUsage: TokenUsage | undefined;
      let streamErrorMessage: string | undefined;
      let streamFailure: ChatRunFailure | undefined;

      log.info('Starting streamProcess', { sessionId });

      // Bind the caller and session for canonical host RAG execution.
      // The wrapper must enclose the whole retry loop so the context stays alive across
      // all stream iterations, including rate-limit retries.
      // Retry loop: restart stream on rate-limit errors (only before first content chunk)
      await pipeline.run(() =>
        runWithSessionId(
          sessionId,
          () =>
            withRequestConnectionAuthorized(
              requestConnection,
              requestDumpScope,
              // Admitted: the responsible person and master system are resolved
              // here, not before the queue wait — see `inRequestSystem`.
              () =>
                inRequestSystem(() =>
                  spend.run(async () => {
                    const stream = chatAgent.streamProcess(
                      normalizedMessages,
                      opts,
                    );

                    try {
                      let streamFailed = false;
                      for await (const chunk of stream) {
                        chunkCount++;
                        if (!chunk.ok) {
                          streamFailed = true;
                          requestMeasurement(req)?.end('error');
                          const err = chunk.error;
                          streamFailure = typedFailure(err);
                          if (streamFailure?.status === 400) break;
                          if (isOutageError(chunk.error)) {
                            closeDestination(
                              destAfter,
                              describeCause(chunk.error),
                            );
                          }
                          if (streamFailure) break;

                          const causes: string[] = [];
                          let current: unknown = err;
                          while (current) {
                            if (current instanceof Error) {
                              causes.push(current.message);
                              current = (current as { cause?: unknown }).cause;
                            } else {
                              causes.push(String(current));
                              break;
                            }
                          }
                          log.error('Stream error chunk', {
                            chunkCount,
                            error: err.message,
                            causes,
                          });
                          const limit = throttleOf(err);
                          const unverified = unverifiedWriteFor(
                            handle,
                            traceId,
                            err,
                          );
                          streamErrorMessage = unverified
                            ? limit
                              ? `${unverified} ${throttleMessage(limit)}`
                              : unverified
                            : limit
                              ? `${failureMessage(err)}. ${throttleMessage(limit)}`
                              : failureMessage(err);
                          break;
                        }

                        const v = chunk.value;
                        if (v.usage) lastUsage = v.usage;
                        if (v.reset) pendingClientTools = false;
                        pendingClientTools ||= hasPendingClientTools(v);
                        if (
                          'clhMessageId' in v ||
                          'clhMessageEnd' in v ||
                          'clhTurnEnd' in v
                        )
                          continue;

                        // Forward heartbeats as SSE comments to keep the connection alive.
                        // Without this, CF Router / Cloud Connector may close idle TCP
                        // connections before the tool loop finishes, causing the browser's
                        // reader.read() to hang forever (onDone never fires).
                        if (v.heartbeat) {
                          writeStream(
                            `: heartbeat ${JSON.stringify(v.heartbeat)}\n\n`,
                          );
                          continue;
                        }
                        if (v.status) {
                          writeStream(
                            `: status ${JSON.stringify(v.status)}\n\n`,
                          );
                          continue;
                        }
                        if (v.timing) {
                          log.info('Pipeline stage timing', {
                            timing: v.timing,
                          });
                          continue;
                        }

                        const baseResponse = {
                          id,
                          object: 'chat.completion.chunk',
                          created,
                          model: responseModel,
                          usage: null,
                        };

                        // First chunk: role + initial content (matches SmartServer)
                        const initialChunk = firstChunk;
                        if (firstChunk) {
                          const initialContent = v.content || '';
                          if (initialContent)
                            accumulatedContent += initialContent;
                          writeStream(
                            `data: ${JSON.stringify({
                              ...baseResponse,
                              choices: [
                                {
                                  index: 0,
                                  delta: {
                                    role: 'assistant',
                                    content: initialContent,
                                  },
                                  finish_reason: null,
                                },
                              ],
                            })}\n\n`,
                          );
                          firstChunk = false;
                          if (!v.finishReason && !v.toolCalls) continue;
                        }

                        // Content and/or tool_calls delta (matches SmartServer)
                        if ((!initialChunk && v.content) || v.toolCalls) {
                          const delta: Record<string, unknown> = {};
                          if (!initialChunk && v.content) {
                            accumulatedContent += v.content;
                            delta.content = v.content;
                          }
                          if (v.toolCalls) {
                            await rememberClientToolTurn(
                              s,
                              historyTurn?.id,
                              v.toolCalls.flatMap((call) =>
                                call.id ? [call.id] : [],
                              ),
                            );
                            delta.tool_calls = v.toolCalls.map(
                              (call, index) => {
                                const tc = toToolCallDelta(call, index);
                                return {
                                  index: tc.index,
                                  id: tc.id,
                                  type: 'function',
                                  function: {
                                    name: tc.name,
                                    arguments: tc.arguments || '',
                                  },
                                };
                              },
                            );
                          }
                          writeStream(
                            `data: ${JSON.stringify({
                              ...baseResponse,
                              choices: [
                                {
                                  index: 0,
                                  delta,
                                  finish_reason: null,
                                },
                              ],
                            })}\n\n`,
                          );
                        }

                        if (v.finishReason) {
                          writeStream(
                            `data: ${JSON.stringify({
                              ...baseResponse,
                              choices: [
                                {
                                  index: 0,
                                  delta: {},
                                  finish_reason: mapStopReason(v.finishReason),
                                },
                              ],
                            })}\n\n`,
                          );
                          finishReasonSent = true;
                        }
                      }
                      streamSucceeded = !streamFailed;
                    } catch (err) {
                      requestMeasurement(req)?.end('error');
                      streamFailure = typedFailure(err);
                      if (streamFailure?.status === 400) return;
                      if (isOutageError(err)) {
                        closeDestination(destAfter, describeCause(err));
                      }
                      if (streamFailure) return;
                      const errMsg =
                        err instanceof Error ? err.message : String(err);
                      log.error('Stream exception', {
                        error: errMsg,
                        stack: err instanceof Error ? err.stack : undefined,
                      });
                      const streamLimit = throttleOf(err);
                      const streamUnverified = unverifiedWriteFor(
                        handle,
                        traceId,
                        err,
                      );
                      streamErrorMessage = streamUnverified
                        ? streamLimit
                          ? `${streamUnverified} ${throttleMessage(streamLimit)}`
                          : streamUnverified
                        : streamLimit
                          ? `${failureMessage(err)}. ${throttleMessage(streamLimit)}`
                          : failureMessage(err);
                    }
                  }),
                ),
            ),
          priorTurns,
          userId,
          ragIdentity,
        ),
      );
      // end runWithSessionId / runWithRequestConnection / pipeline.run

      const tokens = spend.usage(lastUsage);
      if (tokens?.models) log.info('Token usage by model', tokens.models);
      if (streamFailure?.status === 400) {
        clearInterval(keepAlive);
        const payload = openAiRunError(streamFailure);
        if (res.headersSent || streamFailure.code !== MODEL_CONTEXT_EXCEEDED) {
          writeStream(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
          out.end();
        } else out.json(streamFailure.status, payload);
        return;
      }
      const usage = openAiUsageToWire(tokens, responseModel);
      const writeUsage = () => {
        if (usage)
          writeStream(
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: responseModel, choices: [], usage })}\n\n`,
          );
      };
      if (streamFailure) {
        writeUsage();
        writeStream(
          `event: error\ndata: ${JSON.stringify(openAiRunError(streamFailure))}\n\n`,
        );
        clearInterval(keepAlive);
        out.end();
        return;
      }
      if (streamErrorMessage !== undefined) {
        writeUsage();
        writeStream(
          `data: ${jsonError(streamErrorMessage, 'server_error')}\n\n`,
        );
      }

      // Ensure finish_reason is always sent — clients require it to detect stream end
      if (!finishReasonSent) {
        writeStream(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
        );
      }

      // Always send usage chunk — clients need it for token tracking.
      // OpenAI spec gates this behind stream_options.include_usage, but in practice
      // most clients (Goose, Cline) expect it. Sending unconditionally is safe —
      // clients that don't need it simply ignore the extra chunk.
      if (streamErrorMessage === undefined) writeUsage();

      log.info('Stream completed', {
        chunkCount,
        hasUsage: !!tokens,
        durationMs: Date.now() - t0,
        responseLength: accumulatedContent.length,
      });

      const terminalSucceeded = streamSucceeded && !opts.signal?.aborted;
      // Save conversation turn to server session
      if (terminalSucceeded && accumulatedContent) {
        const lastUser = normalizedMessages
          .filter((m) => m.role === 'user')
          .slice(-1)[0];
        if (lastUser) {
          appendToSession(sessionId, userId, lastUser, {
            role: 'assistant',
            content: accumulatedContent,
          } as Message);
          if (historyTurn && !historyTurn.recorded && !pendingClientTools)
            recordTurn(
              boundCaller.value,
              lastUser,
              accumulatedContent,
              historyTurn.id,
              ...(s ? [s] : []),
            );
          const updatedHistory = getSessionHistory(sessionId, userId);
          log.debug('Session updated', {
            sessionId,
            storedMessages: updatedHistory.length,
            responseChars: accumulatedContent.length,
          });
        }
      }
      writeStream('data: [DONE]\n\n');

      if (chunkCount === 0) {
        log.warn(
          'Stream produced 0 chunks — pipeline may have failed silently',
          {
            messageCount: normalizedMessages.length,
            sessionId,
          },
        );
      }

      clearInterval(keepAlive);
      if (
        requestMeasurement(req) &&
        /\S/.test(accumulatedContent) &&
        !out.detached
      )
        requestMeasurement(req)?.messageDelivered();
      out.end();
      return;
    }

    // --- Non-streaming (with rate-limit retry) ---
    // Bind the caller and session for canonical host RAG execution.
    // The wrapper encloses the whole retry block so the context stays alive across retries.
    const result = await spend.run(() =>
      pipeline.run(() =>
        runWithSessionId(
          sessionId,
          () =>
            withRequestConnectionAuthorized(
              requestConnection,
              requestDumpScope,
              // Admitted — see `inRequestSystem`.
              () =>
                inRequestSystem(async () =>
                  chatAgent.process(normalizedMessages, opts),
                ),
            ),
          priorTurns,
          userId,
          ragIdentity,
        ),
      ),
    );

    log.info('Chat completions done', {
      ok: result.ok,
      durationMs: Date.now() - t0,
    });

    if (!result.ok) requestMeasurement(req)?.end('error');
    const failure = result.ok ? undefined : typedFailure(result.error);
    if (failure?.status === 400) {
      out.json(failure.status, openAiRunError(failure));
      return;
    }
    if (!result.ok && isOutageError(result.error)) {
      closeDestination(destAfter, describeCause(result.error));
    }

    const finalFinishReason = result.ok
      ? mapStopReason(result.value.stopReason)
      : 'stop';

    const model =
      useDialogue && s
        ? chatResponseModel(requestedModel, responseModel, {
            userId,
            key: s.key,
          })
        : responseModel;
    const resultUsage = result.ok
      ? result.value.usage
      : failedDialogueUsage(result.error);
    const tokens = useDialogue ? resultUsage : spend.usage(resultUsage);
    if (tokens?.models) log.info('Token usage by model', tokens.models);
    const finalUsage = openAiUsageToWire(tokens, model);
    if (failure) {
      out.writeHead(failure.status);
      out.end(
        JSON.stringify({
          ...openAiRunError(failure),
          ...(finalUsage && { usage: finalUsage }),
        }),
      );
      return;
    }

    const resultLimit = result.ok ? undefined : throttleOf(result.error);
    const resultUnverified = result.ok
      ? undefined
      : unverifiedWriteFor(handle, traceId, result.error);
    const finalContent = result.ok
      ? result.value.content || '(no response)'
      : resultLimit
        ? throttleMessage(resultLimit, resultUnverified)
        : (resultUnverified ?? `Error: ${result.error.message}`);

    const responseToolCalls = result.ok ? result.value.toolCalls : undefined;
    if (responseToolCalls?.length)
      await rememberClientToolTurn(
        s,
        historyTurn?.id,
        responseToolCalls.map((call) => call.id),
      );

    // Save conversation turn to server session
    if (
      result.ok &&
      !opts.signal?.aborted &&
      finalContent !== '(no response)'
    ) {
      const lastUser = normalizedMessages
        .filter((m) => m.role === 'user')
        .slice(-1)[0];
      if (lastUser) {
        appendToSession(sessionId, userId, lastUser, {
          role: 'assistant',
          content: finalContent,
        } as Message);
        if (
          historyTurn &&
          !historyTurn.recorded &&
          !hasPendingClientTools(result.value)
        )
          recordTurn(
            boundCaller.value,
            lastUser,
            finalContent,
            historyTurn.id,
            ...(s ? [s] : []),
          );
      }

      // NOTE: state store upsert removed (non-streaming path) — same as streaming.
    }

    if (
      requestMeasurement(req) &&
      result.ok &&
      /\S/.test(finalContent) &&
      finalContent !== '(no response)' &&
      !out.detached
    )
      requestMeasurement(req)?.deliverOnResponseEnd();
    out.writeHead(200, {
      'Content-Type': 'application/json',
      ...invalidToolsHeader,
    });
    out.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content:
                responseToolCalls?.length && result.ok
                  ? result.value.content || null
                  : finalContent,
              ...(responseToolCalls?.length
                ? { tool_calls: responseToolCalls }
                : {}),
            },
            finish_reason: responseToolCalls?.length
              ? 'tool_calls'
              : finalFinishReason,
          },
        ],
        usage: finalUsage ?? emptyOpenAiUsage,
      }),
    );
  } catch (error) {
    const failure = typedFailure(error);
    if (failure && typeof error === 'object' && error !== null)
      capturedFailures.set(error, failure);
    throw error;
  } finally {
    collections?.restore();
    // The pipeline has returned, so it starts no more calls. Wait for the ones it
    // started, then end the ADT session, then give the slot back — last.
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

/**
 * GET /v1/models
 *
 * Returns available LLM models from SAP AI Core in OpenAI format.
 * Includes _meta with agent configuration for UI system bar.
 */
export async function handleModels(
  _req: Request,
  res: Response,
): Promise<void> {
  await ensureModelCatalog();
  const log = cds.log('openai-handler/models');
  const config = getAgentConfig();
  const activeModel = getCurrentModel();
  const ownedBy =
    config.llm.provider === 'sap-ai-sdk' ? 'sap-ai-core' : config.llm.provider;

  let models: {
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }[];
  try {
    models = usesModelCatalog()
      ? [...parseModelAllowlist()].map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: ownedBy,
        }))
      : await getAvailableModels(config.llm);
  } catch (err) {
    log.warn('Failed to fetch provider models, returning active model only', {
      error: err instanceof Error ? err.message : String(err),
    });
    models = [
      { id: activeModel, object: 'model', created: 0, owned_by: ownedBy },
    ];
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'list',
      data: models,
      // Extension: active model + agent meta for UI
      _agent_ready: isAgentReady(),
      _active_model: activeModel,
      _active_destination: getCurrentDestination(),
      _destinations: getDestinationStates(),
      _destination_discovery: getDestinationDiscoveryState(),
      _meta: {
        capabilities: capabilitiesFor(parseModelAllowlist()),
        temperature: config.llm.temperature ?? 'off',
        max_tokens: config.llm.maxTokens,
        mode: config.agent.mode,
        max_iterations: config.agent.maxIterations,
        rag_type: config.agent.ragType,
        rag_backends: config.rag.backends,
        mcp_destination: config.mcp.destination,
        classifier_model: getCurrentClassifierModel(),
        planner_model: getCurrentPlannerModel(),
        embedding_model: config.rag.embedder?.model ?? null,
      },
    }),
  );
}

/**
 * GET /v1/usage
 */
export async function handleUsage(_req: Request, res: Response): Promise<void> {
  try {
    const handle = await getSmartAgent();
    const summary = handle.requestLogger?.getSummary?.() ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(jsonError(error.message, 'server_error'));
  }
}
