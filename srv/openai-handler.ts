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
  findThrottled,
  type Message,
  normalizeAndValidateExternalTools,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig, isAiCoreConfigured } from './agent-config';
import {
  clearSessionTopic,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getCurrentClassifierModel,
  getCurrentDestination,
  getCurrentModel,
  getDestinationStates,
  getSharedHistoryRag,
  getSmartAgent,
  isAgentReady,
  runWithRequestConnection,
  setSessionDestination,
} from './agent-manager';
import { resolveRouteId } from './collection-ids';
import { getAvailableModels } from './lib/ai-core-models';
import { describeCaller, type ExpositionLevel } from './lib/exposition';
import { establishRequestConnection, safeStop } from './lib/request-connection';
import { turnOwner } from './lib/session-history-rag';
import { runWithSessionId } from './request-session';
import { resolveSessionId } from './session-id';

/** Get authenticated user ID from CAP context (XSUAA JWT or mocked auth) */
function getUserId(): string {
  return cds.context?.user?.id || 'anonymous';
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
 * `recMcp` is attached to the handle at runtime (agent-manager.ts) but is not
 * part of the library's `SmartAgentHandle` type — optional, since an
 * LLM-only handle (no destination) has no per-destination recMcp.
 */
interface HandleWithRecMcp {
  recMcp?: { dropRequest(traceId?: string): void };
}

/**
 * Run `fn` with the per-request SAP connection bound for its whole async subtree
 * (so MCP tool calls inside the agent pipeline see it). When there is no
 * per-request connection (LLM-only / no destination), run `fn` directly.
 */
function withRequestConnection<T>(
  connection: import('@mcp-abap-adt/interfaces').IAbapConnection | undefined,
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

/**
 * Was this a rate limit, and for how long?
 *
 * The provider answers 429 itself since llm-agent 22.2.0: it backs off, honours
 * `Retry-After`, and holds one shared pause per quota so concurrent callers do
 * not each rediscover the same closed limit. By the time an error reaches this
 * handler that policy is spent, and the error says so — `findThrottled` reads
 * the fact off the error or its cause chain.
 *
 * Retrying here would undo the point of the shared pause: another request into
 * a quota the server has just said is closed, earning another penalty.
 */
export function throttleOf(
  error: unknown,
): { retryAfterSeconds?: number; reason?: string } | undefined {
  const marked = findThrottled(error);
  if (marked) {
    return {
      retryAfterSeconds: marked.retryAfterSeconds,
      reason: marked.reason,
    };
  }
  // Fallback for an error that lost the marker on the way up, e.g. one rebuilt
  // by a layer that keeps only the message. A structured status first, then the
  // status named in the text on a WORD BOUNDARY — never a bare includes('429'),
  // which also fires on an id, a byte count or a token total.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const http = current as {
      response?: { status?: number };
      status?: number;
      statusCode?: number;
    };
    if (
      http?.response?.status === 429 ||
      http?.status === 429 ||
      http?.statusCode === 429
    ) {
      return {};
    }
    const text = current instanceof Error ? current.message : String(current);
    if (
      /(^|[^\d])429([^\d]|$)|too many requests|rate[\s_-]?limit/i.test(text)
    ) {
      return {};
    }
    if (!(current instanceof Error)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** What the caller is told once the provider's own policy is spent. */
export function throttleMessage(limit: { retryAfterSeconds?: number }): string {
  const seconds = limit.retryAfterSeconds;
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return 'The AI service is rate-limited right now. Please try again shortly.';
  }
  return `The AI service is rate-limited right now. Please try again in about ${Math.ceil(
    seconds,
  )} seconds.`;
}

/** Extract plain text from OpenAI content (string | content-block array) */
function extractText(c: unknown): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter(
      (b: unknown) =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: string }).text === 'string',
    )
    .map((b: { text: string }) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Server-side session history
// ---------------------------------------------------------------------------

/** Max messages kept in server session (before SmartAgent's own summarization) */
const SESSION_MAX_MESSAGES = 20;

/** Session TTL: 30 minutes of inactivity */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval: every 5 minutes */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
  messages: Message[];
  lastAccess: number;
}

