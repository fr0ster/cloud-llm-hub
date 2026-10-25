import {
  type DialogueStreamChunk,
  dialogueChat,
} from '../../srv/lib/dialogue-chat';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';
import { plannerWithRetrievedContext } from '../../srv/lib/dialogue-planner-content';
import { resetGatekeeperForTest } from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return { user: require('./helpers/channel-harness').harness.user };
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/agent-manager', () =>
  require('./helpers/channel-harness').agentManagerMock(),
);
jest.mock('../../srv/agent-config', () => ({
  ...require('./helpers/channel-harness').agentConfigMock(),
  getAgentConfig: () => ({ agent: { chatCoordinator: 'dialogue' } }),
}));
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  dialogueFor: jest.fn(),
  lookupDialogue: jest.fn(async () => undefined),
}));

import type { Request, Response } from 'express';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { dialogueFor } from '../../srv/lib/dialogue-sessions';
import {
  type LongSession,
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { handleChatCompletions } from '../../srv/openai-handler';
import {
  getRequestSessionId,
  getRequestUserId,
} from '../../srv/request-session';
import { clearSession, getSessionHistory } from '../../srv/session-store';
import {
  deferred,
  fakeReq,
  fakeRes,
  harness,
  tick,
} from './helpers/channel-harness';

let session: LongSession;
const refresh = jest.fn();
const confirmUpTo = jest.fn(async () => {});
let emptyPending = false;
let outbox: DialogueOutbox;
const ended = jest.fn();
const send = jest.fn();
let turnContext: WeakMap<object, string>;
beforeEach(() => {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
  clearGatekeeperConfig();
  resetGatekeeperForTest();
  harness.reset();
  refresh.mockClear();
  confirmUpTo.mockClear();
  emptyPending = false;
  ended.mockClear();
  outbox = new DialogueOutbox([], async () => {});
  const begin = outbox.beginDelivery.bind(outbox);
  jest.spyOn(outbox, 'beginDelivery').mockImplementation(() => {
    const delivery = begin();
    return {
      ...delivery,
      ended() {
        ended();
        delivery.ended();
      },
    };
  });
  jest.spyOn(outbox, 'confirmUpTo').mockImplementation(confirmUpTo);
  send.mockReset();
  turnContext = new WeakMap<object, string>();
  const registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {} },
  );
  setLongSessionsForTest(registry);
  session = registry.open('alice', {}) as LongSession;
  jest.mocked(dialogueFor).mockResolvedValue({
    retrievedContexts: turnContext,
    factory: { refresh },
    drainPending: async () => {},
    hasSubscribers: () => true,
    state: () => ({}),
    outbox,
    session: { takePending: () => [{ text: 'one' }, { text: 'two' }], send },
  } as never);
  jest.spyOn(outbox, 'pending').mockImplementation(() =>
    emptyPending
      ? []
      : [
          { id: 'one', text: 'one', createdAt: 1, trigger: 'event' },
          { id: 'two', text: 'two', createdAt: 2, trigger: 'event' },
        ],
  );
  send.mockImplementation(async (_text, opts) => {
    expect(getRequestSessionId()).toBe(session.key);
    expect(getRequestUserId()).toBe('alice');
    opts.onPartial?.({ kind: 'content', delta: 'answer' });
    return { text: 'answer' };
  });
});
afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  resetGatekeeperForTest();
  clearSession(session.key, 'alice');
  setLongSessionsForTest(undefined);
});
const visible = 'one\n\ntwo\n\nanswer';
for (const anthropic of [false, true])
  for (const stream of [false, true]) {
    it(`sentinel-only reply finishes (anthropic=${anthropic}, stream=${stream})`, async () => {
      emptyPending = true;
      send.mockImplementation(async (_text, opts) => {
        opts.onPartial?.({ kind: 'content', delta: 'NO_' });
        opts.onPartial?.({ kind: 'content', delta: 'MESSAGE' });
        return { text: 'NO_MESSAGE' };
      });
      const req = fakeReq(
        {
          model: 'm',
          max_tokens: 100,
          stream,
          messages: [{ role: 'user', content: 'hi' }],
        },
        session.key,
      ) as unknown as Request & { longSession: LongSession };
      req.longSession = session;
      const res = fakeRes();
      await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
        req,
        res as unknown as Response,
      );
      expect(res.body).not.toContain('NO_');
      if (stream)
        expect(res.body).toContain(anthropic ? 'message_stop' : '[DONE]');
      else if (!anthropic)
        expect(JSON.parse(res.body).choices[0].message.content).toBe(
          '(no response)',
        );
      else expect(JSON.parse(res.body).type).toBe('message');
      expect(
        getSessionHistory(session.key, 'alice').filter(
          (m) => m.role === 'assistant',
        ),
      ).toEqual([]);
    });
  }
