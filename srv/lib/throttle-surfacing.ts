/**
 * Reporting an exhausted throttle policy to the caller.
 *
 * Shared by every channel rather than kept in one handler: the promise is that
 * a caller is told when to come back, and a promise kept on one of three
 * surfaces is not kept. The provider does the waiting (llm-agent 23.0.0); this
 * only reads what it concluded.
 */

import { findThrottled } from '@mcp-abap-adt/llm-agent';

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
