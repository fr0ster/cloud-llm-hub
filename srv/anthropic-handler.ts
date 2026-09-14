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
  type ApiRequestContext,
  type NormalizedRequest,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { isAiCoreConfigured } from './agent-config';
import {
  getCurrentDestination,
  getSmartAgent,
  isAgentReady,
  runWithRequestConnection,
} from './agent-manager';
import { describeCaller } from './lib/exposition';
import { establishRequestConnection, safeStop } from './lib/request-connection';
import {
  anthropicErrorPayload,
  retryAfterHeader,
  statusForError,
  throttleOf,
} from './lib/throttle-surfacing';
import { runWithSessionId } from './request-session';
import { sessionIdOf } from './session-id';

/** Singleton adapter instance (stateless — safe to share) */
const adapter = new AnthropicApiAdapter();

/**
 * `recMcp` is attached to the handle at runtime (agent-manager.ts) but is not
 * part of the library's `SmartAgentHandle` type — optional, since an
 * LLM-only handle (no destination) has no per-destination recMcp.
 */
interface HandleWithRecMcp {
  recMcp?: { dropRequest(traceId?: string): void };
}

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

  // Establish the caller's per-request SAP connection BEFORE running the agent.
  // Same fail-closed policy as /v1/chat/completions: no default destination
  // service user — on-premise/NoAuthentication destinations require the caller's
  // x-sap-login/x-sap-password; cloud destinations use the resolved auth (JWT).
  // Without a per-request connection, ABAP tool calls throw in agent-manager.
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;
  const sessionId = sessionIdOf(req);
  const destination = requestedDestination || getCurrentDestination(sessionId);

  let requestConnection:
    | import('@mcp-abap-adt/interfaces').IAbapConnection
    | undefined;
  let requestDumpScope: import('./lib/principal').DumpScope | undefined;
  if (destination) {
    const established = await establishRequestConnection(req, res, destination);
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

  // Get the SmartAgent handle for the SAME destination the connection was
  // established for (resolved above from x-sap-destination / session). Passing
  // it explicitly ensures the agent's MCP tools match the connection — without
  // it, getSmartAgent would fall to the configured default destination.
  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent(undefined, destination);
  } catch (err) {
    await safeStop(requestConnection);
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

  // Unique per-request traceId — required for the recording logger's
  // per-trace bucketing and the finalizer's `getSummary(traceId)` (Verified
  // fact 10). Merge into any `trace` the adapter already normalized from the
  // request rather than clobbering it.
  const traceId = randomUUID();

  // The caller's permissions. This channel previously resolved none at all —
  // no role filtering on which tools were offered, and nothing to authorize a
  // tool call against. Both are fixed here from one value, so they agree.
  const caller = describeCaller(cds.context?.user);
  log.info('MCP caller', caller);
  const callerExposition = caller.exposition;

  const agentOpts = {
    stream,
    ...options,
    ragFilter: {
      ...(options as { ragFilter?: Record<string, unknown> })?.ragFilter,
      exposition: callerExposition,
    },
    trace: { ...options?.trace, traceId },
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
    runWithSessionId(
      undefined,
      () =>
        requestConnection
          ? runWithRequestConnection(
              requestConnection,
              fn,
              requestDumpScope,
              callerExposition,
            )
          : fn(),
      priorTurns,
    );

  try {
    // --- Streaming ---
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Independent SSE keep-alive — see openai-handler for the rationale: the
      // DAG coordinator routes the executor's heartbeats to the session log
      // only (llm-agent #166), so a long tool loop would idle the connection
      // past the CF router / client timeout before the finalizer emits. SSE
      // comment lines are ignored by clients, harmless during active streaming.
      const KEEPALIVE_MS = 10_000;
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      res.on('close', () => clearInterval(keepAlive));

      try {
        await runAgent(async () => {
          const sseStream = adapter.transformStream(
            handle.agent.streamProcess(messages, agentOpts),
            context,
          );
          for await (const event of sseStream) {
            res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const limit = throttleOf(err);
        log.error('Stream error', { error: message, throttled: limit?.reason });
        // Headers are already sent, so the status code is spent — but the SSE
        // channel is not. Closing in silence leaves the client with a truncated
        // stream and nothing to act on, which for a throttled request is the
        // one case where we know exactly what it should do next.
        if (!res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify(anthropicErrorPayload(err))}\n\n`,
          );
        }
      }

      clearInterval(keepAlive);
      res.end();
      return;
    }

    // --- Non-streaming ---
    const result = await runAgent(() =>
      handle.agent.process(messages, agentOpts),
    );

    if (result.ok) {
      const formatted = adapter.formatResult(result.value, context);
      res.status(200).json(formatted);
    } else {
      const limit = throttleOf(result.error);
      log.error('Agent processing failed', {
        error: result.error.message,
        throttled: limit?.reason,
      });
      // The adapter's generic envelope cannot say when to come back, and 500
      // tells a client to treat a closed quota as our fault. Both matter to a
      // caller deciding whether to retry, so the throttled case is shaped here
      // and everything else keeps the adapter's formatting exactly as before.
      if (limit) {
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res
          .status(statusForError(result.error))
          .json(anthropicErrorPayload(result.error));
      } else {
        res
          .status(500)
          .json(
            adapter.formatError(result.error, context as ApiRequestContext),
          );
      }
    }
  } finally {
    await safeStop(requestConnection);
    // Free the per-trace telemetry bucket — nobody else calls dropRequest, so
    // omitting this leaks memory per request (Verified fact 10).
    (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
  }
}
