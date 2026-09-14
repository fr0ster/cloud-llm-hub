import {
  anthropicErrorPayload,
  failureText,
  retryAfterHeader,
  statusForError,
  throttleMessage,
  throttleOf,
  unverifiedWriteText,
} from '../../srv/lib/throttle-surfacing';

/**
 * Since llm-agent 22.2.0 the provider answers 429 itself — backing off,
 * honouring Retry-After and holding one shared pause per quota. This handler no
 * longer retries; it reports. These tests cover what it reports and, more
 * importantly, what it must NOT mistake for a rate limit.
 */
describe('throttleOf', () => {
  it('reads the marker the provider attached, with the wait', () => {
    const error = Object.assign(new Error('SAP AI SDK API error: 429'), {
      throttled: true,
      attempts: 5,
      retryAfterSeconds: 42,
      reason: 'budget',
    });
    expect(throttleOf(error)).toEqual({
      retryAfterSeconds: 42,
      reason: 'budget',
    });
  });

  it('finds the marker through a cause chain', () => {
    const inner = Object.assign(new Error('429'), {
      throttled: true,
      attempts: 3,
      retryAfterSeconds: 7,
      reason: 'attempts',
    });
    const outer = new Error('Agent failed');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(throttleOf(outer)).toEqual({
      retryAfterSeconds: 7,
      reason: 'attempts',
    });
  });

  it('still recognises a structured 429 that lost the marker', () => {
    expect(throttleOf({ response: { status: 429 } })).toEqual({});
    expect(throttleOf({ status: 429 })).toEqual({});
  });

  it('recognises the status named in the text', () => {
    expect(throttleOf(new Error('HTTP 429 Too Many Requests'))).toEqual({});
    expect(throttleOf(new Error('rate limit exceeded'))).toEqual({});
  });

  it('does not fire on digits that merely contain 429', () => {
    // The old matcher used includes('429') and called all of these rate limits.
    expect(throttleOf(new Error('object 4290 not found'))).toBeUndefined();
    expect(throttleOf(new Error('read 14293 bytes'))).toBeUndefined();
    expect(throttleOf(new Error('total_tokens: 4295'))).toBeUndefined();
  });

  it('leaves an ordinary failure alone', () => {
    expect(throttleOf(new Error('Class ZCL_X not found'))).toBeUndefined();
    expect(throttleOf({ response: { status: 500 } })).toBeUndefined();
    expect(throttleOf(undefined)).toBeUndefined();
  });
});

describe('throttleMessage', () => {
  it('tells the caller when to come back when the server said', () => {
    expect(throttleMessage({ retryAfterSeconds: 12.3 })).toContain(
      'about 13 seconds',
    );
  });

  it('stays useful when the server said nothing', () => {
    const msg = throttleMessage({});
    expect(msg).toContain('rate-limited');
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('NaN');
  });
});

describe('the configured wait ceiling', () => {
  const load = () => {
    jest.resetModules();
    const mod = require('../../srv/agent-config') as {
      clearAgentConfig: () => void;
      getAgentConfig: () => {
        llm: {
          whenThrottled: { name: string; decide: (c: unknown) => unknown };
        };
      };
    };
    mod.clearAgentConfig();
    return mod.getAgentConfig();
  };

  const decideFor = (seconds: number | undefined) =>
    load().llm.whenThrottled.decide({
      source: 'response',
      attempt: 1,
      retryAfterSeconds: seconds,
      waitedMs: 0,
    }) as { retry: boolean; reason?: string; waitMs: number };

  afterEach(() => {
    delete process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
    jest.resetModules();
  });

  it('installs our own strategy, not the library default', () => {
    // The library decides nothing on purpose. We can decide, because we know
    // our callers give up around a minute.
    expect(load().llm.whenThrottled.name).toBe('wait-if-short-enough');
  });

  it('waits out an interval short enough to be worth waiting', () => {
    expect(decideFor(5)).toEqual({ waitMs: 5000, retry: true });
  });

  it('counts the intervals together, not one at a time', () => {
    // Five twenty-second intervals are not five short waits. An earlier version
    // looked only at the interval in hand and would have waited a hundred
    // seconds — the cut connection this strategy exists to prevent.
    const strategy = load().llm.whenThrottled;
    const decide = (seconds: number, waitedMs: number) =>
      strategy.decide({
        source: 'response',
        attempt: 1,
        retryAfterSeconds: seconds,
        waitedMs,
      }) as { retry: boolean; reason?: string };

    expect(decide(15, 0).retry).toBe(true);
    expect(decide(15, 10_000).retry).toBe(false);
    expect(decide(15, 10_000).reason).toBe('budget-spent');
  });

  it('reports an interval longer than we will hold a connection', () => {
    // A caller told "try again in ninety seconds" has something to act on; a
    // caller whose connection was cut at sixty has nothing.
    const decision = decideFor(90);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe('longer-than-we-wait');
    expect(decision.waitMs).toBe(90_000);
  });

  it('reports rather than guessing when the server named nothing', () => {
    const decision = decideFor(undefined);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe('no-interval');
  });

  it('takes the ceiling from the environment', () => {
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '35000';
    expect(decideFor(30).retry).toBe(true);
  });

  it('honours an explicit zero, which means never wait', () => {
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '0';
    expect(decideFor(1).retry).toBe(false);
  });

  it('refuses a ceiling it cannot honour', () => {
    for (const bad of ['soon', '-1', 'Infinity', '1.5', 'NaN']) {
      process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = bad;
      expect(() => load()).toThrow(/LLM_AGENT_THROTTLE_MAX_WAIT_MS/);
    }
  });
});

