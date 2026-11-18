import {
  type IQueryEmbedding,
  type IRag,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { parseToolGate, parseToolGateTimeoutMs } from '../../srv/agent-config';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import { getReviewSignals } from '../../srv/lib/review-scope';
import { ToolQueryAnalyzer } from '../../srv/lib/tool-query-analyzer';
import {
  runWithSessionId,
  runWithToolGateBypass,
} from '../../srv/request-session';

const response = (translation: string, needsAbapSystem: unknown) =>
  JSON.stringify({ translation, needsAbapSystem, writes: false });
const make = (content: string) => {
  const chat = jest.fn().mockResolvedValue({ ok: true, value: { content } });
  return { chat, analyzer: new ToolQueryAnalyzer({ chat } as any) };
};

it('parses strict plain JSON', async () => {
  expect(
    await make(response('Hello', false)).analyzer.analyze('Hello'),
  ).toEqual({ text: 'Hello', needsAbapSystem: false, writes: false });
});
it.each([
  'invalid',
  '```json\n{}\n```',
  'null',
  response('translated', 'false'),
  response('', false),
])('keeps tools for invalid output %s and retries', async (content) => {
  const { chat, analyzer } = make(content);
  const input = '\u0430'.repeat(20);
  const result = await analyzer.analyze(input);
  expect(result.needsAbapSystem).toBe(true);
  expect(result.text).toBe(input);
  await analyzer.analyze(input);
  expect(chat).toHaveBeenCalledTimes(2);
});
it('classifies ASCII and short non-ASCII, keys by bounded history, and shares requests', async () => {
  const { chat, analyzer } = make(response('Hello', false));
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: 'user' as const,
    content: `${i}${'x'.repeat(700)}`,
  }));
  await Promise.all([
    analyzer.analyze('Hello', history),
    analyzer.analyze('Hello', history),
  ]);
  expect(chat).toHaveBeenCalledTimes(1);
  const context = JSON.parse(
    chat.mock.calls[0][0][1].content.split('context only): ')[1],
  );
  expect(context).toHaveLength(6);
  expect(context[0].content).toHaveLength(500);
  expect(context[0].content[0]).toBe('2');
  await analyzer.analyze('Hello', history.slice(2));
  expect(chat).toHaveBeenCalledTimes(1);
  await analyzer.analyze('Hello', []);
  await analyzer.analyze('hey');
  await analyzer.analyze('abc');
  expect(chat).toHaveBeenCalledTimes(4);
});
it('resets the factory after a failed chat', async () => {
  const chat = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      ok: true,
      value: { content: response('Hello', false) },
    });
  const factory = jest.fn().mockResolvedValue({ chat });
  const analyzer = new ToolQueryAnalyzer(factory as any);
  await analyzer.analyze('Hello');
  await analyzer.analyze('Hello');
  expect(factory).toHaveBeenCalledTimes(2);
});
it('translation-only mode calls the model for ASCII and short text', async () => {
  const { analyzer, chat } = make('English');
  for (const text of ['ASCII request', 'abc']) {
    expect(await analyzer.analyze(text, [], { translationOnly: true })).toEqual(
      {
        text: 'English',
        needsAbapSystem: true,
      },
    );
  }
  expect(chat).toHaveBeenCalledTimes(2);
});

