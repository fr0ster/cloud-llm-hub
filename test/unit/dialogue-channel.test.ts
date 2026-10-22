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
const send = jest.fn();
beforeEach(() => {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
  clearGatekeeperConfig();
  resetGatekeeperForTest();
  harness.reset();
  refresh.mockClear();
  send.mockReset();
  const registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {} },
  );
  setLongSessionsForTest(registry);
  session = registry.open('alice', {}) as LongSession;
  jest.mocked(dialogueFor).mockResolvedValue({
    factory: { refresh },
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