/**
 * Session store keyed by `${userId}\u0000${sessionId}`.
 *
 * Deliberately NOT keyed by sessionId alone: two BTP users that happen to
 * share or collide on the same session id (header spoofing, cookie theft,
 * UUID collision) must never share chat history. Scoping by userId makes
 * cross-user reads impossible by construction.
 */
const sessionStore = new Map<string, SessionEntry>();

/** Composite key that isolates sessions by user identity. */
function sessionStoreKey(sessionId: string, userId: string): string {
  return `${userId}\u0000${sessionId}`;
}

/** Periodic cleanup of expired sessions. `.unref()` so the timer doesn't keep the
 *  Node process (or Jest workers) alive after everything else exits. */
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionStore) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

/** Get session history for a specific user. Returns empty array if none. */
export function getSessionHistory(
  sessionId: string,
  userId: string,
): Message[] {
  const entry = sessionStore.get(sessionStoreKey(sessionId, userId));
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  return [];
}

/** Append messages to session history for a specific user, trimming to max size */
export function appendToSession(
  sessionId: string,
  userId: string,
  ...msgs: Message[]
): void {
  const key = sessionStoreKey(sessionId, userId);
  let entry = sessionStore.get(key);
  if (!entry) {
    entry = { messages: [], lastAccess: Date.now() };
    sessionStore.set(key, entry);
  }
  entry.lastAccess = Date.now();
  entry.messages.push(...msgs);

  // Keep only last N messages
  if (entry.messages.length > SESSION_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SESSION_MAX_MESSAGES);
  }
}

/**
 * Store the completed turn for semantic recall, beside the verbatim store.
 *
 * The two answer different questions. `appendToSession` keeps the last turns
 * word for word, which is what resolves "that domain" on the very next
 * message. This one survives the recency window: many turns later, when the
 * wording is gone, a similar question still finds what the object was called.
 *
 * Fire-and-forget on purpose. The answer has already been sent; a failure to
 * remember it must not surface as an error on a request that succeeded.
 */
function recordTurnForRecall(
  sessionId: string,
  userId: string,
  lastUser: Message,
  answer: string,
): void {
  const rag = getSharedHistoryRag();
  if (!rag) return;
  const question = extractText(lastUser.content);
  if (!question || !answer) return;
  void rag
    .recordTurn({
      owner: turnOwner(userId, sessionId),
      userText: question,
      assistantText: answer,
    })
    .catch(() => {});
}

