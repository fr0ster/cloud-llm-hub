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
  getCurrentClassifierModel,
  getCurrentDestination,
  getCurrentModel,
  getCurrentPresentationModel,
  getDestinationStates,
  getSmartAgent,
  isAgentReady,
  setSessionDestination,
} from './agent-manager';
import { getAvailableModels } from './lib/ai-core-models';

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

const sessionStore = new Map<string, SessionEntry>();

/** Periodic cleanup of expired sessions */
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionStore) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);

/** Get or create session history */
function getSessionHistory(sessionId: string): Message[] {
  const entry = sessionStore.get(sessionId);
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  return [];
}

/** Append messages to session history, trimming to max size */
function appendToSession(sessionId: string, ...msgs: Message[]): void {
  let entry = sessionStore.get(sessionId);
  if (!entry) {
    entry = { messages: [], lastAccess: Date.now() };
    sessionStore.set(sessionId, entry);
  }
  entry.lastAccess = Date.now();
  entry.messages.push(...msgs);

  // Keep only last N messages
  if (entry.messages.length > SESSION_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SESSION_MAX_MESSAGES);
  }
}

/** Replace session history entirely (for client-managed history mode) */
function setSessionHistory(sessionId: string, msgs: Message[]): void {
  const trimmed = msgs.slice(-SESSION_MAX_MESSAGES);
  sessionStore.set(sessionId, { messages: trimmed, lastAccess: Date.now() });
}

