import {
  buildReviewMessages,
  evaluateGated,
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

describe('evaluateGated', () => {
  const ENV_KEYS = [
    'LLM_AGENT_STEP_REVIEW_MAX_TOOLCALLS',
    'LLM_AGENT_STEP_REVIEW_MIN_TOKENS',
    'LLM_AGENT_STEP_REVIEW_TIMEOUT_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const okLlm = (content: string) => {
    const chat = jest.fn(async () => ({
      ok: true as const,
      value: { content },
    }));
    return { chat, streamChat: async function* () {} };
  };

  it('does NOT invoke the LLM critic when tokens/tool-calls are above threshold', async () => {
    const llm = okLlm(
      '{"possiblyFake": true, "confidence": "high", "reasons": "should not be seen"}',
    );
    const verdict = await evaluateGated({
      content: 'Read complete.',
      executedTools: ['ReadDomain'],
      totalTokens: 5000,
      toolCallCount: 5,
      llm: llm as never,
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(verdict).toEqual({ ok: true });
  });

  it('invokes the LLM critic when tokens are below threshold (suspicious)', async () => {
    const llm = okLlm(
      '{"possiblyFake": true, "confidence": "high", "reasons": "claimed create, only read ran"}',
    );
    const verdict = await evaluateGated({
      content: 'Created successfully.',
      executedTools: ['ReadDomain'],
      totalTokens: 10,
      toolCallCount: 1,
      llm: llm as never,
    });
    expect(llm.chat).toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.issues.some((i) => i.kind === 'unsupported-claim')).toBe(
        true,
      );
    }
  });

  it('fails open when the LLM critic throws — verdict unchanged, no spurious problem', async () => {
    const llm = {
      chat: jest.fn(async () => {
        throw new Error('net');
      }),
      streamChat: async function* () {},
    };
    const verdict = await evaluateGated({
      content: 'All good, nothing written.',
      executedTools: ['ReadDomain'],
      totalTokens: 10,
      toolCallCount: 1,
      llm: llm as never,
    });
    expect(llm.chat).toHaveBeenCalled();
    expect(verdict).toEqual({ ok: true });
  });

  it('fails open on timeout — verdict unchanged, no spurious problem', async () => {
    process.env.LLM_AGENT_STEP_REVIEW_TIMEOUT_MS = '20';
    const llm = {
      chat: jest.fn(() => new Promise(() => {})),
      streamChat: async function* () {},
    };
    const verdict = await evaluateGated({
      content: 'All good, nothing written.',
      executedTools: ['ReadDomain'],
      totalTokens: 10,
      toolCallCount: 1,
      llm: llm as never,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('surfaces a deterministic write mismatch regardless of the token gate', async () => {
    const llm = okLlm(
      '{"possiblyFake": false, "confidence": "low", "reasons": "ok"}',
    );
    const verdict = await evaluateGated({
      content: 'The domain has been activated successfully.',
      executedTools: ['ReadDomain'],
      totalTokens: 5000, // well above threshold — LLM should NOT even be needed
      toolCallCount: 5,
      llm: llm as never,
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.issues).toEqual([
        expect.objectContaining({
          kind: 'unverified-write',
          claimedOp: 'activated',
        }),
      ]);
    }
  });

  it('merges LLM-found issues with an existing deterministic issue when both fire', async () => {
    const llm = okLlm(
      '{"possiblyFake": true, "confidence": "medium", "reasons": "extra doubt"}',
    );
    const verdict = await evaluateGated({
      content: 'The domain has been activated successfully.',
      executedTools: ['ReadDomain'],
      totalTokens: 10, // below threshold — LLM runs too
      toolCallCount: 1,
      llm: llm as never,
    });
    expect(llm.chat).toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.issues.map((i) => i.kind).sort()).toEqual([
        'unsupported-claim',
        'unverified-write',
      ]);
    }
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
