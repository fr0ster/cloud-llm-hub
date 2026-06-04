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
  clearSessionTopic,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getCurrentClassifierModel,
  getCurrentDestination,
  getCurrentModel,
  getDestinationStates,
  getSmartAgent,
  isAgentReady,
  runWithRequestConnection,
  setSessionDestination,
} from './agent-manager';
import { resolveRouteId } from './collection-ids';
import { getAvailableModels } from './lib/ai-core-models';
import { resolveExposition } from './lib/exposition';
import {
  establishRequestConnection,
  resetRequestConnection,
} from './lib/request-connection';
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
 * Run `fn` with the per-request SAP connection bound for its whole async subtree
 * (so MCP tool calls inside the agent pipeline see it). When there is no
 * per-request connection (LLM-only / no destination), run `fn` directly.
 */
function withRequestConnection<T>(
  connection: import('@mcp-abap-adt/interfaces').IAbapConnection | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return connection ? runWithRequestConnection(connection, fn) : fn();
}

// ---------------------------------------------------------------------------
// Rate-limit retry helpers
// ---------------------------------------------------------------------------

/** Max automatic retries for rate-limit (429) errors */
const RATE_LIMIT_MAX_RETRIES = 2;

/** Base delay in ms — actual delay is base * 2^attempt (1s, 2s) */
const RATE_LIMIT_BASE_DELAY_MS = 1000;

/**
 * Detect rate-limit errors in the error cause chain.
 * SAP AI Core / Anthropic API returns HTTP 429 or error messages containing "rate limit".
 */
function isRateLimitError(error: unknown): boolean {
  let current: unknown = error;
  while (current) {
    if (current instanceof Error) {
      const msg = current.message.toLowerCase();
      if (
        msg.includes('rate limit') ||
        msg.includes('rate_limit') ||
        msg.includes('429') ||
        msg.includes('too many requests')
      ) {
        return true;
      }
      const httpErr = current as {
        response?: { status?: number };
        statusCode?: number;
      };
      if (httpErr.response?.status === 429 || httpErr.statusCode === 429) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      const str = String(current).toLowerCase();
      if (str.includes('rate limit') || str.includes('429')) return true;
      break;
    }
  }
  return false;
}

/** User-friendly message shown after all retries are exhausted */
const RATE_LIMIT_USER_MESSAGE =
  'The AI service is temporarily overloaded. Please wait a moment and try again.';

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

/** Clear session history for a specific user */
export function clearSession(sessionId: string, userId: string): void {
  sessionStore.delete(sessionStoreKey(sessionId, userId));
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
  const destBefore = getCurrentDestination(sessionId);
  const destAfter = requestedDestination || destBefore;
  let requestConnection:
    | import('@mcp-abap-adt/interfaces').IAbapConnection
    | undefined;

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
  }

  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent(requestedModel, requestedDestination);
  } catch (err) {
    resetRequestConnection(requestConnection);
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
        exposition: resolveExposition(
          ['MCP_Reader', 'MCP_Analyst', 'MCP_Developer', 'MCP_Full'].filter(
            (role) => cds.context?.user?.is?.(role) ?? false,
          ),
        ),
      },
      trace: { traceId },
      sessionLogger: {
        logStep(name: string, data: unknown) {
          if (
            name === 'tools_selected' ||
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
      let rateLimitAttempt = 0;
      await runWithSessionId(sessionId, () =>
        withRequestConnection(requestConnection, async () => {
          streamRetry: while (rateLimitAttempt <= RATE_LIMIT_MAX_RETRIES) {
            const stream = handle.agent.streamProcess(normalizedMessages, opts);

            try {
              for await (const chunk of stream) {
                chunkCount++;
                if (!chunk.ok) {
                  const err = chunk.error;

                  // Rate-limit retry: only if no content has been sent to the client yet
                  if (
                    isRateLimitError(err) &&
                    firstChunk &&
                    rateLimitAttempt < RATE_LIMIT_MAX_RETRIES
                  ) {
                    const delay =
                      RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitAttempt;
                    rateLimitAttempt++;
                    log.warn('Rate limit hit, retrying stream', {
                      attempt: rateLimitAttempt,
                      maxRetries: RATE_LIMIT_MAX_RETRIES,
                      delayMs: delay,
                    });
                    await new Promise((r) => setTimeout(r, delay));
                    // Reset counters for fresh stream attempt
                    chunkCount = 0;
                    continue streamRetry;
                  }

                  // Non-retryable or retries exhausted — send user-friendly message for rate limits
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
                  const userMessage = isRateLimitError(err)
                    ? RATE_LIMIT_USER_MESSAGE
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
                          delta: { role: 'assistant', content: initialContent },
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
              // Rate-limit retry on exception (only before first content chunk)
              if (
                isRateLimitError(streamErr) &&
                firstChunk &&
                rateLimitAttempt < RATE_LIMIT_MAX_RETRIES
              ) {
                const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitAttempt;
                rateLimitAttempt++;
                log.warn('Rate limit exception, retrying stream', {
                  attempt: rateLimitAttempt,
                  delayMs: delay,
                });
                await new Promise((r) => setTimeout(r, delay));
                chunkCount = 0;
                continue;
              }

              const errMsg =
                streamErr instanceof Error
                  ? streamErr.message
                  : String(streamErr);
              log.error('Stream exception', {
                error: errMsg,
                stack: streamErr instanceof Error ? streamErr.stack : undefined,
              });
              const userMessage = isRateLimitError(streamErr)
                ? RATE_LIMIT_USER_MESSAGE
                : errMsg;
              res.write(`data: ${jsonError(userMessage, 'server_error')}\n\n`);
            }
            break; // Normal exit — no more retries needed
          } // end streamRetry while loop

          // Log per-model token breakdown if available (inside runWithSessionId so TS
          // can track lastUsage mutations; this is pure logging with no ordering concern).
          if (lastUsage?.models) {
            log.info('Token usage by model', lastUsage.models);
          }
        }),
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

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // --- Non-streaming (with rate-limit retry) ---
    // Bind the active session id into AsyncLocalStorage so the RAG tool dispatcher
    // (rag_add / rag_correct / rag_deprecate) can resolve against the current session.
    // The wrapper encloses the whole retry block so the context stays alive across retries.
    const result = await runWithSessionId(sessionId, () =>
      withRequestConnection(requestConnection, async () => {
        let r = await handle.agent.process(normalizedMessages, opts);

        // Retry on rate-limit errors
        if (!r.ok && isRateLimitError(r.error)) {
          for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
            const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
            log.warn('Rate limit hit, retrying', {
              attempt: attempt + 1,
              maxRetries: RATE_LIMIT_MAX_RETRIES,
              delayMs: delay,
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
            r = await handle.agent.process(normalizedMessages, opts);
            if (r.ok || !isRateLimitError(r.error)) break;
          }
        }
        return r;
      }),
    );

    log.info('Chat completions done', {
      ok: result.ok,
      durationMs: Date.now() - t0,
    });

    const finalContent = result.ok
      ? result.value.content || '(no response)'
      : isRateLimitError(result.error)
        ? RATE_LIMIT_USER_MESSAGE
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
    resetRequestConnection(requestConnection);
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