/** Clear session history for a specific user */
export function clearSession(sessionId: string, userId: string): void {
  sessionStore.delete(sessionStoreKey(sessionId, userId));
  // The recall store holds the same conversation in another shape. Clearing one
  // and leaving the other would let a cleared session keep answering from turns
  // the user believes they deleted.
  void getSharedHistoryRag()
    ?.forgetOwner(turnOwner(userId, sessionId))
    .catch(() => {});
}

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
export async function handleChatCompletions(
  req: Request,
  res: Response,
): Promise<void> {
  const log = cds.log('openai-handler');

  // Block requests when agent is not available
  if (!isAgentReady()) {
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

  // Validate and normalize external tools (passed to SmartAgent for client adapter detection)
  const externalToolsValidation = normalizeAndValidateExternalTools(body.tools);
  const externalTools = externalToolsValidation.tools;
  if (externalToolsValidation.errors.length > 0) {
    log.debug('Invalid external tools detected', {
      count: externalToolsValidation.errors.length,
    });
  }

  const traceId = randomUUID();
  // Prefer the session id already stashed by the session middleware; otherwise resolve from
  // headers/cookie directly (handles cases where the middleware ran before us).
  // An EXPLICIT session is one the client actually sent — `x-session-id`/`mcp-session-id`
  // header or the `clh_session` cookie. `resolveSessionId` returns only that (it never mints).
  const explicitSessionId = resolveSessionId(req);
  // Session id used for history + RAG keying: the middleware-stashed id (explicit, or the
  // freshly-minted cookie id), falling back defensively if the middleware didn't run.
  const sessionId =
    (req as Request & { sessionId?: string }).sessionId ??
    explicitSessionId ??
    randomUUID();
  const t0 = Date.now();

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
    connection: import('@mcp-abap-adt/interfaces').IAbapConnection | undefined,
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
  const destBefore = getCurrentDestination(sessionId);
  const destAfter = requestedDestination || destBefore;
  let requestConnection:
    | import('@mcp-abap-adt/interfaces').IAbapConnection
    | undefined;
  let requestDumpScope: import('./lib/principal').DumpScope | undefined;

  log.debug('Destination tracking', {
    sessionId,
    destBefore,
    destAfter,
    requestedDestination: requestedDestination || '(none)',
  });

  if (destAfter) {
    const established = await establishRequestConnection(req, res, destAfter);
    if (established.handled) return;
    requestConnection = established.connection;
    requestDumpScope = established.dumpScope;
  }

  // Client abort/disconnect mid-request must still release the ADT edit-lock
  // (the SM12 orphaned-lock symptom). `req`'s `close` event fires once the
  // request body is consumed — NOT reliably on client abort — so tearing down
  // the connection there can cut an in-flight tool call. `res`'s `close`
  // fires when the underlying connection is closed; guarding with
  // `!res.writableEnded` narrows it to a genuine early client disconnect
  // (the response hadn't finished yet). safeStop is idempotent, so this
  // racing with the handler's own `finally` teardown below is safe either order.
  res.on('close', () => {
    if (!res.writableEnded) {
      void safeStop(requestConnection);
    }
  });

  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    // Use destAfter (header OR session/default) — the same destination the
    // connection was established for. requestedDestination alone is undefined
    // for session-scoped chats, which would fall to the configured default.
    handle = await getSmartAgent(requestedModel, destAfter);
  } catch (err) {
    await safeStop(requestConnection);
    const message = err instanceof Error ? err.message : String(err);
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
        const { classifyProbe } = await import('./lib/probe-classifier');
        // Pull the cached destination state through the public listing so
        // we don't widen agent-manager's surface; status carries the
        // last-known raw error if any.
        const { getDestinationStates } = await import('./agent-manager');
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

  // Track which destination this session is using. A changed destination is a
  // reconnect boundary: wipe session-scoped state before continuing.
  setSessionDestination(sessionId, destAfter);
  if (destBefore !== destAfter && serverManaged) {
    log.info('Destination reconnect, clearing session history', {
      from: destBefore,
      to: destAfter,
      sessionId,
    });
    clearSession(sessionId, userId);
    clearSessionTopic(sessionId);
    // Drop the session's ephemeral RAG collections too (owner-guarded), so they
    // don't keep shadowing user collections after a destination reconnect.
    getCollectionRegistry().deleteSessionCollections(userId, sessionId);
    // Re-build normalizedMessages with only the new user message (no stale history)
    const lastUserContent = extractText(
      userMessages[userMessages.length - 1].content,
    );
    normalizedMessages = [{ role: 'user', content: lastUserContent }];
  }

  // Inject dynamic RAG collections from X-Rag-Collections header or body
  const ragCollectionIds: string[] = (() => {
    const header = req.headers['x-rag-collections'] as string | undefined;
    if (header)
      return header
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    // biome-ignore lint/suspicious/noExplicitAny: rag_collections is an extension field not in OpenAI spec
    const bodyCollections = (body as any).rag_collections;
    if (Array.isArray(bodyCollections)) return bodyCollections;
    return [];
  })();

  // Resolve each entry: bare logical names → caller's own physical id; physical ids
  // owned by another user → dropped. Session collection shadows user collection.
  // Done once here and reused by both the RAG store injection and semantic search below.
  const resolvedCollectionIds: string[] =
    ragCollectionIds.length > 0
      ? (() => {
          const registry = getCollectionRegistry();
          return ragCollectionIds
            .map((entry) =>
              resolveRouteId(registry, entry, getUserId(), sessionId, false),
            )
            .filter((id): id is string => id !== undefined);
        })()
      : [];

  // Inject dynamic RAG collections per-request (save/restore pattern).
  // Wrapped with ExpositionFilteringRag because ragFilter namespace won't match.
  // biome-ignore lint/suspicious/noExplicitAny: access internal deps for RAG injection
  const deps = (handle.agent as any).deps;
  const originalRagStores = deps.ragStores;
  if (resolvedCollectionIds.length > 0) {
    const registry = getCollectionRegistry();
    const dynamicStores = registry.getRagStores(resolvedCollectionIds);
    const injected = Object.keys(dynamicStores);
    if (injected.length > 0) {
      const mergedStores = { ...originalRagStores };
      for (const [key, store] of Object.entries(dynamicStores)) {
        mergedStores[key] = new ExpositionFilteringRag(store);
      }
      deps.ragStores = mergedStores;
      log.info('Dynamic RAG collections injected', {
        requested: ragCollectionIds,
        resolved: resolvedCollectionIds,
        injected,
      });
    }
  }

  // Restore original ragStores after request completes (finally block at end of function)
  const restoreRagStores = () => {
    if (deps.ragStores !== originalRagStores)
      deps.ragStores = originalRagStores;
  };

  // Semantic search across active RAG collections and inject relevant results.
  // llm-agent hardcoded flow only queries RAG for "action" subprompts —
  // chat questions classified as "chat" → RAG skipped. We do our own search.
  if (resolvedCollectionIds.length > 0) {
    const registry = getCollectionRegistry();
    const userMessage = normalizedMessages
      .filter((m) => m.role === 'user')
      .slice(-1)[0];
    const queryText =
      typeof userMessage?.content === 'string' ? userMessage.content : '';

    if (queryText) {
      // Search user collections in the ORIGINAL language (no translation).
      // User content may be in any language — translating the query would
      // break matching (e.g., Ukrainian query → English translation won't
      // match Ukrainian anecdote in vector space).
      // Tool selection has its own _toEnglishForRag() in llm-agent.
      const { QueryEmbedding, TextOnlyEmbedding } = await import(
        '@mcp-abap-adt/llm-agent'
      );
      const embedding = deps.embedder
        ? new QueryEmbedding(queryText, deps.embedder)
        : new TextOnlyEmbedding(queryText);

      const relevantTexts: string[] = [];
      for (const colId of resolvedCollectionIds) {
        const store = registry.getRagStore(colId);
        if (!store) continue;
        const result = await new ExpositionFilteringRag(store).query(
          embedding,
          3,
        );
        if (result.ok) {
          for (const r of result.value) {
            log.info('RAG search result', {
              collection: colId,
              score: r.score.toFixed(4),
              preview: r.text.slice(0, 80),
            });
            const threshold = Number(process.env.RAG_SCORE_THRESHOLD) || 0.15;
            if (r.score >= threshold) {
              relevantTexts.push(r.text);
            }
          }
        }
      }

      if (relevantTexts.length > 0) {
        const ragContext = relevantTexts.join('\n---\n');
        let lastUserIdx = -1;
        for (let i = normalizedMessages.length - 1; i >= 0; i--) {
          if (normalizedMessages[i].role === 'user') {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          const original = normalizedMessages[lastUserIdx];
          const originalContent =
            typeof original.content === 'string' ? original.content : '';
          normalizedMessages = [...normalizedMessages];
          normalizedMessages[lastUserIdx] = {
            ...original,
            content: `${originalContent}\n\n[Context from knowledge base — answer based on this, in your own words]\n${ragContext}`,
          };
        }
        log.info('RAG semantic search results injected', {
          collections: resolvedCollectionIds,
          resultCount: relevantTexts.length,
          contextChars: ragContext.length,
        });
      }
    }
  }

  try {
    const pipelineLog = cds.log('smart-pipeline');
    const opts = {
      stream: body.stream,
      // External tools (attempt_completion, read_file, etc.) from client — passed to SmartAgent
      // for ClineClientAdapter detection and external tool_call routing.
      externalTools,
      sessionId,
      // RAG filtering: namespace isolates user/destination data, exposition filters tools by role.
      // ExpositionFilteringRag strips namespace (tools have none) and post-filters by exposition.
      ragFilter: {
        namespace: `${userId}:${destAfter}`,
        exposition: callerExposition,
      },
      trace: { traceId },
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

    // --- Streaming ---
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
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
        if (!res.writableEnded) res.write(': keep-alive\n\n');
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
      await runWithSessionId(
        sessionId,
        () =>
          withRequestConnectionAuthorized(
            requestConnection,
            requestDumpScope,
            async () => {
              const stream = handle.agent.streamProcess(
                normalizedMessages,
                opts,
              );

              try {
                for await (const chunk of stream) {
                  chunkCount++;
                  if (!chunk.ok) {
                    const err = chunk.error;

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
                    const userMessage = limit
                      ? throttleMessage(limit)
                      : err.message;
                    res.write(
                      `data: ${jsonError(userMessage, 'server_error')}\n\n`,
                    );
                    break;
                  }

                  const v = chunk.value;

                  // Forward heartbeats as SSE comments to keep the connection alive.
                  // Without this, CF Router / Cloud Connector may close idle TCP
                  // connections before the tool loop finishes, causing the browser's
                  // reader.read() to hang forever (onDone never fires).
                  if (v.heartbeat) {
                    res.write(`: heartbeat ${JSON.stringify(v.heartbeat)}\n\n`);
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
                    if (initialContent) accumulatedContent += initialContent;
                    res.write(
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
                    res.write(
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
                    res.write(
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
              } catch (streamErr) {
                const errMsg =
                  streamErr instanceof Error
                    ? streamErr.message
                    : String(streamErr);
                log.error('Stream exception', {
                  error: errMsg,
                  stack:
                    streamErr instanceof Error ? streamErr.stack : undefined,
                });
                const streamLimit = throttleOf(streamErr);
                const userMessage = streamLimit
                  ? throttleMessage(streamLimit)
                  : errMsg;
                res.write(
                  `data: ${jsonError(userMessage, 'server_error')}\n\n`,
                );
              }

              // Log per-model token breakdown if available (inside runWithSessionId so TS
              // can track lastUsage mutations; this is pure logging with no ordering concern).
              if (lastUsage?.models) {
                log.info('Token usage by model', lastUsage.models);
              }
            },
          ),
        priorTurns,
      ); // end runWithSessionId / runWithRequestConnection

      // Ensure finish_reason is always sent — clients require it to detect stream end
      if (!finishReasonSent) {
        res.write(
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
        res.write(
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
          recordTurnForRecall(sessionId, userId, lastUser, accumulatedContent);
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
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // --- Non-streaming (with rate-limit retry) ---
    // Bind the active session id into AsyncLocalStorage so the RAG tool dispatcher
    // (rag_add / rag_correct / rag_deprecate) can resolve against the current session.
    // The wrapper encloses the whole retry block so the context stays alive across retries.
    const result = await runWithSessionId(
      sessionId,
      () =>
        withRequestConnectionAuthorized(
          requestConnection,
          requestDumpScope,
          async () => {
            return handle.agent.process(normalizedMessages, opts);
          },
        ),
      priorTurns,
    );

    log.info('Chat completions done', {
      ok: result.ok,
      durationMs: Date.now() - t0,
    });

    const resultLimit = result.ok ? undefined : throttleOf(result.error);
    const finalContent = result.ok
      ? result.value.content || '(no response)'
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
        recordTurnForRecall(sessionId, userId, lastUser, finalContent);
      }

      // NOTE: state store upsert removed (non-streaming path) — same as streaming.
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...invalidToolsHeader,
    });
    res.end(
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
        usage: finalUsage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
    );
  } finally {
    restoreRagStores();
    await safeStop(requestConnection);
    // Free the per-trace telemetry bucket — nobody else calls dropRequest, so
    // omitting this leaks memory per request (Verified fact 10).
    (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
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
    models = await getAvailableModels();
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
      _meta: {
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
        mode: config.agent.mode,
        max_iterations: config.agent.maxIterations,
        rag_type: config.agent.ragType,
        mcp_destination: config.mcp.destination,
        classifier_model: getCurrentClassifierModel(),
        embedding_model:
          process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
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