for (const anthropic of [false, true])
  for (const stream of [false, true]) {
    it(`${anthropic ? 'anthropic' : 'openai'} stream=${stream}: pending first, answer and history`, async () => {
      const req = fakeReq(
        {
          model: 'm',
          max_tokens: 100,
          stream,
          messages: [{ role: 'user', content: 'hi' }],
        },
        session.key,
      ) as unknown as Request & { longSession: LongSession };
      req.longSession = session;
      const res = fakeRes();
      await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
        req,
        res as unknown as Response,
      );
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ headers: req.headers, user: harness.user }),
        'DEST',
      );
      expect(harness.establishCalls).toEqual([]);
      expect(send).toHaveBeenCalledWith(
        'hi',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          trace: { traceId: expect.any(String) },
        }),
      );
      if (stream) {
        expect(res.body.indexOf('one')).toBeLessThan(
          res.body.indexOf('answer'),
        );
      } else {
        const payload = JSON.parse(res.body);
        expect(
          anthropic
            ? payload.content[0].text
            : payload.choices[0].message.content,
        ).toBe(visible);
      }
      expect(ended).toHaveBeenCalledTimes(1);
      const history = getSessionHistory(session.key, 'alice');
      expect(history).toHaveLength(anthropic ? 0 : 2);
      if (!anthropic) expect(history[1].content).toBe(visible);
    });
  }
it.each([false, true])(
  'no long session falls back to adaptive (anthropic=%s)',
  async (anthropic) => {
    const req = fakeReq({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }) as unknown as Request;
    const res = fakeRes();
    await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
      req,
      res as unknown as Response,
    );
    expect(res.headers['x-clh-coordinator']).toBe('adaptive');
    expect(harness.events).toContain('pipeline');
  },
);
it('disconnect mid-answer completes and stores visible text once', async () => {
  const gate = deferred();
  send.mockImplementation(async (_text, opts) => {
    opts.onPartial({ kind: 'content', delta: 'ans' });
    await gate.promise;
    expect(opts.signal.aborted).toBe(false);
    opts.onPartial({ kind: 'content', delta: 'wer' });
    return { text: 'answer' };
  });
  const req = fakeReq(
    { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    session.key,
  ) as unknown as Request & { longSession: LongSession };
  req.longSession = session;
  const res = fakeRes();
  const done = handleChatCompletions(req, res as unknown as Response);
  await tick();
  expect(res.body).toContain('ans');
  expect(res.writableEnded).toBe(false);
  res.disconnect();
  gate.resolve();
  await done;
  expect(confirmUpTo).not.toHaveBeenCalled();
  expect(getSessionHistory(session.key, 'alice').map((m) => m.content)).toEqual(
    ['hi', visible],
  );
});

for (const anthropic of [false, true])
  for (const stream of [false, true]) {
    it(`planner failure uses existing error response (anthropic=${anthropic}, stream=${stream})`, async () => {
      send.mockRejectedValue(new Error('planner failed'));
      const req = fakeReq(
        {
          model: 'm',
          max_tokens: 100,
          stream,
          messages: [{ role: 'user', content: 'hi' }],
        },
        session.key,
      ) as unknown as Request & { longSession: LongSession };
      req.longSession = session;
      const res = fakeRes();
      await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
        req,
        res as unknown as Response,
      );
      expect(confirmUpTo).not.toHaveBeenCalled();
      expect(res.body).toContain('planner failed');
      if (stream)
        expect(res.body).toContain(anthropic ? 'event: error' : 'server_error');
      else if (anthropic) {
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error.type).toBe('api_error');
      } else
        expect(JSON.parse(res.body).choices[0].message.content).toBe(
          'Error: planner failed',
        );
    });
  }

