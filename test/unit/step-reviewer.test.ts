import type { ILlm, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import {
  buildReviewMessages,
  evaluateGated,
  parseReviewVerdict,
  reviewStep,
} from '../../srv/lib/step-reviewer';

function record(
  name: string,
  content: string | Record<string, unknown>,
): ToolCallRecord {
  return { call: { id: '', name, arguments: {} }, result: { content } };
}

// The reviewer used to receive an empty task and no earlier turns, so it judged
// every answer as the first thing ever said. Asked "what is my favourite number"
// after the user had supplied 42, the executor answered "42" and was flagged
// high-confidence fake: a concrete statement after zero tool calls is exactly
// its rule, and the turn that made the statement true was not in front of it.
// The critic used to be handed tool NAMES. Told that only CreateDataElement ran,
// it declared the executor's "activated" claim unsupported because no Activate*
// appeared — and attached a high-confidence notice to a data element that had in
// fact been created AND activated. A create tool activates as part of its own
// call and reports it in the RESULT, which the deterministic layer has always
// read and the critic never saw.
describe('buildReviewMessages — tools are shown by outcome, not by name', () => {
  it('renders success, status and error from the result', () => {
    const [, user] = buildReviewMessages({
      task: 'create a data element',
      executedTools: [
        { name: 'CreateDataElement', ok: true, status: 'active' },
        { name: 'GetDomain', ok: false, error: 'not found' },
      ],
      content: 'created and activated',
    });
    expect(user.content).toContain('CreateDataElement → ok, status=active');
    expect(user.content).toContain('GetDomain → failed, error=not found');
  });

  it('tells the reviewer that tools are not its concern at all', () => {
    // The whole class of false notices came from this reviewer reasoning about
    // tool lists. Whether the right tool ran is a deterministic question with a
    // deterministic answer; asking a language model to guess at it produced
    // three wrong warnings in one day.
    const [system] = buildReviewMessages({
      task: 't',
      executedTools: [],
      content: 'c',
    });
    expect(system.content).toContain('Do NOT reason about tools');
    expect(system.content).toContain('Never flag');
  });

  it('still accepts bare names', () => {
    const [, user] = buildReviewMessages({
      task: 't',
      executedTools: ['ReadDomain'],
      content: 'c',
    });
    expect(user.content).toContain('ReadDomain');
  });
});

describe('buildReviewMessages — the conversation the step belongs to', () => {
  const history = [
    { role: 'user', content: 'my favourite number is 42' },
    { role: 'assistant', content: 'noted' },
  ];

  it('shows the earlier turns and the task', () => {
    const [, user] = buildReviewMessages({
      task: 'What is my favourite number?',
      executedTools: [],
      content: '42',
      history,
    });
    expect(user.content).toContain('CONVERSATION SO FAR');
    expect(user.content).toContain('user: my favourite number is 42');
    expect(user.content).toContain('What is my favourite number?');
  });

  it('says so when the caller recorded no task, rather than showing a blank', () => {
    const [, user] = buildReviewMessages({
      task: '',
      executedTools: [],
      content: '42',
    });
    expect(user.content).toContain('(not recorded)');
    expect(user.content).not.toContain('CONVERSATION SO FAR');
  });

  it('tells the reviewer that the conversation is available to the response', () => {
    const [system] = buildReviewMessages({
      task: 't',
      executedTools: [],
      content: 'c',
    });
    expect(system.content).toContain('CONVERSATION SO FAR');
    expect(system.content).toContain('not an invention');
  });

  it('puts the user request in front of the composed task', () => {
    const [, user] = buildReviewMessages({
      request: 'зроби елемент даних на основі того домена',
      task: 'Task: create a data element',
      executedTools: [],
      content: 'done',
    });
    expect(user.content).toContain('USER REQUEST');
    expect(user.content).toContain('зроби елемент даних');
    expect(user.content).toContain('TASK (as composed for the executor)');
  });

  it('caps how much conversation it carries', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `turn ${i} ${'x'.repeat(2000)}`,
    }));
    const [, user] = buildReviewMessages({
      task: 't',
      executedTools: [],
      content: 'c',
      history: long,
    });
    // Oldest turns dropped, and each surviving turn clipped.
    expect(user.content).not.toContain('turn 0 ');
    expect(user.content).toContain('turn 29 ');
    expect(user.content).toContain('…');
  });
});

