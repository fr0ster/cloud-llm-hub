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
const ack = jest.fn(async () => {});
let subscribed = false;
const send = jest.fn();
beforeEach(() => {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
  clearGatekeeperConfig();
  resetGatekeeperForTest();
  harness.reset();
  refresh.mockClear();
  ack.mockClear();
  subscribed = false;
  send.mockReset();
  const registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {} },
  );
  setLongSessionsForTest(registry);
  session = registry.open('alice', {}) as LongSession;
  jest.mocked(dialogueFor).mockResolvedValue({
    factory: { refresh },
    drainPending: async () => {},
    hasSubscribers: () => subscribed,
    outbox: {
      replay: () => [
        { id: 'one', text: 'one' },
        { id: 'two', text: 'two' },
      ],
      ack,
    },
    session: { takePending: () => [{ text: 'one' }, { text: 'two' }], send },
  } as never);
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
const visible = '**Planner:** one\n\n**Planner:** two\n\nanswer';
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
        expect(res.body.indexOf('**Planner:** one')).toBeLessThan(
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
      expect(ack).toHaveBeenCalledWith('two');
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
  expect(ack).not.toHaveBeenCalled();
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
      expect(ack).not.toHaveBeenCalled();
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
  'active subscriber excludes outbox from chat (stream=%s)',
  async (stream) => {
    subscribed = true;
    const req = fakeReq(
      { stream, messages: [{ role: 'user', content: 'hi' }] },
      session.key,
    ) as unknown as Request & { longSession: LongSession };
    req.longSession = session;
    const res = fakeRes();
    await handleChatCompletions(req, res as unknown as Response);
    expect(res.body).toContain('answer');
    expect(res.body).not.toContain('**Planner:**');
    expect(ack).not.toHaveBeenCalled();
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
  expect(ack).not.toHaveBeenCalled();
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
      options.onPartial({ kind: 'content', delta: before });
      options.onPartial({ kind: 'tool_call', name: 'test' });
      options.onPartial({ kind: 'content', delta: 'after' });
      return { text: before + 'after' };
    });
    const { dialogueChat } = await import('../../srv/lib/dialogue-chat');
    const res = fakeRes();
    const agent = dialogueChat(
      fakeReq({}, session.key) as unknown as Request,
      'alice',
      session,
      'SAP',
      'hi',
      res as unknown as Response,
    );
    let text = '';
    for await (const chunk of agent.streamProcess([]))
      if (chunk.ok) text += chunk.value.content || '';
    expect(text).toContain(
      before + (before.endsWith('\n') ? '' : '\n\n') + 'after',
    );
  },
);
