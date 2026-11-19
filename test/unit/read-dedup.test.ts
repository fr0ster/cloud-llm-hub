import type { ILlm, IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  SmartAgentBuilder,
  unwrapBuilderResult,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  createReadDedupContextStrategy,
  loopReads,
  ReadDedup,
  readLoopPage,
  readPage,
} from '../../srv/lib/read-dedup';
import { withinToolResultBudget } from '../../srv/lib/tool-result-cap';
import { testAccess } from './helpers/test-rag-access';

test('read pointers are trace scoped', () => {
  const reads = new ReadDedup();
  const trace = {};
  const read = (text = 'abcdef', offset = 0, limit = 3) =>
    reads.read(trace, 'docs', 'r', text, offset, limit);
  expect(read()).toMatchObject({ text: 'abc' });
  expect(read()).toEqual({
    id: 'r',
    offset: 0,
    total: 6,
    alreadyRead: true,
    note: 'already read above in this task: r offset 0–3',
  });
  expect(reads.read({}, 'docs', 'r', 'abcdef', 0, 3)).toMatchObject({
    text: 'abc',
  });
});

test('changes anywhere in the record invalidate a page, and page arguments identify reads', () => {
  const reads = new ReadDedup();
  const trace = {};
  reads.read(trace, 'docs', 'r', 'abcdef', 0, 3);
  expect(reads.read(trace, 'docs', 'r', 'abcXYZ', 0, 3)).toMatchObject({
    text: 'abc',
  });
  expect(reads.read(trace, 'docs', 'r', 'abcXYZ', 1, 3)).toMatchObject({
    text: 'bcX',
  });
  expect(reads.read(trace, 'docs', 'r', 'abcXYZ', 0, 2)).toMatchObject({
    text: 'ab',
  });
});

test('read pages default to 32000 characters', () => {
  expect(readPage('r', 'x'.repeat(40000))).toMatchObject({
    text: 'x'.repeat(32000),
    next: 32000,
  });
});

const ragCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

test('real agent loops retain original reads and isolate concurrent runs', async () => {
  const observed = new Map<string, Array<ReturnType<typeof readLoopPage>>>();
  const chats = new Map<string, number>();
  const client: IMcpClient = {
    async listTools() {
      return {
        ok: true,
        value: [
          {
            name: 'rag_read',
            description: 'Read',
            inputSchema: { type: 'object' },
          },
        ],
      };
    },
    async callTool(_name, _args, options) {
      const trace = options?.trace?.traceId ?? '';
      const page = readLoopPage(trace, 'docs', 'r', 'abcdef');
      const pages = observed.get(trace) ?? [];
      pages.push(page);
      observed.set(trace, pages);
      return { ok: true, value: { content: JSON.stringify(page) } };
    },
  };
  const chat: ILlm['chat'] = async (messages, _tools, options) => {
    const trace = options?.trace?.traceId ?? '';
    const count = chats.get(trace) ?? 0;
    chats.set(trace, count + 1);
    if (count > 0) {
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('"text":"abcdef"'),
        }),
      );
    }
    return {
      ok: true,
      value:
        count < 4
          ? {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: String(count),
                  name: 'rag_read',
                  arguments: { collection: 'docs', id: 'r' },
                },
              ],
            }
          : { content: 'done', finishReason: 'stop' },
    };
  };
  const llm: ILlm = {
    chat,
    async *streamChat(messages, tools, options) {
      yield await chat(messages, tools, options);
    },
  };
  const { agent } = unwrapBuilderResult(
    await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: { classificationEnabled: false },
    })
      .withRagAccess(testAccess([ragCaller]))
      .withMainLlm(llm)
      .withMcpClients([client])
      .withClassification(false)
      .withMode('hard')
      .withToolLoopContextStrategyFactory(createReadDedupContextStrategy)
      .build(),
  );
  await Promise.all(
    ['one', 'two'].map((traceId) =>
      agent.process('read', {
        sessionId: ragCaller.sessionId,
        caller: ragCaller,
        trace: { traceId },
      }),
    ),
  );
  for (const trace of ['one', 'two']) {
    expect(observed.get(trace)).toEqual([
      expect.objectContaining({ text: 'abcdef' }),
      expect.objectContaining({ alreadyRead: true }),
      expect.objectContaining({ alreadyRead: true }),
      expect.objectContaining({ alreadyRead: true }),
    ]);
  }
});

test('a budget too small for a page does not mark the content as read', () => {
  const reads = new ReadDedup();
  const serialize = (page: ReturnType<typeof readPage>) => [
    { type: 'text', text: JSON.stringify(page) },
  ];
  loopReads.run(reads, () => {
    const read = () =>
      readLoopPage('trace', 'docs', 'r', 'body', 0, undefined, serialize);
    expect(withinToolResultBudget(1, read)).toMatchObject({ text: 'body' });
    expect(withinToolResultBudget(1, read)).toMatchObject({ text: 'body' });
    expect(withinToolResultBudget(4096, read)).toMatchObject({ text: 'body' });
    expect(withinToolResultBudget(4096, read)).toMatchObject({
      alreadyRead: true,
    });
  });
});

test('a fitting requested page is serialized once', () => {
  const serialize = jest.fn((page: ReturnType<typeof readPage>) => [
    { type: 'text', text: JSON.stringify(page) },
  ]);
  const page = withinToolResultBudget(60000, () =>
    readLoopPage(
      'trace',
      'docs',
      'r',
      'x'.repeat(40000),
      0,
      undefined,
      serialize,
    ),
  );
  expect(page).toEqual(readPage('r', 'x'.repeat(40000)));
  expect(serialize).toHaveBeenCalledTimes(1);
});

test('oversize escaped pages fit the cap and preserve continuation and unread content', () => {
  const text = '\\"\n'.repeat(11000);
  const cap = 60000;
  const serialize = (page: ReturnType<typeof readPage>) => [
    { type: 'text', text: JSON.stringify(page) },
  ];
  const reads = new ReadDedup();
  loopReads.run(reads, () => {
    const read = (offset = 0) =>
      withinToolResultBudget(cap, () =>
        readLoopPage('trace', 'docs', 'r', text, offset, undefined, serialize),
      );
    let offset = 0;
    let delivered = '';
    while (offset < text.length) {
      const page = read(offset);
      expect(page).toMatchObject({ offset, total: text.length });
      expect('alreadyRead' in page).toBe(false);
      if (!('text' in page)) throw new Error('Expected an unread page');
      expect(JSON.stringify(serialize(page)).length).toBeLessThanOrEqual(cap);
      delivered += page.text;
      if (page.next !== undefined) {
        expect(page.next).toBe(offset + page.text.length);
        expect(
          JSON.stringify(
            serialize(readPage('r', text, offset, page.text.length + 1)),
          ).length,
        ).toBeGreaterThan(cap);
      }
      expect(read(offset)).toMatchObject({ alreadyRead: true });
      offset = page.next ?? text.length;
    }
    expect(delivered).toBe(text);
  });
});