describe('buildReviewMessages', () => {
  it('asks one question and demands strict JSON', () => {
    const [sys, user] = buildReviewMessages({
      request: 'Create domain ZDEMO_D_MATNR then activate it',
      task: 'Create domain ZDEMO_D_MATNR then activate it',
      executedTools: ['ReadDomain'],
      content: 'The domain has been created and is active.',
    });
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('ONE question');
    expect(sys.content).toContain('JSON');
    // Honest non-accomplishment must NOT be flagged as fake.
    expect(sys.content.toLowerCase()).toContain('honest');
    // And an unsure reviewer must stay quiet rather than warn on a good answer.
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
    'LLM_AGENT_STEP_REVIEW_ENABLED',
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

  it.each([
    ['chat', 'Hello', undefined, 0, false],
    ['identifier', 'Read ZDOMAIN', undefined, 0, true],
    ['score', 'List objects', 0.48, 0, true],
    ['warmup', 'Hello', undefined, 1000, false],
  ])(
    '%s gates review',
    async (model, request, topToolScore, completionTokens, called) => {
      const llm = okLlm(
        '{"possiblyFake":false,"confidence":"low","reasons":"ok"}',
      );
      await evaluateGated({
        content: 'Hello',
        records: [],
        llm: llm as never,
        request,
        topToolScore,
        completionTokens,
        model,
      });
      expect(llm.chat).toHaveBeenCalledTimes(called ? 1 : 0);
    },
  );
  it('records skipped steps and detects anomalies after warmup', async () => {
    const llm = okLlm(
      '{"possiblyFake":false,"confidence":"low","reasons":"ok"}',
    );
    for (let i = 0; i < 20; i++)
      await evaluateGated({
        content: 'Hi',
        request: 'Hi',
        records: [],
        llm: llm as never,
        completionTokens: 100,
        model: 'warm-model',
      });
    expect(llm.chat).not.toHaveBeenCalled();
    await evaluateGated({
      content: 'Hi',
      records: [],
      llm: llm as never,
      completionTokens: 1000,
      model: 'warm-model',
    });
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
  it('normal tools skip review while deterministic issues survive', async () => {
    const llm = okLlm('');
    const records = [record('ReadDomain', '{"success":true}')];
    expect(
      await evaluateGated({
        content: 'Read successfully.',
        request: 'Read ZDOMAIN',
        records,
        llm: llm as never,
      }),
    ).toEqual({ ok: true });
    expect(
      (
        await evaluateGated({
          content: 'The domain has been activated successfully.',
          records,
          llm: llm as never,
        })
      ).ok,
    ).toBe(false);
    expect(llm.chat).not.toHaveBeenCalled();
  });
  it('merges a suspicious critic issue with a deterministic issue', async () => {
    const llm = okLlm(
      '{"possiblyFake":true,"confidence":"high","reasons":"wrong task"}',
    );
    const verdict = await evaluateGated({
      content: 'The domain has been activated successfully.',
      request: 'Activate ZDOMAIN',
      records: [],
      llm: llm as never,
    });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.issues.map((i) => i.kind)).toEqual([
        'unverified-write',
        'unsupported-claim',
      ]);
  });
  it('a suspicious critic failure leaves the deterministic verdict intact', async () => {
    const llm = {
      chat: jest.fn(async () => {
        throw new Error('network');
      }),
      streamChat: async function* () {},
    };
    expect(
      await evaluateGated({
        content: 'I cannot do that.',
        request: 'Read ZDOMAIN',
        records: [],
        llm: llm as never,
      }),
    ).toEqual({ ok: true });
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
  it('kill switch: returns {ok: true} on a clear write mismatch when disabled, without invoking the LLM critic', async () => {
    process.env.LLM_AGENT_STEP_REVIEW_ENABLED = 'false';
    const llm = okLlm(
      '{"possiblyFake": true, "confidence": "high", "reasons": "should not be seen"}',
    );
    const verdict = await evaluateGated({
      content: 'The domain has been activated successfully.',
      records: [record('CreateDomain', '{"success":true,"status":"inactive"}')],
      llm: llm as never,
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(verdict).toEqual({ ok: true });
  });

  it('kill switch: unset env leaves the deterministic mismatch behavior unchanged', async () => {
    expect(process.env.LLM_AGENT_STEP_REVIEW_ENABLED).toBeUndefined();
    const llm = okLlm(
      '{"possiblyFake": false, "confidence": "low", "reasons": "ok"}',
    );
    const verdict = await evaluateGated({
      content: 'The domain has been activated successfully.',
      records: Array.from({ length: 5 }, () =>
        record('ReadDomain', '{"success":true}'),
      ),
      llm: llm as never,
    });
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

test.each(['false', 'true', 'invalid'])(
  'reviewer preserves model usage for verdict %s',
  async (verdict) => {
    const usage = { promptTokens: 7, completionTokens: 4, totalTokens: 11 };
    const llm: ILlm = {
      model: 'critic',
      chat: async () => ({
        ok: true,
        value: {
          content:
            verdict === 'invalid'
              ? 'invalid'
              : `{"possiblyFake":${verdict},"confidence":"high","reasons":"test"}`,
          finishReason: 'stop',
          usage,
        },
      }),
      streamChat: async function* () {},
    };
    const result = await evaluateGated({
      content: 'answer',
      request: 'Read ZDOMAIN',
      records: [],
      llm,
    });
    expect(result.usage).toEqual({
      ...usage,
      models: { critic: { ...usage, requests: 1 } },
    });
  },
);
