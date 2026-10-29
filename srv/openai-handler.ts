import { type ChatStream, chatStream, streamDialogue } from './lib/chat-stream';
import { collectionRetrieval } from './lib/collection-retrieval';
import { lookupDialogue } from './lib/dialogue-sessions';
import { requestStart } from './lib/request-start';
import {
  measureRequest,
  requestMeasurement,
} from './lib/usage/request-records';
import { responseUsageToWire } from './lib/usage-wire';
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
import { detachedSink } from './lib/detached-sink';
import { dialogueChat } from './lib/dialogue-chat';
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
import { extractText, recordTurn } from './lib/session-turns';
import {
  destinationClosedText,
  openAiDoorRefusal,
  openAiSessionClosed,
  openAiSessionRunRefusal,
  type RecMcpHandle,
  throttleMessage,
  throttleOf,
  unverifiedWriteFor,
} from './lib/throttle-surfacing';
import { usageRuntime } from './lib/usage/runtime';
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
  return r === 'stop' ? 'stop' : 'length';
}

function jsonError(message: string, type: string): string {
  return JSON.stringify({ error: { message, type } });
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

/**
 * Trim messages for SmartAgent context to prevent context window overflow.
 *
 * Strategy:
 * - ALL assistant messages are truncated (MCP tool outputs can be enormous)
 * - Older assistant messages: aggressive limit (200 chars)
 * - Recent assistant messages (last pair): moderate limit (500 chars)
 * - User messages: kept intact (they're short prompts)
 * - Total history budget: 6000 chars max — if exceeded, drop oldest pairs
 * - Remove [SmartAgent: Executing ...] progress markers from all messages
 */
function trimHistoryForContext(messages: Message[]): Message[] {
  const TOTAL_BUDGET = 6000;
  const OLDER_ASSISTANT_LIMIT = 200;
  const RECENT_ASSISTANT_LIMIT = 500;

  if (messages.length <= 2) return messages;

  // Separate system messages (must be preserved for client adapter detection)
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Clean all assistant messages: remove progress markers + truncate
  const cleaned = nonSystem.map((m, i) => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return m;

    let content = m.content.replace(
      /\n\n\[SmartAgent: Executing [^\]]+\.\.\.\]\n/g,
      '',
    );

    // Last assistant message gets moderate limit, older ones get aggressive limit
    const isLastAssistant =
      i ===
      nonSystem.length -
        1 -
        [...nonSystem].reverse().findIndex((msg) => msg.role === 'assistant');
    const limit = isLastAssistant
      ? RECENT_ASSISTANT_LIMIT
      : OLDER_ASSISTANT_LIMIT;

    if (content.length > limit) {
      content = `${content.slice(0, limit)}... [truncated]`;
    }
    return { ...m, content };
  });

  // Check total size (excluding system) — drop oldest if over budget
  let totalChars = cleaned.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );

  let result = cleaned;
  while (totalChars > TOTAL_BUDGET && result.length > 2) {
    const dropped = result[0];
    const droppedLen =
      typeof dropped.content === 'string' ? dropped.content.length : 0;
    result = result.slice(1);
    totalChars -= droppedLen;
  }

  // Re-attach system messages at the front
  return [...systemMessages, ...result];
}

// ---------------------------------------------------------------------------
// OpenAI request types
// ---------------------------------------------------------------------------

interface OpenAIChatRequest {
  messages: Array<{
    role: string;
    content: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  }>;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  model?: string;
  /** Accepted but ignored — classifier is driven by LLM_AGENT_CLASSIFIER_MODEL env var. */
  classifier_model?: string;
  // Backward-compatible no-op: llm-agent 5.15 no longer exposes a presentation stage.
  presentation_model?: string;
}

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
  requestStart(req);
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('request') && !runtime.enabled('session')))
    return handleChatCompletionsMeasured(req, res);
  return handleChatCompletionsWithUsage(req, res);
}

