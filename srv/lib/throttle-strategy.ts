/**
 * What this service does when SAP AI Core throttles it.
 *
 * Every caller in this process spends one AI Core account, so a 429 is a queue,
 * not a failure: by default (`WaitAsNeeded`) each caller waits exactly as long
 * as the server named, with no total ceiling. Streaming clients stay connected
 * through SSE keep-alive. A 429 without an interval is answered with bounded
 * exponential backoff, since it may be a spend cap that never clears.
 * `WaitIfShortEnough` remains the opt-in ceiling (`LLM_AGENT_THROTTLE_MAX_WAIT_MS`).
 *
 * This is deliberately NOT an `AbortSignal` on the call. A signal bounds the
 * whole agent run, and a tool loop legitimately takes minutes — the deadline we
 * want applies to waiting for a quota, not to doing the work.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  IThrottleStrategy,
  ThrottleContext,
  ThrottleDecision,
} from '@mcp-abap-adt/llm-agent';

/** Legacy default for callers that explicitly construct WaitIfShortEnough. */
export const DEFAULT_MAX_THROTTLE_WAIT_MS = 20_000;

export class WaitIfShortEnough implements IThrottleStrategy {
  readonly name = 'wait-if-short-enough';

  constructor(
    private readonly maxWaitMs: number = DEFAULT_MAX_THROTTLE_WAIT_MS,
  ) {}

  decide({ retryAfterSeconds, waitedMs }: ThrottleContext): ThrottleDecision {
    const waitMs = (retryAfterSeconds ?? 0) * 1000;

    // No interval named. Not a zero to wait out: the header is documented, so
    // its absence says something is off — and where it is absent by design, as
    // on a spend cap, waiting would never end.
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      return { waitMs: 0, retry: false, reason: 'no-interval' };
    }

    // The ceiling is on the TOTAL, not on one interval. Five intervals of
    // twenty seconds are not five short waits, they are a hundred seconds and a
    // cut connection — the very thing this strategy exists to avoid. The
    // library passes `waitedMs` for exactly this, and an earlier version of
    // this file ignored it while claiming to bound the wait.
    if (waitedMs + waitMs > this.maxWaitMs) {
      return {
        waitMs,
        retry: false,
        reason: waitedMs > 0 ? 'budget-spent' : 'longer-than-we-wait',
      };
    }

    return { waitMs, retry: true };
  }
}

// The strategy is shared by providers, but unnamed retries belong to one call.
const throttleCall = new AsyncLocalStorage<{ unnamed: number }>();
export function withThrottleCall<T>(run: () => T): T {
  return throttleCall.run({ unnamed: 0 }, run);
}

/** One AI Core account is a queue; SSE heartbeats keep its callers connected. */
export class WaitAsNeeded implements IThrottleStrategy {
  readonly name = 'wait-as-needed';

  decide({ retryAfterSeconds, attempt }: ThrottleContext): ThrottleDecision {
    if (
      retryAfterSeconds !== undefined &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    )
      return { waitMs: retryAfterSeconds * 1000, retry: true };
    const call = throttleCall.getStore();
    const unnamed = call ? ++call.unnamed : attempt;
    // A missing interval may be a spend cap. Bound only these speculative waits.
    if (unnamed > 6) return { waitMs: 0, retry: false, reason: 'no-interval' };
    const base = Math.min(60_000, 2000 * 2 ** Math.max(0, unnamed - 1));
    return {
      waitMs: Math.min(60_000, Math.round(base * (0.8 + Math.random() * 0.4))),
      retry: true,
    };
  }
}

/** Re-enter the same scope for each async iterator next(). */
export function throttleCallScope(): <T>(run: () => T) => T {
  const state = { unnamed: 0 };
  return (run) => throttleCall.run(state, run);
}
