import { Stream as AnthropicStream } from '@anthropic-ai/sdk/core/streaming';
import { Stream as OpenAIStream } from 'openai/core/streaming';
import {
  type DialogueStreamChunk,
  dialogueChat,
} from '../../srv/lib/dialogue-chat';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';
import { plannerWithRetrievedContext } from '../../srv/lib/dialogue-planner-content';
import {
  admitPipeline,
  resetGatekeeperForTest,
  theRetention,
} from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { longSessions } from '../../srv/lib/long-session';

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
import * as sessionTurns from '../../srv/lib/session-turns';
import { handleChatCompletions } from '../../srv/openai-handler';
import {
  getRequestHistory,
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
    replies: new WeakMap(),
    factory: { refresh },
    drainPending: async () => {},
    hasSubscribers: () => true,
    state: () => ({ settledSeq: 0, lastFailedSeq: 0 }),
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
for (const initial of ['', 'NO_MESSAGE', 'answer']) {
  for (const following of [false, true]) {
    it(`openai records history and recall once: initial=${JSON.stringify(initial)}, follow=${following}`, async () => {
      emptyPending = true;
      const record = jest
        .spyOn(sessionTurns, 'recordTurn')
        .mockImplementation(() => {});
      const handle = await dialogueFor('alice', session.key, 'DEST');
      if (following) {
        handle.state = () => ({
          settledSeq: 0,
          lastFailedSeq: 0,
          status: 'done',
          turnActive: false,
          queuedInputs: 0,
          running: 0,
          total: 1,
          done: 1,
          idle: false,
        });
        handle.subscribe = () => () => {};
      }
      send.mockImplementation(async () => {
        expect(record).not.toHaveBeenCalled();
        if (following) {
          jest.mocked(outbox.pending).mockImplementation(() => {
            // Recall must wait until the follow's visible answer is collected.
            expect(record).not.toHaveBeenCalled();
            return [
              {
                id: 'later',
                text: 'follow answer',
                createdAt: 3,
                trigger: 'event',
              },
            ];
          });
        }
        return { text: initial };
      });
      try {
        await handleChatCompletions(
          streamingRequest(),
          fakeRes() as unknown as Response,
        );
        const turnText = initial === 'answer' ? initial : '';
        const answer = following
          ? `${turnText}${turnText ? '\n\n' : ''}follow answer`
          : turnText;
        expect(getSessionHistory(session.key, 'alice')).toEqual([
          { role: 'user', content: 'hi' },
          ...(answer ? [{ role: 'assistant', content: answer }] : []),
        ]);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(
          session.key,
          'alice',
          expect.objectContaining({ role: 'user', content: 'hi' }),
          answer,
        );
      } finally {
        record.mockRestore();
      }
    });
  }
}
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
      send.mockResolvedValue({
        text: 'answer',
        usage: {
          planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        },
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
        expect(payload.usage).toEqual(
          anthropic
            ? {
                input_tokens: 3,
                output_tokens: 2,
                x_hub: {
                  duration_ms: expect.any(Number),
                  planner: {
                    prompt_tokens: 3,
                    completion_tokens: 2,
                    total_tokens: 5,
                  },
                },
              }
            : {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
                x_hub: {
                  duration_ms: expect.any(Number),
                  planner: {
                    prompt_tokens: 3,
                    completion_tokens: 2,
                    total_tokens: 5,
                  },
                },
              },
        );
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
          return { ok: true, value: { content: `${before}after` } };
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
      `${before}${before.endsWith('\n') ? '\n' : '\n\n'}after`,
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
it('preserves buffered leading whitespace when reply content arrives', async () => {
  send.mockImplementation(async (_text, opts) => {
    for (const delta of [' ', '\t\n', 'answer', ' '])
      opts.onPartial?.({ kind: 'content', delta });
    return { text: ' \t\nanswer ' };
  });
  const chunks = await chunksOf(directChat().agent);
  expect(chunks.map((c) => c.content || '').join('')).toBe(
    'one\n\ntwo\n\n \t\nanswer ',
  );
  expect(outbox.history().at(-1)?.text).toBe(' \t\nanswer ');
});
it.each(
  ['', 'NO_MESSAGE', ' \t\r\n'].flatMap((text) =>
    ['partials', 'fallback', 'non-streaming'].map((mode) => ({ text, mode })),
  ),
)(
  'reply $text adds nothing and emits no reply id or empty paragraph ($mode)',
  async ({ text, mode }) => {
    send.mockImplementation(async (_text, opts) => {
      if (mode === 'partials') {
        for (const delta of text) opts.onPartial?.({ kind: 'content', delta });
      }
      return { text };
    });
    if (mode === 'non-streaming') {
      const { agent, res } = directChat();
      const result = await agent.process([]);
      expect(result.ok && result.value.content).toBe('one\n\ntwo');
      expect(res.headers['x-clh-last-message']).toBe('two');
      expect(outbox.history()).toEqual([]);
      return;
    }
    const chunks = await chunksOf(directChat().agent);
    expect(
      chunks.filter((c) => c.clhMessageId).map((c) => c.clhMessageId),
    ).toEqual(['one', 'two']);
    expect(
      chunks.filter((c) => c.clhMessageEnd).map((c) => c.clhMessageEnd),
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
    settledSeq: 0,
    lastFailedSeq: 0,
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
    first.res.end();
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
    settledSeq: 0,
    lastFailedSeq: 0,
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

function streamingRequest() {
  const req = fakeReq(
    {
      model: 'm',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    },
    session.key,
  ) as unknown as Request & { longSession: LongSession };
  req.longSession = session;
  return req;
}

for (const anthropic of [false, true]) {
  const handler = anthropic ? handleAnthropicMessages : handleChatCompletions;
  const label = anthropic ? 'anthropic' : 'openai';
  it(`${label}: headers and immediate keep-alive precede initialization`, async () => {
    jest.useFakeTimers();
    const gate = deferred();
    harness.agentGate = gate.promise;
    const res = fakeRes();
    const response = handler(streamingRequest(), res as unknown as Response);
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(res.headersSent).toBe(true);
      expect(res.body).toBe(': keep-alive\n\n');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(res.body.match(/: keep-alive/g)).toHaveLength(2);
      gate.resolve();
      await response;
    } finally {
      gate.resolve();
      jest.useRealTimers();
    }
  });

  it(`${label}: a queued request opens its stream before its turn can run`, async () => {
    const gate = deferred();
    const blocker = longSessions().run(session, () => gate.promise);
    const res = fakeRes();
    const response = handler(streamingRequest(), res as unknown as Response);
    expect(res.headersSent).toBe(true);
    expect(res.body).toBe(': keep-alive\n\n');
    expect(send).not.toHaveBeenCalled();
    gate.resolve();
    await blocker;
    await response;
    expect(res.body.match(/: keep-alive/g)).toHaveLength(1);
  });

  it(`${label}: initialization failure uses only the stream error form`, async () => {
    harness.agentGate = Promise.reject(new Error('initialization failed'));
    const res = fakeRes();
    await handler(streamingRequest(), res as unknown as Response);
    expect(res.body).toContain('initialization failed');
    expect(res.body).toContain(anthropic ? 'event: error' : 'data: {"error"');
    expect(res.body).not.toContain('[DONE]');
    expect(res.body).not.toContain('message_stop');
    expect(ended).not.toHaveBeenCalled();
  });

  it(`${label}: a closed destination still returns HTTP 503 and Retry-After`, async () => {
    harness.closedDestination = 'DEST';
    harness.retryAfterSeconds = 7;
    const res = fakeRes();
    await handler(streamingRequest(), res as unknown as Response);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('7');
    expect(res.body).not.toContain(': keep-alive');
  });

  it(`${label}: SDK parses pending, reply and follow with one terminal, including a cut stream`, async () => {
    const handle = await dialogueFor('alice', session.key, 'DEST');
    handle.state = () => ({
      settledSeq: 0,
      lastFailedSeq: 0,
      status: 'done',
      turnActive: false,
      queuedInputs: 0,
      running: 0,
      total: 1,
      done: 1,
      idle: false,
    });
    handle.subscribe = () => () => {};
    const originalSend = send.getMockImplementation();
    if (!originalSend) throw new Error('Missing send fixture');
    send.mockImplementation(async (...args) => {
      const answer = await originalSend(...args);
      const pending = outbox.pending();
      jest.mocked(outbox.pending).mockReturnValue([
        ...pending,
        {
          id: 'follow-id',
          text: 'follow',
          createdAt: 3,
          trigger: 'event',
          usage: {
            planner: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
            plannerMs: 100,
            tasks: [
              {
                id: 't1',
                worker: 'executor',
                durationMs: 400,
                usage: {
                  promptTokens: 7,
                  completionTokens: 4,
                  totalTokens: 11,
                },
              },
            ],
          },
        },
      ]);
      return {
        ...answer,
        usage: {
          planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          plannerMs: 200,
        },
      };
    });
    const res = fakeRes();
    await handler(streamingRequest(), res as unknown as Response);
    if (!anthropic) {
      expect(
        getSessionHistory(session.key, 'alice').map((m) => m.content),
      ).toEqual(['hi', `${visible}\n\nfollow`]);
    }

    expect(res.body).toMatch(/"x_hub":\{"duration_ms":\d+,/);
    expect(res.body).toContain(
      '"planner":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"duration_ms":300}',
    );
    expect(res.body).toContain(
      '"subagents":[{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11,"duration_ms":400,"task_id":"t1","worker":"executor"}]',
    );
    if (anthropic) {
      expect(res.body).toContain('"input_tokens":12,"output_tokens":7');
      expect(res.body.match(/event: message_delta\n/g)).toHaveLength(1);
    } else {
      expect(res.body).toContain(
        '"prompt_tokens":12,"completion_tokens":7,"total_tokens":19',
      );
      expect(res.body.match(/"choices":\[\],"usage":/g)).toHaveLength(1);
      expect(res.body.indexOf('"choices":[],"usage":')).toBeLessThan(
        res.body.indexOf('data: [DONE]'),
      );
    }
    expect(res.body.match(/: turn-end/g)).toHaveLength(1);
    expect(res.body.indexOf(': turn-end')).toBeLessThan(
      res.body.indexOf(': message-id follow-id'),
    );
    for (const id of ['one', 'two', 'follow-id']) {
      const start = res.body.indexOf(`: message-id ${id}\n`);
      const end = res.body.indexOf(`: message-end ${id}\n`);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(res.body.slice(start, end)).toContain(
        id === 'follow-id' ? 'follow' : id,
      );
    }
    expect(
      res.body.match(anthropic ? /event: message_stop\n/g : /data: \[DONE\]/g),
    ).toHaveLength(1);
    expect(
      res.body.match(
        anthropic ? /event: content_block_stop\n/g : /"finish_reason":"stop"/g,
      ),
    ).toHaveLength(1);
    if (anthropic)
      expect(res.body.match(/event: content_block_start\n/g)).toHaveLength(1);
    const terminalStart = res.body.indexOf(
      anthropic ? 'event: content_block_stop' : 'data: {"id"',
      res.body.indexOf(': message-end follow-id'),
    );
    for (const body of [res.body, res.body.slice(0, terminalStart)]) {
      const response = new globalThis.Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
      const events = anthropic
        ? AnthropicStream.fromSSEResponse<any>(response, new AbortController())
        : OpenAIStream.fromSSEResponse<any>(response, new AbortController());
      let text = '';
      for await (const event of events)
        text += anthropic
          ? event.delta?.text || ''
          : event.choices?.[0]?.delta?.content || '';
      expect(text).toBe(`${visible}\n\nfollow`);
    }
  });

  it(`${label}: follow begins after the session slot is released`, async () => {
    const handle = await dialogueFor('alice', session.key, 'DEST');
    handle.state = () => ({
      settledSeq: 0,
      lastFailedSeq: 0,
      status: 'active',
      turnActive: false,
      queuedInputs: 0,
      running: 1,
      total: 1,
      done: 0,
      idle: false,
    });
    const following = deferred();
    handle.subscribe = () => {
      following.resolve();
      return () => {};
    };
    const res = fakeRes();
    const response = handler(streamingRequest(), res as unknown as Response);
    await following.promise;
    expect(theRetention().hasLease('alice', session.key, 'pipeline')).toBe(
      false,
    );
    const other = await admitPipeline('alice', 'another-session');
    expect('admitted' in other).toBe(true);
    if ('admitted' in other) other.admitted.release();
    let admitted = false;
    await longSessions().run(session, async () => {
      admitted = true;
    });
    expect(admitted).toBe(true);
    res.disconnect();
    await response;
  });

  it(`${label}: follow failure emits an error without a success terminal`, async () => {
    const handle = await dialogueFor('alice', session.key, 'DEST');
    handle.state = () => ({
      settledSeq: 0,
      lastFailedSeq: 0,
      status: 'done',
      turnActive: false,
      queuedInputs: 0,
      running: 0,
      total: 1,
      done: 1,
      idle: false,
    });
    handle.subscribe = () => {
      throw new Error('follow failed');
    };
    const res = fakeRes();
    await handler(streamingRequest(), res as unknown as Response);
    expect(res.body).toContain('follow failed');
    if (anthropic) {
      expect(res.body).toContain('event: error\n');
      expect(res.body).toContain('"type":"api_error"');
    } else {
      const errorChunk = res.body
        .split('\n')
        .find((line) => line.startsWith('data: {"error":'));
      expect(JSON.parse(errorChunk?.slice('data: '.length) ?? '')).toEqual({
        error: { message: 'follow failed', type: 'server_error' },
      });
    }
    expect(res.body).not.toContain('[DONE]');
    expect(res.body).not.toContain('event: message_stop');
    expect(res.body).not.toContain('"finish_reason":"stop"');
    expect(ended).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    `${label}: failed background settlement emits an error (retained before subscription=%s)`,
    async (retained) => {
      const handle = await dialogueFor('alice', session.key, 'DEST');
      let settledSeq = 0;
      let lastFailedSeq = 0;
      handle.state = () => ({
        settledSeq,
        lastFailedSeq,
        status: 'active',
        turnActive: false,
        queuedInputs: 0,
        running: 0,
        total: 1,
        done: 1,
        idle: retained,
      });
      const progress = {
        id: 'progress',
        text: 'background progress',
        createdAt: 4,
        trigger: 'event' as const,
      };
      jest.spyOn(outbox, 'pending').mockReturnValue([]);
      if (retained) {
        send.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          lastFailedSeq = ++settledSeq;
          settledSeq++;
          return { text: 'answer' };
        });
      }
      handle.subscribe = (fn) => {
        if (retained) return () => {};
        jest.spyOn(outbox, 'pending').mockReturnValue([progress]);
        setImmediate(() => {
          lastFailedSeq = ++settledSeq;
          fn({ kind: 'settled', outcome: 'failed', trigger: 'event' });
        });
        return () => {};
      };
      const res = fakeRes();
      await handler(streamingRequest(), res as unknown as Response);
      if (!retained) expect(res.body).toContain('background progress');
      expect(res.body).toContain('Background planner turn failed');
      if (anthropic) {
        expect(res.body).toContain('event: error\n');
        expect(res.body).toContain('"type":"api_error"');
      } else {
        const errorChunk = res.body
          .split('\n')
          .find((line) => line.startsWith('data: {"error":'));
        expect(JSON.parse(errorChunk?.slice('data: '.length) ?? '')).toEqual({
          error: {
            message: 'Background planner turn failed',
            type: 'server_error',
          },
        });
      }
      expect(res.body).not.toContain('[DONE]');
      expect(res.body).not.toContain('event: message_stop');
      expect(res.body).not.toContain('"finish_reason":"stop"');
      expect(ended).not.toHaveBeenCalled();
    },
  );
}

for (const anthropic of [false, true]) {
  for (const readiness of [false, true]) {
    it(`setup rejection ends the stream and heartbeat (anthropic=${anthropic}, readiness=${readiness})`, async () => {
      const { getCollectionRegistry } = await import('../../srv/agent-manager');
      const retrieval = await import('../../srv/lib/collection-retrieval');
      const { CollectionBackendError } = await import(
        '../../srv/lib/collection-persistence'
      );
      jest.useFakeTimers();
      const res = fakeRes();
      const req = streamingRequest();
      const error = readiness
        ? new CollectionBackendError('restore', {
            name: 'RagError',
            code: 'COLLECTIONS_UNAVAILABLE',
            message: 'registry unavailable',
          })
        : new Error('retrieval failed');
      if (readiness) {
        req.headers['x-rag-collections'] = 'docs';
        jest
          .spyOn(getCollectionRegistry(), 'ready', 'get')
          .mockImplementation(() => {
            expect(res.headersSent).toBe(true);
            return Promise.reject(error);
          });
      } else {
        jest.spyOn(retrieval, 'collectionRetrieval').mockReturnValue({
          restore: jest.fn(),
          retrieve: async () => {
            expect(res.headersSent).toBe(true);
            throw error;
          },
        });
      }
      try {
        await (anthropic ? handleAnthropicMessages : handleChatCompletions)(
          req,
          res as unknown as Response,
        );
        expect(res.statusCode).toBe(200);
        expect(res.writableEnded).toBe(true);
        expect(res.body).toContain(error.message);
        expect(res.body).toContain(
          anthropic ? 'event: error' : '"type":"server_error"',
        );
        expect(res.body).not.toContain('[DONE]');
        expect(res.body).not.toContain('message_stop');
        expect(res.body).not.toContain('"finish_reason":"stop"');
        expect(ended).not.toHaveBeenCalled();
        const body = res.body;
        await jest.advanceTimersByTimeAsync(20_000);
        expect(res.body).toBe(body);
      } finally {
        jest.restoreAllMocks();
        jest.useRealTimers();
      }
    });
  }
}

it('a request during follow sees the preceding turn in its history', async () => {
  const handle = await dialogueFor('alice', session.key, 'DEST');
  handle.state = () => ({
    settledSeq: 0,
    lastFailedSeq: 0,
    status: 'active',
    turnActive: false,
    queuedInputs: 0,
    running: 1,
    total: 1,
    done: 0,
    idle: false,
  });
  const following = deferred();
  handle.subscribe = () => {
    following.resolve();
    return () => {};
  };
  const res = fakeRes();
  const first = handleChatCompletions(
    streamingRequest(),
    res as unknown as Response,
  );
  await following.promise;
  expect(res.writableEnded).toBe(false);
  expect(getSessionHistory(session.key, 'alice').map((m) => m.content)).toEqual(
    ['hi', visible],
  );
  send.mockImplementationOnce(async () => {
    expect(getRequestHistory()).toEqual([
      expect.objectContaining({ role: 'user', content: 'hi' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining(visible),
      }),
    ]);
    return { text: 'second answer' };
  });
  const req = streamingRequest();
  Object.assign(req, { sessionMinted: false });
  req.body = { messages: [{ role: 'user', content: 'second question' }] };
  const secondRes = fakeRes();
  await handleChatCompletions(req, secondRes as unknown as Response);
  expect(secondRes.body).toContain('second answer');
  await first;
  const history = getSessionHistory(session.key, 'alice');
  expect(history.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(history[1].content).toContain(visible);
});

it.each([undefined, 'explicit'])(
  'superseded delivery confirms before arrival (%s)',
  async (mode) => {
    jest.mocked(outbox.pending).mockRestore();
    jest.mocked(outbox.confirmUpTo).mockRestore();
    directAnswer();
    const handle = await dialogueFor('alice', session.key, 'SAP');
    handle.state = () => ({
      settledSeq: 0,
      lastFailedSeq: 0,
      status: 'active',
      turnActive: false,
      queuedInputs: 0,
      running: 1,
      total: 1,
      done: 0,
      idle: false,
    });
    handle.subscribe = () => () => {};
    const first = directChat(mode ? 'none' : undefined);
    await chunksOf(first.agent);
    const id = outbox.pending()[0].id;
    const iterator = first.agent
      .follow(new AbortController().signal, 10000)
      ?.[Symbol.asyncIterator]();
    if (!iterator) throw new Error('expected a follow');
    const end = iterator.next();
    await tick();
    let opened = false;
    const second = chunksOf(directChat(mode ? id : undefined).agent).then(
      (chunks) => {
        opened = true;
        return chunks;
      },
    );
    expect((await end).value).toMatchObject({
      kind: 'end',
      reason: 'superseded',
    });
    await tick();
    expect(opened).toBe(false);
    first.res.end();
    const chunks = await second;
    expect(chunks.some((c) => c.clhMessageId === id)).toBe(false);
    expect(chunks.map((c) => c.content || '').join('')).toBe('answer');
    await iterator.return?.();
  },
);

it('superseded response closed abnormally redelivers its message', async () => {
  jest.mocked(outbox.pending).mockRestore();
  directAnswer();
  const handle = await dialogueFor('alice', session.key, 'SAP');
  handle.state = () => ({
    settledSeq: 0,
    lastFailedSeq: 0,
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
  const id = outbox.pending()[0].id;
  const iterator = first.agent
    .follow(new AbortController().signal, 10000)
    ?.[Symbol.asyncIterator]();
  if (!iterator) throw new Error('expected a follow');
  const end = iterator.next();
  await tick();
  const second = chunksOf(directChat().agent);
  expect((await end).value).toMatchObject({ reason: 'superseded' });
  first.res.disconnect();
  expect((await second).some((c) => c.clhMessageId === id)).toBe(true);
  await iterator.return?.();
});

it.each([false, true])(
  'reply separator appears only with preceding messages (empty=%s)',
  async (empty) => {
    emptyPending = empty;
    directAnswer();
    const chunks = await chunksOf(directChat().agent);
    const start = chunks.findIndex(
      (c) =>
        c.clhMessageId && c.clhMessageId !== 'one' && c.clhMessageId !== 'two',
    );
    expect(chunks[start + 1].content).toBe('answer');
    expect(chunks[start - 1]?.content).toBe(empty ? undefined : '\n\n');
    expect(chunks.map((c) => c.content || '').join('')).toBe(
      empty ? 'answer' : visible,
    );
  },
);

it('empty pending messages do not add a separator before the reply', async () => {
  jest
    .mocked(outbox.pending)
    .mockReturnValue([
      { id: 'empty', text: '  ', createdAt: 0, trigger: 'event' },
    ]);
  directAnswer();
  const chunks = await chunksOf(directChat().agent);
  expect(chunks.map((c) => c.content || '').join('')).toBe('answer');
  expect(chunks.some((c) => c.clhMessageId === 'empty')).toBe(false);
});

it('non-streaming dialogue usage includes nonnegative request wall clock', async () => {
  send.mockResolvedValue({
    text: 'timed answer',
    usage: {
      planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    },
  });
  const result = await directChat().agent.process([]);
  if (!result.ok) throw new Error('Expected successful dialogue');
  expect(result.value.usage?.x_hub.duration_ms).toEqual(expect.any(Number));
  expect(result.value.usage?.x_hub.duration_ms).toBeGreaterThanOrEqual(0);
});
