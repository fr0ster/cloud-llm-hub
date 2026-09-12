import { rateLimitMessage, rateLimitOf } from '../../srv/openai-handler';

/**
 * Since llm-agent 22.2.0 the provider answers 429 itself — backing off,
 * honouring Retry-After and holding one shared pause per quota. This handler no
 * longer retries; it reports. These tests cover what it reports and, more
 * importantly, what it must NOT mistake for a rate limit.
 */
describe('rateLimitOf', () => {
  it('reads the marker the provider attached, with the wait', () => {
    const error = Object.assign(new Error('SAP AI SDK API error: 429'), {
      rateLimited: true,
      attempts: 5,
      retryAfterSeconds: 42,
    });
    expect(rateLimitOf(error)).toEqual({ retryAfterSeconds: 42 });
  });

  it('finds the marker through a cause chain', () => {
    const inner = Object.assign(new Error('429'), {
      rateLimited: true,
      attempts: 3,
      retryAfterSeconds: 7,
    });
    const outer = new Error('Agent failed');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(rateLimitOf(outer)).toEqual({ retryAfterSeconds: 7 });
  });

  it('still recognises a structured 429 that lost the marker', () => {
    expect(rateLimitOf({ response: { status: 429 } })).toEqual({});
    expect(rateLimitOf({ status: 429 })).toEqual({});
  });

  it('recognises the status named in the text', () => {
    expect(rateLimitOf(new Error('HTTP 429 Too Many Requests'))).toEqual({});
    expect(rateLimitOf(new Error('rate limit exceeded'))).toEqual({});
  });

  it('does not fire on digits that merely contain 429', () => {
    // The old matcher used includes('429') and called all of these rate limits.
    expect(rateLimitOf(new Error('object 4290 not found'))).toBeUndefined();
    expect(rateLimitOf(new Error('read 14293 bytes'))).toBeUndefined();
    expect(rateLimitOf(new Error('total_tokens: 4295'))).toBeUndefined();
  });

  it('leaves an ordinary failure alone', () => {
    expect(rateLimitOf(new Error('Class ZCL_X not found'))).toBeUndefined();
    expect(rateLimitOf({ response: { status: 500 } })).toBeUndefined();
    expect(rateLimitOf(undefined)).toBeUndefined();
  });
});

describe('rateLimitMessage', () => {
  it('tells the caller when to come back when the server said', () => {
    expect(rateLimitMessage({ retryAfterSeconds: 12.3 })).toContain(
      'about 13 seconds',
    );
  });

  it('stays useful when the server said nothing', () => {
    const msg = rateLimitMessage({});
    expect(msg).toContain('rate-limited');
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('NaN');
  });
});
