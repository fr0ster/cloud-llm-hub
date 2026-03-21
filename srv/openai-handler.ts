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
import { getSmartAgent } from './agent-manager';
import { getAgentConfig } from './agent-config';

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

  // Validate external tools
  const externalToolsValidation = normalizeAndValidateExternalTools(body.tools);
  const externalTools = externalToolsValidation.tools;
  if (externalToolsValidation.errors.length > 0) {
    log.debug('Invalid external tools detected', {
      count: externalToolsValidation.errors.length,
    });
  }

  const traceId = randomUUID();
  const sessionId =
    (req.headers['x-session-id'] as string | undefined) || 'default';
  const t0 = Date.now();
  log.info('Chat completions request', {
    stream: body.stream ?? false,
    traceId,
    messageCount: body.messages.length,
  });

  // Get SmartAgent handle (uses CAP request for auth context)
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Express Request ≠ CAP Request; cast needed for getSmartAgent
    handle = await getSmartAgent(req as any);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to initialize SmartAgent', { error: message });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(jsonError(`Agent initialization failed: ${message}`, 'server_error'));
    return;
  }

  const opts = {
    stream: body.stream,
    externalTools,
    sessionId,
    trace: { traceId },
  };

  // Normalize messages to SmartAgent Message format
  const normalizedMessages: Message[] = body.messages
    .map((m) => {
      const role = m.role as Message['role'];
      const normalizedMessage: Message = {
        role,
        content: extractText(m.content),
      };

      // Handle tool result messages
      if (role === 'tool') {
        if (typeof m.tool_call_id === 'string' && m.tool_call_id.trim()) {
          normalizedMessage.tool_call_id = m.tool_call_id;
        } else {
          return null;
        }
      }

      // Handle assistant messages with tool calls
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
          normalizedMessage.tool_calls = toolCalls;
          if (!normalizedMessage.content) normalizedMessage.content = null;
        }
      }

      return normalizedMessage;
    })
    .filter((m): m is Message => m !== null);

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
    let lastUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null = null;

    log.info('Starting streamProcess iteration');

    // Keepalive timer: write SSE comment every 10s to prevent CF GoRouter timeout (60s)
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* connection closed */ }
    }, 10_000);

    try {
      for await (const chunk of stream) {
        chunkCount++;
        if (!chunk.ok) {
          const errMsg = chunk.error.message;
          log.error('Stream error chunk', { chunkCount, error: errMsg });
          res.write(
            `data: ${jsonError(errMsg, 'server_error')}\n\n`,
          );
          break;
        }

        const v = chunk.value;

        // Heartbeat: SSE comment to keep connection alive during tool execution
        if (v.heartbeat) {
          const hb = v.heartbeat as { tool: string; elapsed: number };
          res.write(`: heartbeat tool=${hb.tool} elapsed=${hb.elapsed}ms\n\n`);
          continue;
        }

        // Timing: SSE comment with performance metrics
        if (v.timing) {
          const parts = (v.timing as Array<{ phase: string; duration: number }>)
            .map((t) => `${t.phase}=${t.duration}ms`);
          res.write(`: timing ${parts.join(' ')}\n\n`);
        }

        if (v.usage) {
          lastUsage = {
            prompt_tokens: v.usage.promptTokens,
            completion_tokens: v.usage.completionTokens,
            total_tokens: v.usage.totalTokens,
          };
        }

        log.debug('Stream chunk', {
          chunkCount,
          hasContent: !!v.content,
          contentLen: v.content?.length || 0,
          finishReason: v.finishReason || null,
        });

        const baseResponse = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'smart-agent',
          usage: null,
        };

        if (firstChunk) {
          res.write(
            `data: ${JSON.stringify({
              ...baseResponse,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: v.content || '',
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          firstChunk = false;
          if (!v.finishReason && !v.toolCalls) continue;
        }

        if (v.content || v.toolCalls) {
          const delta: Record<string, unknown> = {};
          if (v.content) delta.content = v.content;
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
              choices: [{ index: 0, delta, finish_reason: null }],
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
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      log.error('Stream exception', { error: errMsg, stack: streamErr instanceof Error ? streamErr.stack : undefined });
      res.write(
        `data: ${jsonError(errMsg, 'server_error')}\n\n`,
      );
    }

    clearInterval(keepalive);

    // Ensure finish_reason is always sent — Cline/Goose require it to detect stream end
    if (!finishReasonSent) {
      log.debug('Sending fallback finish_reason:stop (SmartAgent did not emit one)');
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
    });

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
            embedding_model: process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
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
    const handle = await getSmartAgent(req as any);
    const usage = handle.getUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(jsonError(error.message, 'server_error'));
  }
}
