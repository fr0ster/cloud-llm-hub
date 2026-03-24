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
import { getAgentConfig } from './agent-config';
import { getSmartAgent, isAgentReady } from './agent-manager';

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

  // Block requests until SmartAgent is fully initialized (MCP + vectorization)
  if (!isAgentReady()) {
    res.status(503).json({
      error: {
        message:
          'SmartAgent is initializing (MCP connect + tool vectorization). Please retry in a moment.',
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
  normalizedMessages = trimHistoryForContext(normalizedMessages);

  log.info('Chat completions request', {
    stream: body.stream ?? false,
    traceId,
    sessionId,
    mode: serverManaged ? 'server-session' : 'client-history',
    historySize: normalizedMessages.length,
    userMessage: normalizedMessages
      .filter((m) => m.role === 'user')
      .slice(-1)[0]
      ?.content?.toString()
      .slice(0, 200),
  });

  // Get SmartAgent handle
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to initialize SmartAgent', { error: message });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(`Agent initialization failed: ${message}`, 'server_error'),
    );
    return;
  }

  const pipelineLog = cds.log('smart-pipeline');
  const userId = getUserId();
  const opts = {
    stream: body.stream,
    // External tools (attempt_completion, read_file, etc.) from client — passed to SmartAgent
    // for ClineClientAdapter detection and external tool_call routing.
    externalTools,
    sessionId,
    // RAG namespace isolation: each user sees only their own facts/feedback/state
    // userId (not sessionId) — knowledge persists across sessions for the same user
    ragFilter: { namespace: userId },
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
  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...invalidToolsHeader,
    });

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = handle.agent.streamProcess(normalizedMessages, opts);

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
          res.write(`data: ${jsonError(err.message, 'server_error')}\n\n`);
          break;
        }

        const v = chunk.value;

        // Skip heartbeat and timing — internal diagnostics, not for client
        if (v.heartbeat || v.timing) {
          continue;
        }

        if (v.usage) {
          lastUsage = {
            prompt_tokens: v.usage.promptTokens,
            completion_tokens: v.usage.completionTokens,
            total_tokens: v.usage.totalTokens,
          };
        }

        const baseResponse = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'smart-agent',
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
      const errMsg =
        streamErr instanceof Error ? streamErr.message : String(streamErr);
      log.error('Stream exception', {
        error: errMsg,
        stack: streamErr instanceof Error ? streamErr.stack : undefined,
      });
      res.write(`data: ${jsonError(errMsg, 'server_error')}\n\n`);
    }

    // Ensure finish_reason is always sent — clients require it to detect stream end
    if (!finishReasonSent) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'smart-agent',
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

    if (body.stream_options?.include_usage && lastUsage) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'smart-agent',
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

  // --- Non-streaming ---
  const result = await handle.agent.process(normalizedMessages, opts);

  log.info('Chat completions done', {
    ok: result.ok,
    durationMs: Date.now() - t0,
  });

  const finalContent = result.ok
    ? result.value.content || '(no response)'
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
      model: 'smart-agent',
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
 * Returns model info enriched with agent configuration (LLM, RAG, MCP).
 */
export async function handleModels(
  _req: Request,
  res: Response,
): Promise<void> {
  const config = getAgentConfig();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'smart-agent',
          object: 'model',
          owned_by: 'smart-agent',
          context_window: 2000000,
          // Extended info for UI
          meta: {
            llm_model: config.llm.model,
            temperature: config.llm.temperature,
            max_tokens: config.llm.maxTokens,
            mode: config.agent.mode,
            max_iterations: config.agent.maxIterations,
            rag_type: config.agent.ragType,
            mcp_destination: config.mcp.destination,
            classifier_model:
              process.env.LLM_AGENT_CLASSIFIER_MODEL || config.llm.model,
            embedding_model:
              process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
          },
        },
      ],
    }),
  );
}

/**
 * GET /v1/usage
 */
export async function handleUsage(req: Request, res: Response): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Express Request ≠ CAP Request
    const handle = await getSmartAgent();
    const usage = handle.getUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(jsonError(error.message, 'server_error'));
  }
}