describe('the wire shapes every channel sends', () => {
  // These are the functions the handlers call. The previous version of this
  // test rebuilt the envelope beside the handler, which would have stayed green
  // if the handler stopped sending it at all.
  const throttled = (seconds: number) =>
    Object.assign(new Error('SAP AI SDK streaming error'), {
      throttled: true,
      attempts: 5,
      retryAfterSeconds: seconds,
      reason: 'budget',
    });

  it('names an upstream overload, not a caller who sent too much', () => {
    const payload = anthropicErrorPayload(throttled(30));
    expect(payload.type).toBe('error');
    expect(payload.error.type).toBe('overloaded_error');
    expect(payload.error.message).toContain('30 seconds');
  });

  it('leaves an ordinary failure as an api_error with its own message', () => {
    const payload = anthropicErrorPayload(new Error('Class ZCL_X not found'));
    expect(payload.error.type).toBe('api_error');
    expect(payload.error.message).toBe('Class ZCL_X not found');
  });

  it('answers 529 for a closed quota, not 429', () => {
    // 429 says THIS caller sent too many requests. It did not: the caller does
    // not set the rate, and one chat request fans out into as many LLM calls as
    // the tool loop needs, so its request count says nothing about the quota it
    // spends. Temporarily unable, and we know when — that is a 5xx.
    //
    // 529 of them, because this endpoint speaks Anthropic's dialect, where
    // overloaded_error is paired with 529. Their type under another status is
    // a pairing their clients have never seen.
    expect(statusForError(throttled(12))).toBe(529);
    expect(statusForError(new Error('Class ZCL_X not found'))).toBe(500);
  });

  it('puts the same number in Retry-After, rounded up', () => {
    // Prose for a human, header for a client retrying on its own. Rounded up
    // because waking early means walking back into a closed quota.
    expect(retryAfterHeader(throttled(12.2))).toBe('13');
    expect(retryAfterHeader(throttled(30))).toBe('30');
    expect(
      retryAfterHeader(new Error('Class ZCL_X not found')),
    ).toBeUndefined();
  });

  it('omits the header when the server never said how long', () => {
    const noNumber = Object.assign(new Error('429'), {
      throttled: true,
      attempts: 5,
      reason: 'attempts',
    });
    expect(retryAfterHeader(noNumber)).toBeUndefined();
  });

  it('gives the planner the same fact in the shape execute_step has', () => {
    expect(failureText(throttled(42))).toContain('42 seconds');
    expect(failureText(new Error('Class ZCL_X not found'))).toBe(
      'Class ZCL_X not found',
    );
  });
});

describe('unverifiedWriteText', () => {
  it('uses singular "was sent" for one name', () => {
    const text = unverifiedWriteText(
      [{ name: 'CreateClass' }],
      'socket hang up',
    );
    expect(text).toContain(
      'UNVERIFIED_WRITE: CreateClass was sent and no answer came back (socket hang up)',
    );
    expect(text).toContain('It was NOT retried.');
  });

  it('uses plural "were sent" for several names', () => {
    const text = unverifiedWriteText(
      [{ name: 'CreateClass' }, { name: 'ActivateClass' }],
      'timeout',
    );
    expect(text).toContain(
      'UNVERIFIED_WRITE: CreateClass, ActivateClass were sent and no answer came back (timeout)',
    );
  });
});
