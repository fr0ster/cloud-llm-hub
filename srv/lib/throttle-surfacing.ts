/**
 * Reporting an exhausted throttle policy to the caller.
 *
 * Shared by every channel rather than kept in one handler: the promise is that
 * a caller is told when to come back, and a promise kept on three surfaces out
 * of four is not kept. The provider does the waiting (llm-agent 23.0.0); this
 * only reads what it concluded, and shapes it for each wire format.
 *
 * The per-channel formatters live here rather than in the handlers so a test
 * can exercise the code the handler actually runs. A test that rebuilds the
 * envelope beside the handler passes while the handler sends nothing at all.
 */

import { findThrottled } from '@mcp-abap-adt/llm-agent';
import { describeCause } from './mcp-outage';

/**
 * Was this a rate limit, and for how long?
 *
 * The provider answers 429 itself since llm-agent 23.0.0: it backs off, honours
 * `Retry-After`, and holds one shared pause per quota so concurrent callers do
 * not each rediscover the same closed limit. By the time an error reaches this
 * layer that policy is spent, and the error says so — `findThrottled` reads
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

/**
 * The Anthropic error envelope, throttled or not.
 *
 * `overloaded_error` is Anthropic's own type for an upstream that is
 * temporarily over capacity, which is what this is. Not `rate_limit_error`:
 * that one blames the caller for its own request rate, and the caller neither
 * sets the rate nor spends the quota one request at a time. Used on both the
 * streaming and the non-streaming path — they differ in how it is delivered,
 * not in what it says.
 */
export function anthropicErrorPayload(error: unknown): {
  type: 'error';
  error: { type: string; message: string };
} {
  const limit = throttleOf(error);
  const fallback = error instanceof Error ? error.message : String(error);
  return {
    type: 'error',
    error: {
      type: limit ? 'overloaded_error' : 'api_error',
      message: limit ? throttleMessage(limit) : fallback,
    },
  };
}

/**
 * The HTTP status for a failed request on the Anthropic-compatible channel.
 *
 * `529`, and not `429`. A `429` says THIS caller sent too many requests, and
 * that is not what happened: the caller does not set the rate, and the traffic
 * is not one-to-one — a single chat request fans out into as many LLM calls as
 * the tool loop needs, so a consumer's request count says nothing about how
 * much upstream quota it spends.
 *
 * `529` rather than `503` because this endpoint speaks Anthropic's dialect, and
 * in that dialect `overloaded_error` is paired with `529`. A client written
 * against their API already knows what to do with it; sending their error type
 * under a different status would be a pairing they have never seen. `Retry-After`
 * applies to it exactly as it would to a `503`.
 */
export function statusForError(error: unknown): number {
  return throttleOf(error) ? 529 : 500;
}

/**
 * The `Retry-After` value, in whole seconds, or undefined when unknown.
 *
 * The message carries the same number in prose for a human; a client retrying
 * on its own reads the header. RFC 9110 wants a non-negative integer, so the
 * remaining pause is rounded up — early is worse than late here.
 */
export function retryAfterHeader(error: unknown): string | undefined {
  const seconds = throttleOf(error)?.retryAfterSeconds;
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return String(Math.max(0, Math.ceil(seconds)));
}

/**
 * One line of failure text for a plain-text channel, such as the MCP
 * `execute_step` tool, whose caller is a planner rather than a chat client.
 *
 * A planner deciding whether to re-issue a step needs the same fact a chat user
 * does, and gets it in the only shape that surface has: prose.
 */
export function failureText(error: unknown): string {
  const limit = throttleOf(error);
  if (limit) return throttleMessage(limit);
  return error instanceof Error ? error.message : String(error);
}

/** Why admission was withheld, in the order admission checks. */
export type DoorRefusalReason = 'session_busy' | 'capacity' | 'retention';

const DOOR_SENTENCES: Record<DoorRefusalReason, string> = {
  session_busy:
    'This session is still working on an earlier request. Wait for it to finish before sending another.',
  capacity: 'The service is at capacity right now. Please try again shortly.',
  retention:
    'The service has no room to hold another session right now. Please try again shortly.',
};

/**
 * The sentence for the person. No number: how long the sessions ahead will run
 * or be held is not something we measure, and inventing one is the guess this
 * design refuses everywhere.
 */
export function doorRefusalSentence(reason: DoorRefusalReason): string {
  return DOOR_SENTENCES[reason];
}

