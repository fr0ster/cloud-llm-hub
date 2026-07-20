import {
  buildReviewMessages,
  formatReviewNotice,
  parseReviewVerdict,
  reviewStep,
} from '../../srv/lib/step-reviewer';

describe('buildReviewMessages', () => {
  it('is skeptical, names executed tools, and demands strict JSON', () => {
    const [sys, user] = buildReviewMessages({
      task: 'Create domain ZDEMO_D_MATNR then activate it',
      executedTools: ['ReadDomain'],
      content: 'The domain has been created and is active.',
    });
    expect(sys.role).toBe('system');
    expect(sys.content.toLowerCase()).toContain('skeptic');
    expect(sys.content).toContain('JSON');
    // Honest non-accomplishment must NOT be flagged as fake...
    expect(sys.content.toLowerCase()).toContain('honest');
    // ...but a genuine doubt must still be surfaced explicitly.
    expect(sys.content.toLowerCase()).toContain('unsure');
    expect(user.content).toContain('ReadDomain');
    expect(user.content).toContain('Create domain ZDEMO_D_MATNR');
  });
  it('renders (none) when no tool ran', () => {
    const [, user] = buildReviewMessages({
      task: 't',
      executedTools: [],
      content: 'done',
    });
    expect(user.content).toContain('(none)');
  });
});

describe('parseReviewVerdict', () => {
  it('parses a strict JSON verdict', () => {
    const v = parseReviewVerdict(
      '{"possiblyFake": true, "confidence": "high", "reasons": "claimed create, only ReadDomain ran"}',
    );
    expect(v).toEqual({
      possiblyFake: true,
      confidence: 'high',
      reasons: 'claimed create, only ReadDomain ran',
    });
  });
  it('tolerates surrounding prose / code fences', () => {
    const v = parseReviewVerdict(
      'Here:\n```json\n{"possiblyFake": false, "confidence": "low", "reasons": "ok"}\n```',
    );
    expect(v?.possiblyFake).toBe(false);
  });
  it('extracts the FIRST object even with trailing prose that has braces', () => {
    const v = parseReviewVerdict(
      '{"possiblyFake": true, "confidence": "high", "reasons": "x"}\n\nNote: {see log}',
    );
    expect(v?.possiblyFake).toBe(true);
  });
  it('handles braces inside string values', () => {
    const v = parseReviewVerdict(
      '{"possiblyFake": true, "confidence": "low", "reasons": "claim has {curly} text"}',
    );
    expect(v?.reasons).toBe('claim has {curly} text');
  });
  it('skips a parseable non-verdict object BEFORE the real verdict', () => {
    const v = parseReviewVerdict(
      '{"note": "thinking..."}\n{"possiblyFake": true, "confidence": "high", "reasons": "x"}',
    );
    expect(v?.possiblyFake).toBe(true);
  });
  it('skips an unparseable brace block BEFORE the real verdict', () => {
    const v = parseReviewVerdict(
      'Example: {a: 1, b: 2}\n{"possiblyFake": false, "confidence": "low", "reasons": "ok"}',
    );
    expect(v?.possiblyFake).toBe(false);
  });
  it('recovers the verdict even after an UNTERMINATED brace block', () => {
    const v = parseReviewVerdict(
      'Note: {unterminated and then\n{"possiblyFake": true, "confidence": "high", "reasons": "x"}',
    );
    expect(v?.possiblyFake).toBe(true);
  });
  it('returns null on malformed or invalid output (fail-open)', () => {
    expect(parseReviewVerdict('not json')).toBeNull();
    expect(parseReviewVerdict('{"possiblyFake": "yes"}')).toBeNull();
    expect(parseReviewVerdict('{"confidence": "high"}')).toBeNull();
  });
});

describe('formatReviewNotice', () => {
  it('produces a consumer-facing unverified banner with reasons', () => {
    const n = formatReviewNotice({
      possiblyFake: true,
      confidence: 'high',
      reasons: 'no write tool ran',
    });
    expect(n.toLowerCase()).toContain('unverified');
    expect(n).toContain('no write tool ran');
    expect(n).toContain('high');
  });
});

describe('reviewStep', () => {
  const okLlm = (content: string) => ({
    chat: async () => ({ ok: true as const, value: { content } }),
    streamChat: async function* () {},
  });
  it('returns the parsed verdict from the LLM', async () => {
    const v = await reviewStep(
      { task: 'create X', executedTools: ['ReadDomain'], content: 'created' },
      {
        llm: okLlm(
          '{"possiblyFake": true, "confidence": "high", "reasons": "only read ran"}',
        ) as never,
      },
    );
    expect(v?.possiblyFake).toBe(true);
  });
  it('fails open (null) when the LLM errors', async () => {
    const v = await reviewStep(
      { task: 't', executedTools: [], content: 'c' },
      {
        llm: {
          chat: async () => ({ ok: false as const, error: new Error('boom') }),
          streamChat: async function* () {},
        } as never,
      },
    );
    expect(v).toBeNull();
  });
  it('fails open (null) when the LLM throws', async () => {
    const v = await reviewStep(
      { task: 't', executedTools: [], content: 'c' },
      {
        llm: {
          chat: async () => {
            throw new Error('net');
          },
          streamChat: async function* () {},
        } as never,
      },
    );
    expect(v).toBeNull();
  });
  it('fails open (null) on timeout when the reviewer hangs (ignores the signal)', async () => {
    const hangLlm = {
      chat: () => new Promise(() => {}), // never resolves, ignores abort
      streamChat: async function* () {},
    };
    const v = await reviewStep(
      { task: 't', executedTools: [], content: 'c' },
      { llm: hangLlm as never, timeoutMs: 20 },
    );
    expect(v).toBeNull();
  });
});