async function handleChatCompletionsWithUsage(
  req: Request,
  res: Response,
): Promise<void> {
  const body: { stream?: boolean } | undefined = req.body;
  const measurement = measureRequest(
    req,
    res,
    { userId: getUserId(), sessionId: sessionIdOf(req) ?? '' },
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
      body = req.body as OpenAIChatRequest;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
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

  // A long session serves its requests one at a time, through the connection
  // it holds; without one the request stands alone, as it always has.
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
  try {
    const continuation = s
      ? await longSessions().run(
          s,
          () => serveChatCompletions(req, res, body, userMessages, s, early),
          () => early?.ensureStream(),
        )
      : await serveChatCompletions(
          req,
          res,
          body,
          userMessages,
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
  userMessages: OpenAIChatRequest['messages'],
  s?: LongSession,
  early?: ChatStream,
): Promise<(() => Promise<void>) | void> {
  const log = cds.log('openai-handler');
  const dialogueMode = getAgentConfig().agent.chatCoordinator === 'dialogue';

  // Validate and normalize external tools (passed to SmartAgent for client adapter detection)
  const externalToolsValidation = normalizeAndValidateExternalTools(body.tools);
  const externalTools = externalToolsValidation.tools;
  if (externalToolsValidation.errors.length > 0) {
    log.debug('Invalid external tools detected', {
      count: externalToolsValidation.errors.length,
    });
  }

  const traceId = requestMeasurement(req)?.traceId ?? randomUUID();
  // A session the caller presented and we kept. A freshly minted one is not
  // explicit: a stateless API client sending its full history must never be
  // truncated to its last message.
  const explicitSessionId = honouredSessionId(req);
  const sessionId =
    sessionIdOf(req) ?? (requestMeasurement(req) ? traceId : randomUUID());
  const t0 = requestStart(req);

  // Two modes of history management:
  // 1. Server-managed session (our browser UI): an explicit session (header/cookie) is present,
  //    so the client sends only the new message and the server prepends its stored history.
  // 2. Client-managed history (OpenAI/API clients like Cline): no explicit session, client sends
  //    full history. A freshly-MINTED cookie id (first browser request, no cookie yet) is NOT
  //    explicit → client-history mode, so stateless API clients sending full `messages` are
  //    never silently truncated to just the last message.
  const serverManaged = !!explicitSessionId;

  // Resolve user identity early — needed for user-keyed session store lookups below.
  const userId = getUserId();

  // The caller's permissions, resolved ONCE and used for two different jobs:
  // the RAG filter (which tools are offered) and the ALS binding (which tools
  // may actually run). They must agree, so they come from the same value.
  const caller = describeCaller(cds.context?.user);
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

  if (serverManaged) {
    // Server session mode: extract last user message, prepend server history
    const lastUserContent = extractText(
      userMessages[userMessages.length - 1].content,
    );
    const newUserMessage: Message = { role: 'user', content: lastUserContent };
    const serverHistory = getSessionHistory(sessionId, userId);
    normalizedMessages = [...serverHistory, newUserMessage];
  } else {
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

    // NOTE: We deliberately do NOT mirror `normalizedMessages` into `sessionStore` here.
    // The response path below calls `appendToSession(sessionId, newUser, assistant)`, which
    // already persists the turn. Mirroring would store `newUser` twice (mirror + append),
    // so the next request (e.g. browser carrying the just-minted cookie) would prepend a
    // polluted history with a duplicated first user message. For explicit-session API
    // clients this branch never runs (serverManaged uses sessionStore via getSessionHistory).
  }

  // Trim history to prevent context overflow
  const rawHistorySize = normalizedMessages.length;
  normalizedMessages = trimHistoryForContext(normalizedMessages);

  log.info('Chat completions request', {
    stream: body.stream ?? false,
    traceId,
    sessionId,
    mode: serverManaged ? 'server-session' : 'client-history',
    rawHistorySize,
    historySize: normalizedMessages.length,
    roles: normalizedMessages.map((m) => m.role).join(','),
    userMessage: normalizedMessages
      .filter((m) => m.role === 'user')
      .slice(-1)[0]
      ?.content?.toString()
      .slice(0, 200),
  });

  // Get SmartAgent handle (pass model/destination to trigger switch if needed)
  const requestedModel =
    typeof body.model === 'string' ? body.model : undefined;
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;

  // Track destination before/after to detect switches
  const destBefore = getCurrentDestination(userId, sessionId);
  const destAfter = requestedDestination || s?.destination || destBefore;
  const useDialogue = dialogueMode && !!s && !!destAfter;
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

  early?.ensureStream({
    'X-SAP-Active-Destination': destAfter,
    ...(externalToolsValidation.errors.length
      ? {
          'x-smartagent-invalid-tools': String(
            externalToolsValidation.errors.length,
          ),
        }
      : {}),
  });

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
  const callerLeft = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    log.info('Caller disconnected; the session runs to its end', { sessionId });
    out.detach();
    callerLeft.abort(new Error('caller disconnected'));
  });

  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    // Use destAfter (header OR session/default) — the same destination the
    // connection was established for. requestedDestination alone is undefined
    // for session-scoped chats, which would fall to the configured default.
    handle = await getSmartAgent(requestedModel, destAfter);
  } catch (err) {
    await releaseRequestConnection(requestConnection, s);
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

  const chatAgent =
    useDialogue && s
      ? dialogueChat(req, userId, s, destAfter, res, {
          headers: req.headers,
          body,
        })
      : handle.agent;

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
        sessionId: sessionId ?? traceId,
        userId,
        destination: destAfter,
      })
      .with({ requestId: traceId, traceId });
    requestMeasurement(req)?.bind(usage);
    // The parsed body: a raw request carries it only in `body`, not `req.body`.
    if (collections) {
      const retrieval = await collections.retrieve(
        { headers: req.headers, body },
        normalizedMessages,
        userId,
        sessionId,
        log,
        res.headersSent,
        usage,
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
      sessionId,
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
        logStep(name: string, data: unknown) {
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

    const invalidToolsHeader: Record<string, string> =
      externalToolsValidation.errors.length > 0
        ? {
            'x-smartagent-invalid-tools': String(
              externalToolsValidation.errors.length,
            ),
          }
        : {};

    if (body.stream && useDialogue && early) {
      let assistant: Message | undefined;
      const lastUser = normalizedMessages
        .filter((m) => m.role === 'user')
        .at(-1);
      let following = false;
      return await streamDialogue({
        stream: early,
        protocol: 'openai',
        model: getCurrentModel(),
        agent: chatAgent as ReturnType<typeof dialogueChat>,
        source: chatAgent.streamProcess(normalizedMessages, opts),
        run: (fn) =>
          pipeline.run(() =>
            runWithSessionId(sessionId, fn, priorTurns, userId),
          ),
        maxMs: getAgentConfig().agent.dialogue?.followMaxMs ?? 1_800_000,
        onError: (error) => {
          if (isOutageError(error))
            closeDestination(destAfter, describeCause(error));
          return {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'server_error',
            },
          };
        },
        onTurnEnd: (text, hasFollow) => {
          following = hasFollow;
          if (lastUser) {
            if (text) assistant = { role: 'assistant', content: text };
            appendToSession(
              sessionId,
              userId,
              lastUser,
              ...(assistant ? [assistant] : []),
            );
            if (!following) recordTurn(sessionId, userId, lastUser, text);
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
          if (following && lastUser)
            recordTurn(sessionId, userId, lastUser, text);
        },
      });
    }

    // --- Streaming ---
    if (body.stream) {
      out.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-SAP-Active-Destination': destAfter,
        ...invalidToolsHeader,
      });

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
        out.write(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      res.on('close', () => clearInterval(keepAlive));

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      let firstChunk = true;
      let chunkCount = 0;
      let finishReasonSent = false;
      let accumulatedContent = ''; // Accumulate full response for session history
      let lastUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        models?: Record<string, unknown>;
      } | null = null;

      log.info('Starting streamProcess', { sessionId });

      // Bind the active session id into AsyncLocalStorage so the RAG tool dispatcher
      // (rag_add / rag_correct / rag_deprecate) can resolve against the current session.
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
                inRequestSystem(async () => {
                  const stream = chatAgent.streamProcess(
                    normalizedMessages,
                    opts,
                  );

                  try {
                    for await (const chunk of stream) {
                      chunkCount++;
                      if (!chunk.ok) {
                        requestMeasurement(req)?.end('error');
                        const err = chunk.error;
                        if (isOutageError(chunk.error)) {
                          closeDestination(
                            destAfter,
                            describeCause(chunk.error),
                          );
                        }

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
                        const userMessage = unverified
                          ? limit
                            ? `${unverified} ${throttleMessage(limit)}`
                            : unverified
                          : limit
                            ? throttleMessage(limit)
                            : err.message;
                        out.write(
                          `data: ${jsonError(userMessage, 'server_error')}\n\n`,
                        );
                        break;
                      }

                      const v = chunk.value;
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
                        out.write(
                          `: heartbeat ${JSON.stringify(v.heartbeat)}\n\n`,
                        );
                        continue;
                      }
                      if (v.status) {
                        out.write(`: status ${JSON.stringify(v.status)}\n\n`);
                        continue;
                      }
                      if (v.usage) {
                        lastUsage = {
                          prompt_tokens: v.usage.promptTokens,
                          completion_tokens: v.usage.completionTokens,
                          total_tokens: v.usage.totalTokens,
                          ...(v.usage.models ? { models: v.usage.models } : {}),
                        };
                      }
                      if (v.timing) {
                        log.info('Pipeline stage timing', { timing: v.timing });
                        continue;
                      }

                      const baseResponse = {
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: getCurrentModel(),
                        usage: null,
                      };

                      // First chunk: role + initial content (matches SmartServer)
                      if (firstChunk) {
                        const initialContent = v.content || '';
                        if (initialContent)
                          accumulatedContent += initialContent;
                        out.write(
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
                      if (v.content || v.toolCalls) {
                        const delta: Record<string, unknown> = {};
                        if (v.content) {
                          accumulatedContent += v.content;
                          delta.content = v.content;
                        }
                        if (v.toolCalls) {
                          delta.tool_calls = v.toolCalls.map((call, index) => {
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
                          });
                        }
                        out.write(
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
                        out.write(
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
                  } catch (err) {
                    requestMeasurement(req)?.end('error');
                    if (isOutageError(err)) {
                      closeDestination(destAfter, describeCause(err));
                    }
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
                    const userMessage = streamUnverified
                      ? streamLimit
                        ? `${streamUnverified} ${throttleMessage(streamLimit)}`
                        : streamUnverified
                      : streamLimit
                        ? throttleMessage(streamLimit)
                        : errMsg;
                    out.write(
                      `data: ${jsonError(userMessage, 'server_error')}\n\n`,
                    );
                  }

                  // Log per-model token breakdown if available (inside runWithSessionId so TS
                  // can track lastUsage mutations; this is pure logging with no ordering concern).
                  if (lastUsage?.models) {
                    log.info('Token usage by model', lastUsage.models);
                  }
                }),
            ),
          priorTurns,
          userId,
        ),
      );
      // end runWithSessionId / runWithRequestConnection / pipeline.run

      // Ensure finish_reason is always sent — clients require it to detect stream end
      if (!finishReasonSent) {
        out.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: getCurrentModel(),
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
      if (lastUsage) {
        out.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: getCurrentModel(),
            choices: [],
            usage: lastUsage,
          })}\n\n`,
        );
      }

      log.info('Stream completed', {
        chunkCount,
        hasUsage: !!lastUsage,
        durationMs: Date.now() - t0,
        responseLength: accumulatedContent.length,
      });

      // Save conversation turn to server session
      if (accumulatedContent) {
        const lastUser = normalizedMessages
          .filter((m) => m.role === 'user')
          .slice(-1)[0];
        if (lastUser) {
          appendToSession(sessionId, userId, lastUser, {
            role: 'assistant',
            content: accumulatedContent,
          } as Message);
          recordTurn(sessionId, userId, lastUser, accumulatedContent);
          const updatedHistory = getSessionHistory(sessionId, userId);
          log.debug('Session updated', {
            sessionId,
            storedMessages: updatedHistory.length,
            responseChars: accumulatedContent.length,
          });
        }

        // NOTE: state store upsert removed — llm-agent 6.0 has no default state store.
        // Session history managed by SessionManager + history RAG (session-scoped).
      }

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
      out.write('data: [DONE]\n\n');
      out.end();
      return;
    }

    // --- Non-streaming (with rate-limit retry) ---
    // Bind the active session id into AsyncLocalStorage so the RAG tool dispatcher
    // (rag_add / rag_correct / rag_deprecate) can resolve against the current session.
    // The wrapper encloses the whole retry block so the context stays alive across retries.
    const result = await pipeline.run(() =>
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
      ),
    );

    log.info('Chat completions done', {
      ok: result.ok,
      durationMs: Date.now() - t0,
    });

    if (!result.ok) requestMeasurement(req)?.end('error');
    if (!result.ok && isOutageError(result.error)) {
      closeDestination(destAfter, describeCause(result.error));
    }

    const resultLimit = result.ok ? undefined : throttleOf(result.error);
    const resultUnverified = result.ok
      ? undefined
      : unverifiedWriteFor(handle, traceId, result.error);
    const finalContent = result.ok
      ? result.value.content || '(no response)'
      : resultUnverified
        ? resultLimit
          ? `${resultUnverified} ${throttleMessage(resultLimit)}`
          : resultUnverified
        : resultLimit
          ? throttleMessage(resultLimit)
          : `Error: ${result.error.message}`;

    const finalFinishReason = result.ok
      ? mapStopReason(result.value.stopReason)
      : 'stop';

    let finalUsage = null;
    if (result.ok && result.value.usage) {
      finalUsage = {
        prompt_tokens: result.value.usage.promptTokens,
        completion_tokens: result.value.usage.completionTokens,
        total_tokens: result.value.usage.totalTokens,
        ...(result.value.usage.models
          ? { models: result.value.usage.models }
          : {}),
      };
    }

    // Save conversation turn to server session
    if (result.ok && finalContent !== '(no response)') {
      const lastUser = normalizedMessages
        .filter((m) => m.role === 'user')
        .slice(-1)[0];
      if (lastUser) {
        appendToSession(sessionId, userId, lastUser, {
          role: 'assistant',
          content: finalContent,
        } as Message);
        recordTurn(sessionId, userId, lastUser, finalContent);
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
        model: getCurrentModel(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: finalFinishReason,
          },
        ],
        usage: (useDialogue && result.ok
          ? responseUsageToWire(result.value.usage)
          : finalUsage) || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
    );
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
      (handle as unknown as RecMcpHandle)?.recMcp?.dropRequest(traceId);
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
  const log = cds.log('openai-handler/models');
  const config = getAgentConfig();
  const activeModel = getCurrentModel();

  let models: {
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }[];
  try {
    models = await getAvailableModels(config.llm);
  } catch (err) {
    log.warn('Failed to fetch AI Core models, returning active model only', {
      error: err instanceof Error ? err.message : String(err),
    });
    models = [
      { id: activeModel, object: 'model', created: 0, owned_by: 'sap-ai-core' },
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
        temperature: config.llm.temperature,
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
