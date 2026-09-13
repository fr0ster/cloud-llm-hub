import {
  anthropicErrorPayload,
  failureText,
  statusForError,
  throttleMessage,
  throttleOf,
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

describe('the configured wait budget', () => {
  const load = () => {
    jest.resetModules();
    const mod = require('../../srv/agent-config') as {
      clearAgentConfig: () => void;
      getAgentConfig: () => {
        llm: { whenThrottled: { maxTotalWaitMs: number } };
      };
    };
    mod.clearAgentConfig();
    return mod.getAgentConfig();
  };

  afterEach(() => {
    delete process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
    jest.resetModules();
  });

  it('runs out before the caller does, rather than at the same moment', () => {
    // The library default is 60s, which is where our chat clients give up. A
    // budget that expires with the caller never gets to say "retry in N".
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(20_000);
  });

  it('takes an override from the environment', () => {
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '35000';
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(35_000);
  });

  it('honours an explicit zero, which means do not wait at all', () => {
    // The one value an operator writes deliberately. `Number(v) || default`
    // could not tell it from nonsense and quietly substituted 20s.
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '0';
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(0);
  });

  it('refuses a value it cannot honour, rather than half-applying it', () => {
    for (const bad of ['soon', '-1', 'Infinity', '1.5', 'NaN']) {
      process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = bad;
      expect(() => load()).toThrow(/LLM_AGENT_THROTTLE_MAX_WAIT_MS/);
    }
  });

  it('uses the default when the variable is absent or blank', () => {
    delete process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(20_000);
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '   ';
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(20_000);
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

  it('names the Anthropic error type a client already handles', () => {
    const payload = anthropicErrorPayload(throttled(30));
    expect(payload.type).toBe('error');
    expect(payload.error.type).toBe('rate_limit_error');
    expect(payload.error.message).toContain('30 seconds');
  });

  it('leaves an ordinary failure as an api_error with its own message', () => {
    const payload = anthropicErrorPayload(new Error('Class ZCL_X not found'));
    expect(payload.error.type).toBe('api_error');
    expect(payload.error.message).toBe('Class ZCL_X not found');
  });

  it('answers 429 for a closed quota and 500 for our own failure', () => {
    // 500 tells a client the fault is ours and the request is not worth
    // repeating. For a quota that reopens in seconds, both halves are wrong.
    expect(statusForError(throttled(12))).toBe(429);
    expect(statusForError(new Error('Class ZCL_X not found'))).toBe(500);
  });

  it('gives the planner the same fact in the shape execute_step has', () => {
    expect(failureText(throttled(42))).toContain('42 seconds');
    expect(failureText(new Error('Class ZCL_X not found'))).toBe(
      'Class ZCL_X not found',
    );
  });
});
