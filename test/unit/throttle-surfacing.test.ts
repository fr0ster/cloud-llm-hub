import { throttleMessage, throttleOf } from '../../srv/openai-handler';

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

  it('falls back to the default on an unusable value', () => {
    process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = 'soon';
    expect(load().llm.whenThrottled.maxTotalWaitMs).toBe(20_000);
  });
});
