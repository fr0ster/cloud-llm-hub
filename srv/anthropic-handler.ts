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

import {
  AdapterValidationError,
  AnthropicApiAdapter,
  type ApiRequestContext,
  type NormalizedRequest,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { isAiCoreConfigured } from './agent-config';
import { getSmartAgent, isAgentReady } from './agent-manager';

/** Singleton adapter instance (stateless — safe to share) */
const adapter = new AnthropicApiAdapter();

/**
 * POST /v1/messages
 *
 * Accepts Anthropic Messages API request, delegates to SmartAgent.process() or
 * SmartAgent.streamProcess() depending on `stream` flag.
 */
export async function handleAnthropicMessages(
  req: Request,
  res: Response,
): Promise<void> {
  const log = cds.log('anthropic-handler');

  // Block requests when agent is not available
  if (!isAgentReady()) {
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
    normalized = adapter.normalizeRequest(req.body);
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

  const { messages, stream, options, context } = normalized;

  log.info('Messages request', {
    stream,
    messageCount: messages.length,
    roles: messages.map((m) => m.role).join(','),
  });

  // Get SmartAgent handle (no model/destination override for Anthropic endpoint)
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

  const agentOpts = {
    stream,
    ...options,
  };

  // --- Streaming ---
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const sseStream = adapter.transformStream(
        handle.agent.streamProcess(messages, agentOpts),
        context,
      );

      for await (const event of sseStream) {
        res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Stream error', { error: message });
      // If headers already sent, we can only close the connection
    }

    res.end();
    return;
  }

  // --- Non-streaming ---
  const result = await handle.agent.process(messages, agentOpts);

  if (result.ok) {
    const formatted = adapter.formatResult(result.value, context);
    res.status(200).json(formatted);
  } else {
    log.error('Agent processing failed', { error: result.error.message });
    const formatted = adapter.formatError(
      result.error,
      context as ApiRequestContext,
    );
    res.status(500).json(formatted);
  }
}