/** A request against a session already closed for deletion. */
export function sessionClosedText(): string {
  return 'This session is being deleted. Send the request again to start a new one.';
}

/** A refusal a handler writes as-is: a status and a JSON body, and no headers. */
export interface HttpRefusal {
  status: number;
  body: unknown;
}

/** `/v1/chat/completions`. */
export function openAiDoorRefusal(reason: DoorRefusalReason): HttpRefusal {
  return {
    status: 503,
    body: {
      error: {
        message: doorRefusalSentence(reason),
        type: 'server_error',
        code: `gatekeeper_${reason}`,
      },
    },
  };
}

/**
 * `/v1/messages`. `overloaded_error` under `529` is the dialect's own pairing,
 * argued above for throttling. The envelope has no field for a reason, so the
 * reason travels in the sentence.
 */
export function anthropicDoorRefusal(reason: DoorRefusalReason): HttpRefusal {
  return {
    status: 529,
    body: {
      type: 'error',
      error: { type: 'overloaded_error', message: doorRefusalSentence(reason) },
    },
  };
}

/** `execute_step`: a failure line whose prefix a planner can branch on. */
export function executeStepDoorRefusal(reason: DoorRefusalReason): string {
  return `gatekeeper_${reason}: ${doorRefusalSentence(reason)}`;
}

/** A chat request whose session was closed after the middleware accepted it. */
export function openAiSessionClosed(): HttpRefusal {
  return {
    status: 410,
    body: {
      error: {
        message: sessionClosedText(),
        type: 'invalid_request_error',
        code: 'session_closed',
      },
    },
  };
}

/** The same, in the Anthropic envelope. */
export function anthropicSessionClosed(): HttpRefusal {
  return {
    status: 410,
    body: {
      type: 'error',
      error: { type: 'invalid_request_error', message: sessionClosedText() },
    },
  };
}

/** A destination we have closed. Temporary, and a 5xx because it is ours. */
export function destinationClosedText(destination: string): string {
  return `SAP system ${destination} is not reachable right now. Other systems are unaffected.`;
}

/**
 * A write we sent and never got an answer for.
 *
 * We cannot tell an applied change from a lost one, because an ADT call is
 * asynchronous in substance. So this neither retries nor assumes. It says what
 * happened and leaves the reading to the consumer, which is what a planner and
 * a human are both for.
 */
export function unverifiedWriteText(
  calls: Array<{ name: string }>,
  cause: string,
): string {
  const names = calls.map((c) => c.name).join(', ');
  const verb = calls.length === 1 ? 'was sent' : 'were sent';
  return `UNVERIFIED_WRITE: ${names} ${verb} and no answer came back (${cause}). It may or may not have been applied, so read the object back before deciding. It was NOT retried.`;
}

/**
 * The shape a channel's `SmartAgentHandle` carries at runtime
 * (`agent-manager.ts` attaches `recMcp`) but that is not part of the
 * library's own type. Shared here so the three channels cast to ONE type
 * instead of each declaring an identical local interface.
 */
export interface RecMcpHandle {
  recMcp?: {
    dropRequest(traceId?: string): void;
    unanswered?(traceId: string): Array<{ call: { name: string } }>;
  };
}

/**
 * The unverified-write text for the failure at `traceId`, or `undefined` when
 * there is nothing pending (no handle, no recMcp, no traceId yet, or simply no
 * unanswered write) — so a call site can do
 * `unverifiedWriteFor(handle, traceId, err) ?? <its existing failure text>`
 * and leave every other failure text exactly as it was.
 */
export function unverifiedWriteFor(
  handle: unknown,
  traceId: string | undefined,
  err: unknown,
): string | undefined {
  if (!traceId) return undefined;
  const pending = (handle as RecMcpHandle)?.recMcp?.unanswered?.(traceId) ?? [];
  if (pending.length === 0) return undefined;
  return unverifiedWriteText(
    pending.map((r) => r.call),
    describeCause(err),
  );
}

/**
 * The Anthropic error envelope carrying an unverified-write message, built
 * once here instead of inline at each Anthropic failure site. `type` defaults
 * to `api_error`; pass `'overloaded_error'` when the same failure is also
 * throttled, so the envelope still pairs with the throttled status (see
 * `statusForError`).
 */
export function anthropicUnverifiedWrite(
  text: string,
  type: string = 'api_error',
): { type: 'error'; error: { type: string; message: string } } {
  return { type: 'error', error: { type, message: text } };
}
