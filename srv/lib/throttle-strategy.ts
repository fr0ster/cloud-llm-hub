/**
 * What this service does when SAP AI Core throttles it.
 *
 * The library establishes the facts and decides nothing, on the grounds that it
 * cannot see who is waiting at the other end. We can: a chat client gives up
 * around a minute, and a request that fans out into a whole tool loop has spent
 * most of that budget before the LLM is even asked twice.
 *
 * So the decision is ours, and it is this: wait while the total stays short
 * enough to be worth waiting, and report anything longer with the number
 * attached. A caller told "try again in ninety seconds" has something to act
 * on; a caller whose connection was cut at sixty has nothing.
 *
 * This is deliberately NOT an `AbortSignal` on the call. A signal bounds the
 * whole agent run, and a tool loop legitimately takes minutes — the deadline we
 * want applies to waiting for a quota, not to doing the work.
 */

import type {
  IThrottleStrategy,
  ThrottleContext,
  ThrottleDecision,
} from '@mcp-abap-adt/llm-agent';

/** Default ceiling on the total wait. Below any client timeout we have seen. */
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
