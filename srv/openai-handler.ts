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
import type { Message } from '@mcp-abap-adt/llm-agent';
import { normalizeAndValidateExternalTools } from '@mcp-abap-adt/llm-agent/dist/smart-agent/utils/external-tools-normalizer';
import { toToolCallDelta } from '@mcp-abap-adt/llm-agent/dist/smart-agent/utils/tool-call-deltas';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getSmartAgent } from './agent-manager';

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
  // biome-ignore lint/suspicious/noExplicitAny: Express Request ≠ CAP Request; cast needed for getSmartAgent
  const handle = await getSmartAgent(req as any);

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
    let lastUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null = null;

    for await (const chunk of stream) {
      if (!chunk.ok) {
        res.write(
          `data: ${jsonError(chunk.error.message, 'server_error')}\n\n`,
        );
        break;
      }

      if (chunk.value.usage) {
        lastUsage = {
          prompt_tokens: chunk.value.usage.promptTokens,
          completion_tokens: chunk.value.usage.completionTokens,
          total_tokens: chunk.value.usage.totalTokens,
        };
      }

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
                  content: chunk.value.content || '',
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        firstChunk = false;
        if (!chunk.value.finishReason && !chunk.value.toolCalls) continue;
      }

      if (chunk.value.content || chunk.value.toolCalls) {
        const delta: Record<string, unknown> = {};
        if (chunk.value.content) delta.content = chunk.value.content;
        if (chunk.value.toolCalls) {
          delta.tool_calls = chunk.value.toolCalls.map((call, index) => {
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

      if (chunk.value.finishReason) {
        res.write(
          `data: ${JSON.stringify({
            ...baseResponse,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapStopReason(chunk.value.finishReason),
              },
            ],
          })}\n\n`,
        );
      }
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
 */
export async function handleModels(
  _req: Request,
  res: Response,
): Promise<void> {
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