const rows = [
  { score: 0.8, metadata: { id: 'GetClass', exposition: 'readonly' } },
  { score: 0.9, metadata: { id: 'skill:read' } },
];
const trustedRows = [
  rows[0],
  {
    ...rows[1],
    metadata: { ...rows[1].metadata, source: 'system:skills/read', trust: 4.8 },
  },
];
it.each(['closed', 'true', 'bypass', 'off', 'unconfigured'])(
  'RAG gate %s waits for analysis and uses translation before applying the gate',
  async (mode) => {
    let resolve!: (value: { text: string; needsAbapSystem: boolean }) => void;
    const analyze = jest.fn(
      () =>
        new Promise<{ text: string; needsAbapSystem: boolean }>((r) => {
          resolve = r;
        }),
    );
    const query = jest.fn().mockResolvedValue({ ok: true, value: rows });
    const rag = new ExpositionFilteringRag(
      { query } as any,
      undefined,
      undefined,
      3,
      mode === 'unconfigured' ? undefined : ({ analyze } as any),
      undefined,
      mode === 'off' ? 'off' : 'classifier',
    );
    const run = () =>
      rag.query(new TextOnlyEmbedding('Hello there'), 5, {
        ragFilter: { exposition: ['readonly'] },
      });
    const pending = runWithSessionId(
      'session',
      () => (mode === 'bypass' ? runWithToolGateBypass(run) : run()),
      [{ role: 'user', content: 'prior' }],
    );
    if (mode !== 'unconfigured') {
      expect(query).not.toHaveBeenCalled();
      expect(analyze.mock.calls[0]).toEqual([
        'Hello there',
        [{ role: 'user', content: 'prior' }],
        {
          ragFilter: { exposition: ['readonly'] },
        },
      ]);
      resolve({ text: 'Translated request', needsAbapSystem: mode === 'true' });
    }
    const result = await pending;
    expect(query.mock.calls[0][0].text).toBe(
      mode === 'unconfigured' ? 'Hello there' : 'Translated request',
    );
    expect(result).toEqual({
      ok: true,
      value: mode === 'closed' ? [] : trustedRows,
    });
  },
);
it('validates tool gate configuration', () => {
  expect(parseToolGate(undefined)).toBe('classifier');
  expect(parseToolGate('classifier')).toBe('classifier');
  expect(parseToolGate('off')).toBe('off');
  expect(() => parseToolGate('other')).toThrow('LLM_AGENT_TOOL_GATE');
});

it('uses the translation for short non-ASCII text', async () => {
  const { analyzer, chat } = make(response('English translation', false));
  expect(
    await analyzer.analyze('\u043f\u0440\u0438\u0432\u0456\u0442'),
  ).toEqual({
    text: 'English translation',
    needsAbapSystem: false,
    writes: false,
  });
  expect(chat).toHaveBeenCalledTimes(1);
});
it('records the top tool score even when the gate closes', async () => {
  const { getReviewSignals } = await import('../../srv/lib/review-scope');
  const { analyzer } = make(response('Hello', false));
  const query = jest.fn().mockResolvedValue({ ok: true, value: rows });
  const rag = new ExpositionFilteringRag(
    { query } as any,
    undefined,
    undefined,
    3,
    analyzer,
  );
  await runWithSessionId('score', async () => {
    await rag.query(new TextOnlyEmbedding('Hello'), 5, {
      ragFilter: { exposition: ['readonly'] },
    });
    expect(getReviewSignals()?.topToolScore).toBe(0.8);
  });
});
it.each([
  'Zeige die Felder der Tabelle MARA',
  'pokazhy korotki dampy za sohodni',
])('translates %s before searching', async (text) => {
  let resolve!: (value: { text: string; needsAbapSystem: boolean }) => void;
  const analyze = jest.fn(
    () =>
      new Promise<{ text: string; needsAbapSystem: boolean }>((r) => {
        resolve = r;
      }),
  );
  const query = jest.fn().mockResolvedValue({ ok: true, value: [] });
  const rag = new ExpositionFilteringRag(
    { query } as any,
    undefined,
    undefined,
    3,
    { analyze } as any,
  );
  const pending = rag.query(new TextOnlyEmbedding(text), 5);
  expect(query).not.toHaveBeenCalled();
  resolve({ text: 'English translation', needsAbapSystem: true });
  await pending;
  expect(query.mock.calls[0][0].text).toBe('English translation');
});

it.each(['smart', 'hard'] as const)(
  '%s mode respects its gate policy',
  async (mode) => {
    const { analyzer } = make(response('Hello', false));
    const query = jest.fn().mockResolvedValue({ ok: true, value: rows });
    const rag = new ExpositionFilteringRag(
      { query } as any,
      undefined,
      undefined,
      3,
      analyzer,
      undefined,
      'classifier',
      mode,
    );
    const result = await runWithSessionId('mode', () =>
      rag.query(new TextOnlyEmbedding('Hello'), 5),
    );
    expect(result).toEqual({
      ok: true,
      value: mode === 'hard' ? trustedRows : [],
    });
  },
);