it.each([false, true])(
  'rejects changed dialogue destination before refresh (anthropic=%s)',
  async (anthropic) => {
    session.destination = 'ORIGINAL';
    const req = fakeReq(
      { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      session.key,
    ) as unknown as Request & { longSession: LongSession };
    req.longSession = session;
    req.headers['x-sap-destination'] = 'OTHER';
    const res = fakeRes();
    await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
      req,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('DIALOGUE_DESTINATION_FIXED');
    expect(refresh).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'active subscriber still receives outbox in chat (stream=%s)',
  async (stream) => {
    emptyPending = false;
    const req = fakeReq(
      { stream, messages: [{ role: 'user', content: 'hi' }] },
      session.key,
    ) as unknown as Request & { longSession: LongSession };
    req.longSession = session;
    const res = fakeRes();
    await handleChatCompletions(req, res as unknown as Response);
    expect(res.body).toContain('answer');
    expect(res.body).toContain('one');
    expect(res.body).not.toContain('**Planner:**');
    expect(confirmUpTo).not.toHaveBeenCalled();
  },
);
it('failed chat write retains outbox', async () => {
  const req = fakeReq(
    { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    session.key,
  ) as unknown as Request & { longSession: LongSession };
  req.longSession = session;
  await handleChatCompletions(
    req,
    fakeRes({ throwOnWriteAfter: 0 }) as unknown as Response,
  );
  expect(confirmUpTo).not.toHaveBeenCalled();
});

it.each([false, true])(
  'principal conflict rejects before refresh/send (anthropic=%s)',
  async (anthropic) => {
    const { lookupDialogue } = jest.requireMock(
      '../../srv/lib/dialogue-sessions',
    );
    lookupDialogue.mockResolvedValueOnce({
      factory: {
        assertPrincipal() {
          throw new Error('The dialogue principal is fixed');
        },
      },
    });
    const req = fakeReq(
      {
        model: 'm',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      session.key,
    ) as unknown as Request & { longSession: LongSession };
    req.longSession = session;
    const res = fakeRes();
    await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
      req,
      res as unknown as Response,
    );
    expect(res.body).toContain('DIALOGUE_PRINCIPAL_FIXED');
    expect(refresh).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['before', 'before\n'])(
  'separates resumed planner content after tools (%j)',
  async (before) => {
    send.mockImplementation(async (_text: string, options: any) => {
      const { plannerWithParagraphs } = await import(
        '../../srv/lib/dialogue-planner-content'
      );
      const result = await plannerWithParagraphs({
        process: async (_input, opts) => {
          opts.onPartial?.({ kind: 'content', delta: before });
          opts.onPartial?.({
            kind: 'mcp-call',
            source: { stepperId: 's', name: 'tool' },
            tool: 'test',
          });
          opts.onPartial?.({ kind: 'content', delta: 'after' });
          return { ok: true, value: { content: before + 'after' } };
        },
      }).process([], options);
      return { text: result.ok ? result.value.content : '' };
    });
    const { dialogueChat } = await import('../../srv/lib/dialogue-chat');
    const res = fakeRes();
    const agent = dialogueChat(
      fakeReq({}, session.key) as unknown as Request,
      'alice',
      session,
      'SAP',
      res as unknown as Response,
    );
    let text = '';
    for await (const chunk of agent.streamProcess([]))
      if (chunk.ok) text += chunk.value.content || '';
    expect(text).toContain(
      // A tool boundary always yields a paragraph break (two newlines).
      before + (before.endsWith('\n') ? '\n' : '\n\n') + 'after',
    );
  },
);

for (const anthropic of [false, true])
  for (const stream of [false, true]) {
    it(`destination-free long session uses adaptive (anthropic=${anthropic}, stream=${stream})`, async () => {
      const req = fakeReq(
        {
          model: 'm',
          max_tokens: 100,
          stream,
          messages: [{ role: 'user', content: 'hi' }],
        },
        session.key,
      ) as unknown as Request & { longSession: LongSession };
      req.longSession = session;
      delete req.headers['x-sap-destination'];
      harness.sessionDestinations.set(
        JSON.stringify(['alice', session.key]),
        '',
      );
      const res = fakeRes();
      await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
        req,
        res as unknown as Response,
      );
      expect(res.headers['x-clh-coordinator']).toBe('adaptive');
      expect(harness.events).toContain('pipeline');
      expect(send).not.toHaveBeenCalled();
      expect(res.body).not.toContain(
        'Destination executor workers unavailable',
      );
    });
  }

it.each([
  ['NO_MESSAGE', ''],
  ['  NO_MESSAGE  ', ''],
  ['NO_MESSAGE answer NO_MESSAGE', 'answer'],
  [
    'NO_MESSAGEish and inner NO_MESSAGE mention',
    'NO_MESSAGEish and inner NO_MESSAGE mention',
  ],
])('cleans direct planner reply %j', async (text, expected) => {
  emptyPending = true;
  send.mockResolvedValue({ text });
  const { dialogueChat } = await import('../../srv/lib/dialogue-chat');
  const agent = dialogueChat(
    fakeReq({}, session.key) as unknown as Request,
    'alice',
    session,
    'SAP',
    fakeRes() as unknown as Response,
  );
  const result = await agent.process([]);
  expect(result.ok && result.value.content).toBe(expected);
});

it.each([
  [['NO_', 'MESS', 'AGE'], ''],
  [['  NO_', 'MESSAGE', '  '], ''],
  [['NO_', 'MESSAGE ', 'answer', ' NO_', 'MESSAGE'], 'answer'],
  [['answer', ' NO_', 'MESS'], 'answer NO_MESS'],
  [['NO_', 'MESSAGEish'], 'NO_MESSAGEish'],
  [['answer', ' NO_', 'MESSAGE', ' more'], 'answer NO_MESSAGE more'],
  [['answer', ' NO_MESSAGE ', 'NO_', 'MESSAGE  '], 'answer'],
  [['answer', ' NO_MESSAGE N'], 'answer NO_MESSAGE N'],
  [['NO_MESSAGE\n', '    ', 'answer'], 'answer'],
  [['answer', '  '], 'answer  '],
])('filters streamed boundary sentinels %j', async (deltas, expected) => {
  emptyPending = true;
  send.mockImplementation(async (_text, opts) => {
    for (const delta of deltas) opts.onPartial({ kind: 'content', delta });
    return { text: deltas.join('') };
  });
  const { dialogueChat } = await import('../../srv/lib/dialogue-chat');
  const agent = dialogueChat(
    fakeReq({}, session.key) as unknown as Request,
    'alice',
    session,
    'SAP',
    fakeRes() as unknown as Response,
  );
  const contents: string[] = [];
  let stopped = false;
  for await (const chunk of agent.streamProcess([])) {
    expect(chunk.ok).toBe(true);
    if (chunk.ok) {
      contents.push(chunk.value.content || '');
      stopped ||= chunk.value.finishReason === 'stop';
    }
  }
  expect(contents.join('')).toBe(expected);
  expect(stopped).toBe(true);
});

it.each(['NO_MESSAGE', 'NO_MESSAGE answer NO_MESSAGE'])(
  'cleans streaming fallback without partials %j',
  async (text) => {
    emptyPending = true;
    send.mockResolvedValue({ text });
    const { dialogueChat } = await import('../../srv/lib/dialogue-chat');
    const agent = dialogueChat(
      fakeReq({}, session.key) as unknown as Request,
      'alice',
      session,
      'SAP',
      fakeRes() as unknown as Response,
    );
    let content = '';
    for await (const chunk of agent.streamProcess([]))
      if (chunk.ok) content += chunk.value.content || '';
    expect(content).toBe(text === 'NO_MESSAGE' ? '' : 'answer');
  },
);

for (const anthropic of [false, true])
  for (const stream of [false, true])
    for (const retrieved of [false, true]) {
      it(`planner receives current user text (anthropic=${anthropic}, stream=${stream}, retrieved=${retrieved})`, async () => {
        const { getCollectionRegistry } = require('../../srv/agent-manager');
        const plannerProcess = jest.fn(async () => ({
          ok: true as const,
          value: { content: 'answer' },
        }));
        send.mockImplementation(async (text, opts) => {
          await plannerWithRetrievedContext(
            { process: plannerProcess },
            turnContext,
          ).process([{ role: 'user', content: text }], opts);
          return { text: 'answer' };
        });
        const registry = getCollectionRegistry();
        jest.spyOn(registry, 'getCollection').mockResolvedValue({
          id: 'docs__u_alice',
          owner: 'alice',
          scope: 'user',
        });
        jest.spyOn(registry, 'degradedOf').mockResolvedValue(undefined);
        jest.spyOn(registry, 'getRagStores').mockResolvedValue({});
        jest.spyOn(registry, 'getRagStore').mockResolvedValue({
          query: async () => ({
            ok: true,
            value: [{ text: 'knowledge', score: 1 }],
          }),
        });
        try {
          const req = fakeReq(
            {
              model: 'm',
              max_tokens: 100,
              stream,
              messages: [{ role: 'user', content: 'hi' }],
            },
            session.key,
          ) as unknown as Request & { longSession: LongSession };
          req.longSession = session;
          if (retrieved) req.headers['x-rag-collections'] = 'docs__u_alice';
          await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
            req,
            fakeRes() as unknown as Response,
          );
          expect(send).toHaveBeenCalledWith('hi', expect.anything());
          const input = JSON.stringify(plannerProcess.mock.calls);
          if (retrieved) {
            expect(input).toContain('[retrieved context]');
            expect(input).toContain('knowledge');
          } else expect(input).not.toContain('[retrieved context]');
          expect(turnContext.has(send.mock.calls.at(-1)?.[1].trace)).toBe(
            false,
          );
        } finally {
          jest.restoreAllMocks();
        }
      });
    }

function directChat(ack?: string) {
  const req = fakeReq({}, session.key) as unknown as Request;
  if (ack !== undefined) req.headers['x-clh-ack'] = ack;
  const res = fakeRes();
  return {
    res,
    agent: dialogueChat(
      req,
      'alice',
      session,
      'SAP',
      res as unknown as Response,
    ),
  };
}
async function chunksOf(agent: ReturnType<typeof dialogueChat>) {
  const chunks: DialogueStreamChunk[] = [];
  for await (const chunk of agent.streamProcess([])) {
    if (!chunk.ok) throw chunk.error;
    chunks.push(chunk.value);
  }
  return chunks;
}
function directAnswer() {
  send.mockImplementation(async (_text, opts) => {
    opts.onPartial?.({ kind: 'content', delta: 'answer' });
    return { text: 'answer' };
  });
}
it('streams pending messages then the reply, with matching framing', async () => {
  directAnswer();
  const { agent } = directChat();
  const chunks = await chunksOf(agent);
  const ids = chunks.flatMap((c) => (c.clhMessageId ? [c.clhMessageId] : []));
  expect(ids).toEqual(['one', 'two', expect.any(String)]);
  expect(
    chunks.filter((c) => c.clhMessageEnd).map((c) => c.clhMessageEnd),
  ).toEqual(ids);
  expect(chunks.filter((c) => c.clhTurnEnd)).toHaveLength(1);
  for (const id of ids) {
    const start = chunks.findIndex((c) => c.clhMessageId === id);
    const end = chunks.findIndex((c) => c.clhMessageEnd === id);
    expect(chunks[start].content).toBe('');
    expect(end).toBeGreaterThan(start + 1);
    expect(chunks[end + 1]?.clhMessageId).toBeUndefined();
  }
  expect(chunks.map((c) => c.content || '').join('')).toBe(visible);
  expect(outbox.history().at(-1)).toMatchObject({
    id: ids[2],
    text: 'answer',
    trigger: 'user',
  });
});
it.each(['', 'NO_MESSAGE'])(
  'reply %j adds nothing and emits no reply id or empty paragraph',
  async (text) => {
    send.mockResolvedValue({ text });
    const chunks = await chunksOf(directChat().agent);
    expect(
      chunks.filter((c) => c.clhMessageId).map((c) => c.clhMessageId),
    ).toEqual(['one', 'two']);
    expect(chunks.map((c) => c.content || '').join('')).toBe('one\n\ntwo');
    expect(outbox.history()).toEqual([]);
  },
);
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'later arrival confirms only an ended response (cut=%s, stream=%s)',
  async (cut, stream) => {
    jest.mocked(outbox.pending).mockRestore();
    directAnswer();
    const first = directChat();
    if (stream) await chunksOf(first.agent);
    else {
      const result = await first.agent.process([]);
      expect(result.ok).toBe(true);
    }
    const id = outbox.pending()[0].id;
    if (!stream) expect(first.res.headers['x-clh-last-message']).toBe(id);
    if (cut) first.res.disconnect();
    first.res.end();
    const second = directChat();
    const next = await second.agent.process([]);
    expect(next.ok && next.value.content).toBe(
      cut ? 'answer\n\nanswer' : 'answer',
    );
    expect(outbox.pending().some((m) => m.id === id)).toBe(cut);
  },
);
it('x-clh-ack none enters ack mode; an id confirms up to it', async () => {
  jest.mocked(outbox.pending).mockRestore();
  jest.mocked(outbox.confirmUpTo).mockRestore();
  directAnswer();
  const first = directChat('none');
  await first.agent.process([]);
  first.res.end();
  const id = outbox.pending()[0].id;
  expect(outbox.ackMode).toBe(true);
  await directChat().agent.process([]);
  expect(outbox.pending().some((m) => m.id === id)).toBe(true);
  await directChat(id).agent.process([]);
  expect(outbox.pending().some((m) => m.id === id)).toBe(false);
});
it('a new request supersedes an open follow before reading pending', async () => {
  directAnswer();
  const handle = await dialogueFor('alice', session.key, 'SAP');
  handle.state = () => ({
    status: 'active',
    turnActive: false,
    queuedInputs: 0,
    running: 1,
    total: 1,
    done: 0,
    idle: false,
  });
  handle.subscribe = () => () => {};
  const first = directChat();
  await chunksOf(first.agent);
  const follow = first.agent.follow(new AbortController().signal, 10000);
  expect(follow).toBeDefined();
  if (!follow) throw new Error('expected a follow');
  const iterator = follow[Symbol.asyncIterator]();
  const end = iterator.next();
  await tick();
  const pending = jest.mocked(outbox.pending);
  pending.mockClear();
  let superseded = false;
  const observed = end.then((item) => {
    superseded =
      item.value?.kind === 'end' && item.value.reason === 'superseded';
  });
  pending.mockImplementation(() => {
    expect(superseded).toBe(true);
    return [];
  });
  await directChat().agent.process([]);
  await observed;
  expect(superseded).toBe(true);
  await iterator.return?.();
});

it('follow is absent for a plain reply and for a non-streaming turn', async () => {
  directAnswer();
  const { agent } = directChat();
  await chunksOf(agent);
  expect(agent.follow(new AbortController().signal, 100)).toBeUndefined();
  const handle = await dialogueFor('alice', session.key, 'SAP');
  handle.state = () => ({
    status: 'done',
    turnActive: false,
    queuedInputs: 0,
    running: 0,
    total: 1,
    done: 1,
    idle: false,
  });
  const nonStreaming = directChat().agent;
  await nonStreaming.process([]);
  expect(
    nonStreaming.follow(new AbortController().signal, 100),
  ).toBeUndefined();
});