/** Clear session history */
export function clearSession(sessionId: string): void {
  sessionStore.delete(sessionId);
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
  classifier_model?: string;
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
  const clientSessionId = req.headers['x-session-id'] as string | undefined;
  const sessionId = clientSessionId || randomUUID();
  const t0 = Date.now();

  // Two modes of history management:
  // 1. Server-managed session (our UI): x-session-id header present, client sends only new message
  // 2. Client-managed history (OpenAI clients like Cline): no header, client sends full history
  const serverManaged = !!clientSessionId;

  let normalizedMessages: Message[];

  if (serverManaged) {
    // Server session mode: extract last user message, prepend server history
    const lastUserContent = extractText(
      userMessages[userMessages.length - 1].content,
    );
    const newUserMessage: Message = { role: 'user', content: lastUserContent };
    const serverHistory = getSessionHistory(sessionId);
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

    // Store client history in server session for potential future server-managed use
    setSessionHistory(sessionId, normalizedMessages);
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
  const requestedClassifierModel =
    typeof body.classifier_model === 'string'
      ? body.classifier_model
      : undefined;
  const requestedPresentationModel =
    typeof body.presentation_model === 'string'
      ? body.presentation_model
      : undefined;
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;

  // Track destination before/after to detect switches
  const destBefore = getCurrentDestination(sessionId);
  const destAfter = requestedDestination || destBefore;
  log.debug('Destination tracking', {
    sessionId,
    destBefore,
    destAfter,
    requestedDestination: requestedDestination || '(none)',
  });

  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent(
      requestedModel,
      requestedDestination,
      requestedClassifierModel,
      requestedPresentationModel,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to initialize SmartAgent', { error: message });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(`Agent initialization failed: ${message}`, 'server_error'),
    );
    return;
  }

  // Track which destination this session is using
  setSessionDestination(sessionId, destAfter);
  if (destBefore !== destAfter && serverManaged) {
    log.info('Destination switched, clearing session history', {
      from: destBefore,
      to: destAfter,
      sessionId,
    });
    clearSession(sessionId);
    clearSessionTopic(sessionId);
    // Re-build normalizedMessages with only the new user message (no stale history)
    const lastUserContent = extractText(
      userMessages[userMessages.length - 1].content,
    );
    normalizedMessages = [{ role: 'user', content: lastUserContent }];
  }

  const pipelineLog = cds.log('smart-pipeline');
  const userId = getUserId();
  const opts = {
    stream: body.stream,
    // External tools (attempt_completion, read_file, etc.) from client — passed to SmartAgent
    // for ClineClientAdapter detection and external tool_call routing.
    externalTools,
    sessionId,
    // RAG namespace isolation: user + destination — results from DEV don't leak into QAS
    ragFilter: { namespace: `${userId}:${destAfter}` },
    trace: { traceId },
    sessionLogger: {
      logStep(name: string, data: unknown) {
        if (
          name === 'tools_selected' ||
          name === 'rag_query_facts' ||
          name === 'classification_skipped' ||
          name === 'tool_select_rag_fallback' ||
          name.startsWith('custom_classify') ||
          name.startsWith('custom_tool_select') ||
          name.startsWith('final_context') ||
          name.startsWith('llm_request') ||
          name.startsWith('llm_response')
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
  // FORCE_NON_STREAMING: use non-streaming agent.process() but emulate SSE for clients.
  // Workaround for SAP AI Core Orchestration API 500 errors in streaming mode.
  const forceNonStreaming = process.env.FORCE_NON_STREAMING === 'true';
  if (body.stream && forceNonStreaming) {
    // Non-streaming call, emulated as SSE for client compatibility
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-SAP-Active-Destination': destAfter,
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    try {
      const result = await handle.agent.process(normalizedMessages, opts);
      if (!result.ok) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: getCurrentModel(),
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: `Error: ${result.error.message}`,
                },
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
        );
      } else {
        // Emit content as single chunk
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: getCurrentModel(),
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: result.value.content },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        // Emit tool calls if any
        if (result.value.toolCalls) {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: getCurrentModel(),
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: result.value.toolCalls },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        }
        // Finish reason
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
                finish_reason: mapStopReason(result.value.stopReason),
              },
            ],
          })}\n\n`,
        );
        // Usage
        if (result.value.usage) {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: getCurrentModel(),
              choices: [],
              usage: {
                prompt_tokens: result.value.usage.promptTokens,
                completion_tokens: result.value.usage.completionTokens,
                total_tokens: result.value.usage.totalTokens,
              },
            })}\n\n`,
          );
        }
        // Session
        if (result.value.content) {
          const lastUser = normalizedMessages
            .filter((m) => m.role === 'user')
            .slice(-1)[0];
          if (lastUser) {
            appendToSession(sessionId, lastUser, {
              role: 'assistant',
              content: result.value.content,
            } as Message);
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.write(
        `data: ${JSON.stringify({ error: { message: errMsg, type: 'server_error' } })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
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
    } | null = null;

    log.info('Starting streamProcess', { sessionId });

    // Retry loop: restart stream on rate-limit errors (only before first content chunk)
    let rateLimitAttempt = 0;
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
              const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitAttempt;
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
            res.write(`data: ${jsonError(userMessage, 'server_error')}\n\n`);
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
          streamErr instanceof Error ? streamErr.message : String(streamErr);
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
        appendToSession(sessionId, lastUser, {
          role: 'assistant',
          content: accumulatedContent,
        } as Message);
        const entry = sessionStore.get(sessionId);
        log.debug('Session updated', {
          sessionId,
          storedMessages: entry?.messages.length ?? 0,
          responseChars: accumulatedContent.length,
        });
      }

      // Persist agent response in RAG state store for cross-session memory.
      // Even if session history gets summarized/trimmed, tool results remain
      // discoverable via semantic search (e.g. "read that program" finds previous results).
      const stateStore = handle.ragStores.state;
      const lastUserForState = normalizedMessages
        .filter((m) => m.role === 'user')
        .slice(-1)[0];
      if (stateStore && lastUserForState) {
        const stateText = `Q: ${typeof lastUserForState.content === 'string' ? lastUserForState.content : ''}\nA: ${accumulatedContent.slice(0, 2000)}`;
        stateStore
          .upsert(stateText, {
            namespace: `${userId}:${destAfter}`,
            ttl: Math.floor((Date.now() + 3600_000) / 1000),
          })
          .catch((err: unknown) => {
            log.debug('RAG state upsert failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }

    if (chunkCount === 0) {
      log.warn('Stream produced 0 chunks — pipeline may have failed silently', {
        messageCount: normalizedMessages.length,
        sessionId,
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // --- Non-streaming (with rate-limit retry) ---
  let result = await handle.agent.process(normalizedMessages, opts);

  // Retry on rate-limit errors
  if (!result.ok && isRateLimitError(result.error)) {
    for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
      const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
      log.warn('Rate limit hit, retrying', {
        attempt: attempt + 1,
        maxRetries: RATE_LIMIT_MAX_RETRIES,
        delayMs: delay,
      });
      await new Promise((r) => setTimeout(r, delay));
      result = await handle.agent.process(normalizedMessages, opts);
      if (result.ok || !isRateLimitError(result.error)) break;
    }
  }

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
    };
  }

  // Save conversation turn to server session
  if (result.ok && finalContent !== '(no response)') {
    const lastUser = normalizedMessages
      .filter((m) => m.role === 'user')
      .slice(-1)[0];
    if (lastUser) {
      appendToSession(sessionId, lastUser, {
        role: 'assistant',
        content: finalContent,
      } as Message);
    }

    // Persist in RAG state store for cross-session memory
    const stateStore = handle.ragStores.state;
    const lastUserNonStream = normalizedMessages
      .filter((m) => m.role === 'user')
      .slice(-1)[0];
    if (stateStore && lastUserNonStream) {
      const stateText = `Q: ${typeof lastUserNonStream.content === 'string' ? lastUserNonStream.content : ''}\nA: ${finalContent.slice(0, 2000)}`;
      stateStore
        .upsert(stateText, {
          namespace: `${userId}:${destAfter}`,
          ttl: Math.floor((Date.now() + 3600_000) / 1000),
        })
        .catch((err: unknown) => {
          log.debug('RAG state upsert failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
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
        presentation_model: getCurrentPresentationModel(),
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