it('applies independent gate decisions to parallel searches and translates each text', async () => {
  let resolve!: (value: { text: string; needsAbapSystem: boolean }) => void;
  const analyze = jest.fn((text: string) =>
    text === 'first query'
      ? new Promise<{ text: string; needsAbapSystem: boolean }>((r) => {
          resolve = r;
        })
      : Promise.resolve({
          text: `translated ${text}`,
          needsAbapSystem: false,
        }),
  );
  const analyzer = new ToolQueryAnalyzer({
    chat: jest.fn(),
    streamChat: jest.fn(),
  });
  jest.spyOn(analyzer, 'analyze').mockImplementation(analyze);
  const query = jest.fn(async (_embedding: IQueryEmbedding) => ({
    ok: true as const,
    value: rows.map((row) => ({ ...row, text: row.metadata.id })),
  }));
  const store: IRag = {
    query,
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  };
  const rag = new ExpositionFilteringRag(store, store, store, 3, analyzer);
  await runWithSessionId('same-session', async () => {
    const first = rag.query(new TextOnlyEmbedding('first query'), 5);
    const parallel = rag.query(new TextOnlyEmbedding('parallel query'), 5);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(await parallel).toEqual({ ok: true, value: [] });
    resolve({ text: 'translated first', needsAbapSystem: true });
    const firstResult = await first;
    if (!firstResult.ok) throw firstResult.error;
    expect(firstResult.value).not.toHaveLength(0);
    expect(
      await rag.query(new TextOnlyEmbedding('reselection query'), 5),
    ).toEqual({ ok: true, value: [] });
    expect(analyze).toHaveBeenCalledTimes(3);
    const texts = query.mock.calls.map(([embedding]) => embedding.text);
    expect(texts).toContain('translated first');
    expect(texts).toContain('translated parallel query');
    expect(texts).toContain('translated reselection query');
  });
  const next = runWithSessionId('same-session', () =>
    rag.query(new TextOnlyEmbedding('next request'), 5),
  );
  expect(analyze).toHaveBeenCalledTimes(4);
  await next;
});

it('isolates execute_step bypass between concurrent requests', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const analyze = jest.fn(async () => {
    await wait;
    return { text: 'Hello', needsAbapSystem: false };
  });
  const query = jest.fn().mockResolvedValue({ ok: true, value: rows });
  const rag = new ExpositionFilteringRag(
    { query } as any,
    undefined,
    undefined,
    3,
    { analyze } as any,
  );
  const search = () => rag.query(new TextOnlyEmbedding('Hello'), 5);
  const bypass = runWithSessionId('shared', () =>
    runWithToolGateBypass(search),
  );
  const normal = runWithSessionId('shared', search);
  release();
  const bypassResult = await bypass;
  expect(bypassResult).toEqual({ ok: true, value: trustedRows });
  if (!bypassResult.ok) throw bypassResult.error;
  expect(bypassResult.value[0].metadata).not.toHaveProperty('source');
  expect(bypassResult.value[0].metadata).not.toHaveProperty('trust');
  expect(await normal).toEqual({ ok: true, value: [] });
});

it('parses positive gate deadlines and warns on invalid values', () => {
  const cds = require('@sap/cds');
  const warning = jest
    .spyOn(cds.log('agent-config'), 'warn')
    .mockImplementation(() => {});
  expect(parseToolGateTimeoutMs(undefined)).toBe(4000);
  expect(parseToolGateTimeoutMs('125')).toBe(125);
  for (const value of [
    '',
    '0',
    '-1',
    '1.5',
    'invalid',
    'Infinity',
    '2147483648',
  ])
    expect(parseToolGateTimeoutMs(value)).toBe(4000);
  expect(warning).toHaveBeenCalledTimes(7);
  warning.mockRestore();
});
