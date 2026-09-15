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
  closeDestination,
  getCurrentDestination,
  getSmartAgent,
  isAgentReady,
  isDestinationClosed,
  retryAfterForDestination,
  runWithRequestConnection,
} from './agent-manager';
import { detachedSink } from './lib/detached-sink';
import { describeCaller } from './lib/exposition';
import { admitPipeline, type PipelineSession } from './lib/gatekeeper';
import { recordDestinationRefusal } from './lib/gatekeeper-metrics';
import { describeCause, isOutageError } from './lib/mcp-outage';
import { establishRequestConnection, safeStop } from './lib/request-connection';
import {
  type RequestSystemInput,
  resolveRequestSystem,
  runWithRequestSystem,
} from './lib/request-system-context';
import {
  anthropicDoorRefusal,
  anthropicErrorPayload,
  anthropicSessionClosed,
  anthropicUnverifiedWrite,
  destinationClosedText,
  type RecMcpHandle,
  retryAfterHeader,
  statusForError,
  throttleMessage,
  throttleOf,
  unverifiedWriteFor,
} from './lib/throttle-surfacing';
import { runWithSessionId } from './request-session';
import { sessionIdOf, type WithSession } from './session-id';

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

  // Establish the caller's per-request SAP connection BEFORE running the agent.
  // Same fail-closed policy as /v1/chat/completions: no default destination
  // service user — on-premise/NoAuthentication destinations require the caller's
  // x-sap-login/x-sap-password; cloud destinations use the resolved auth (JWT).
  // Without a per-request connection, ABAP tool calls throw in agent-manager.
  const requestedDestination = req.headers['x-sap-destination'] as
    | string
    | undefined;
  const sessionId = sessionIdOf(req);
  const userId = cds.context?.user?.id ?? 'anonymous';
  const destination =
    requestedDestination || getCurrentDestination(userId, sessionId);

  // A closed destination refuses before anything is built for it. Connecting
  // first would CSRF-fetch against the system that is down and answer
  // `401 sap_credentials_failed` from inside `establishRequestConnection`, so
  // this 503 with its `Retry-After` would only ever be reached once SAP was
  // back. It also comes before `getSmartAgent`, which throws its own
  // `destination_unreachable` 503 with no `Retry-After`. No connection exists
  // yet, so there is nothing to `safeStop`.
  if (isDestinationClosed(destination)) {
    recordDestinationRefusal(destination);
    const seconds = retryAfterForDestination(destination);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destination),
        },
      }),
    );
    return;
  }

  let requestConnection:
    | import('@mcp-abap-adt/interfaces').IAbapConnection
    | undefined;
  let requestDumpScope: import('./lib/principal').DumpScope | undefined;
  let requestSystemInput: RequestSystemInput | undefined;
  if (destination) {
    const established = await establishRequestConnection(req, res, destination);
    if (established.handled) return;
    requestConnection = established.connection;
    requestDumpScope = established.dumpScope;
    if (established.connection && established.requestSystem) {
      requestSystemInput = {
        headers: req.headers,
        connection: established.connection,
        ...established.requestSystem,
      };
    }
  }

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

  let pipeline: PipelineSession;
  try {
    const admission = await admitPipeline(
      userId,
      sessionId ?? traceId,
      callerLeft.signal,
      {
        presented:
          sessionId !== undefined &&
          (req as Request & WithSession).sessionMinted === false,
      },
    );
    if ('refused' in admission) {
      await safeStop(requestConnection);
      const refusal = anthropicDoorRefusal(admission.refused);
      out.json(refusal.status, refusal.body);
      return;
    }
    if ('closed' in admission) {
      await safeStop(requestConnection);
      const closed = anthropicSessionClosed();
      out.json(closed.status, closed.body);
      return;
    }
    pipeline = admission.admitted;
  } catch {
    await safeStop(requestConnection);
    return;
  }

  const agentOpts = {
    stream,
    ...options,
    // After the spread: nothing in `options` may override the admission's signal.
    signal: pipeline.signal,
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
    pipeline.run(() =>
      runWithSessionId(
        undefined,
        async () => {
          const connection = requestConnection;
          if (!connection) return fn();
          const bound = () =>
            runWithRequestConnection(
              connection,
              fn,
              requestDumpScope,
              callerExposition,
            );
          if (!requestSystemInput) return bound();
          // Admitted, right before the pipeline: this run's responsible person
          // and master system, visible to it alone — `request-system-context.ts`.
          return runWithRequestSystem(
            await resolveRequestSystem(requestSystemInput),
            bound,
          );
        },
        priorTurns,
      ),
    );

  try {
    // --- Streaming ---
    if (stream) {
      out.writeHead(200, {
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
        out.write(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();
      res.on('close', () => clearInterval(keepAlive));

      // `message_stop`, held back once a chunk has failed so that a notice can
      // still go before it: Anthropic clients, the Claude CLI among them, stop
      // reading at `message_stop`, and a notice after it reaches nobody.
      let heldStop = undefined as { event?: string; data: string } | undefined;
      try {
        // `AnthropicApiAdapter.transformStream` turns an error chunk
        // (`!chunk.ok`) into an ordinary `message_delta`/`message_stop` pair
        // and returns — it never throws — so the `catch` below never sees a
        // failure that arrived as a STREAM CHUNK (only an exception thrown by
        // the pipeline itself). This wrapper is the only way to learn a chunk
        // failed: it notes the first such error and passes every chunk
        // through unchanged, so the adapter's own (already-correct) output is
        // untouched either way.
        let streamError: unknown;
        await runAgent(async () => {
          const source = handle.agent.streamProcess(messages, agentOpts);
          const observed = (async function* () {
            for await (const chunk of source) {
              if (!chunk.ok && streamError === undefined) {
                streamError = chunk.error;
              }
              yield chunk;
            }
          })();
          const sseStream = adapter.transformStream(observed, context);
          for await (const event of sseStream) {
            // Only after a failed chunk. With none, every event is written as
            // it arrives, byte for byte what the adapter emitted.
            if (event.event === 'message_stop' && streamError !== undefined) {
              heldStop = event;
              continue;
            }
            out.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
          }
        });

        // An outage closes the destination regardless of whether a write is
        // left unanswered — the two facts are independent, and a chunk that
        // named neither pending write nor throttle would otherwise leave an
        // unreachable destination open (as OpenAI's matching site already
        // does not). The trailing `event: error` line stays conditional on
        // `unverifiedWriteFor`: otherwise today's streamed output (the
        // adapter's own message_delta/message_stop close) stays as it is.
        if (streamError !== undefined) {
          if (isOutageError(streamError)) {
            closeDestination(destination, describeCause(streamError));
          }
          const unverified = unverifiedWriteFor(handle, traceId, streamError);
          if (unverified) {
            const limit = throttleOf(streamError);
            log.error('Stream error chunk', {
              error: describeCause(streamError),
              throttled: limit?.reason,
            });
            const text = limit
              ? `${unverified} ${throttleMessage(limit)}`
              : unverified;
            out.write(
              `event: error\ndata: ${JSON.stringify(
                anthropicUnverifiedWrite(
                  text,
                  limit ? 'overloaded_error' : 'api_error',
                ),
              )}\n\n`,
            );
          }
        }
      } catch (err) {
        if (isOutageError(err))
          closeDestination(destination, describeCause(err));
        const message = err instanceof Error ? err.message : String(err);
        const limit = throttleOf(err);
        log.error('Stream error', { error: message, throttled: limit?.reason });
        // Headers are already sent, so the status code is spent — but the SSE
        // channel is not. Closing in silence leaves the client with a truncated
        // stream and nothing to act on, which for a throttled request is the
        // one case where we know exactly what it should do next.
        const unverified = unverifiedWriteFor(handle, traceId, err);
        const payload = unverified
          ? anthropicUnverifiedWrite(
              limit ? `${unverified} ${throttleMessage(limit)}` : unverified,
              limit ? 'overloaded_error' : 'api_error',
            )
          : anthropicErrorPayload(err);
        out.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      }

      // The held `message_stop` closes the message after any notice above.
      if (heldStop) {
        out.write(`event: ${heldStop.event}\ndata: ${heldStop.data}\n\n`);
      }
      clearInterval(keepAlive);
      out.end();
      return;
    }

    // --- Non-streaming ---
    const result = await runAgent(() =>
      handle.agent.process(messages, agentOpts),
    );

    if (result.ok) {
      out.json(200, adapter.formatResult(result.value, context));
    } else {
      if (isOutageError(result.error)) {
        closeDestination(destination, describeCause(result.error));
      }
      const limit = throttleOf(result.error);
      log.error('Agent processing failed', {
        error: result.error.message,
        throttled: limit?.reason,
      });
      const unverified = unverifiedWriteFor(handle, traceId, result.error);
      if (unverified && limit) {
        // Both apply: the write notice leads, the throttle sentence follows
        // it — but the STATUS and Retry-After stay the throttle path's own.
        // Dropping them to a flat 500 would silently take away the "come back
        // in N seconds" fact a throttled caller still needs.
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        out.json(
          statusForError(result.error),
          anthropicUnverifiedWrite(
            `${unverified} ${throttleMessage(limit)}`,
            'overloaded_error',
          ),
        );
      } else if (unverified) {
        out.json(500, anthropicUnverifiedWrite(unverified));
      } else if (limit) {
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        out.json(
          statusForError(result.error),
          anthropicErrorPayload(result.error),
        );
      } else {
        out.json(
          500,
          adapter.formatError(result.error, context as ApiRequestContext),
        );
      }
    }
  } finally {
    await pipeline.drain();
    await safeStop(requestConnection);
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
