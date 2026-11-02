import type {
  AgentCallOptions,
  ISmartAgent,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { resetQuotaGates, runWithThrottleRetry } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import type { Request, Response } from 'express';

jest.mock('../../srv/lib/logging-config', () => ({
  applyLoggingConfig: jest.fn(),
}));
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
  getAgentConfig: () => ({
    llm: { model: 'm' },
    mcp: { destination: 'DEST' },
    agent: { chatCoordinator: mockCoordinator },
  }),
}));
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/lib/request-system-context', () =>
  require('./helpers/channel-harness').requestSystemMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));

import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { guardLlmOnlyAgent } from '../../srv/lib/llm-only-guard';
import {
  type LongSession,
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  longSessionLlms,
  type SessionLlms,
  sessionLlms,
} from '../../srv/lib/session-llms';
import { WaitAsNeeded } from '../../srv/lib/throttle-strategy';
import { handleChatCompletions } from '../../srv/openai-handler';
import { fakeReq, fakeRes, harness } from './helpers/channel-harness';

const channels = [
  ['openai', handleChatCompletions],
  ['anthropic', handleAnthropicMessages],
] as const;

let mockCoordinator: 'adaptive' | 'fixed' = 'adaptive';
let registry: LongSessionRegistry;
function open(userId: string): LongSession {
  const session = registry.open(userId, { key: 'shared' });
  if ('refused' in session) throw new Error(session.refused);
  return session;
}
function call(handler: typeof handleChatCompletions, session?: LongSession) {
  const req = Object.assign(
    fakeReq({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    { longSession: session },
  );
  return handler(req as unknown as Request, fakeRes() as unknown as Response);
}
beforeEach(() => {
  harness.reset();
  mockCoordinator = 'adaptive';
  registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {} },
  );
  setLongSessionsForTest(registry);
});
afterEach(async () => {
  await registry.closeAll('shutdown');
  setLongSessionsForTest(undefined);
  resetQuotaGates();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

for (const [channel, handler] of channels) {
  it.each(['adaptive', 'fixed'] as const)(
    `${channel} %s isolates a session's 429 gate`,
    async (mode) => {
      mockCoordinator = mode;
      jest.useFakeTimers();
      const a = open('alice');
      const b = open('bob');
      const aOwner = longSessionLlms(a);
      let attempts = 0;
      let aFinished = false;
      harness.process = async () => {
        const owner = sessionLlms.getStore();
        if (!owner) throw new Error('request owner missing');
        await runWithThrottleRetry(
          async () => {
            if (owner === aOwner && ++attempts === 1) throw new Error('429');
          },
          {
            key: `request-test:${owner.quotaScope}`,
            strategy: new WaitAsNeeded(),
            isThrottled: (error) =>
              error instanceof Error && error.message === '429',
            retryAfterSeconds: () => 2,
          },
        );
        return { ok: true, value: { content: 'done', stopReason: 'stop' } };
      };
      const first = call(handler, a).then(() => {
        aFinished = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await call(handler, b);
      expect(aFinished).toBe(false);
      await jest.advanceTimersByTimeAsync(3000);
      await first;
      expect(attempts).toBe(2);
    },
  );

  it(`${channel} fallback classifier reuses the session client and isolates other sessions`, async () => {
    const classifier = await makeHubLlm(
      {
        provider: 'openai',
        apiKey: 'test',
        model: 'classifier',
        contextCapture: 'off',
      },
      0,
    );
    const providers: OpenAIProvider[] = [];
    jest
      .spyOn(OpenAIProvider.prototype, 'chat')
      .mockImplementation(async function (this: OpenAIProvider) {
        providers.push(this);
        return {
          content: '{"action":true,"language":"en"}',
          finishReason: 'stop',
        };
      });
    const inner: ISmartAgent = {
      process: jest.fn(),
      streamProcess: jest.fn(),
    };
    const fallback = guardLlmOnlyAgent(inner, {
      decide: classifier,
      why: 'unreachable',
    });
    harness.process = async (
      messages: Message[],
      options: AgentCallOptions,
    ) => {
      const result = await fallback.process(messages, options);
      return result.ok ? { ok: true, value: { ...result.value } } : result;
    };
    const a = open('alice');
    const b = open('bob');
    await call(handler, a);
    await call(handler, a);
    await call(handler, b);
    expect(providers).toHaveLength(3);
    expect(providers[0]).toBe(providers[1]);
    expect(providers[0]).not.toBe(providers[2]);
    expect(inner.process).not.toHaveBeenCalled();
  });

  it(`${channel} disposes independent per-request clients after responding`, async () => {
    const owners: SessionLlms[] = [];
    harness.process = async () => {
      const owner = sessionLlms.getStore();
      if (!owner) throw new Error('request owner missing');
      owners.push(owner);
      return { ok: true, value: { content: 'done', stopReason: 'stop' } };
    };
    await call(handler);
    await call(handler);
    expect(owners).toHaveLength(2);
    expect(owners[0]).not.toBe(owners[1]);
    for (const owner of owners)
      await expect(owner.get('unused', jest.fn())).rejects.toThrow('closed');
  });
}
