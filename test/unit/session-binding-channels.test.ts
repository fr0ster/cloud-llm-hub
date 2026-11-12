import type { CallOptions } from '@mcp-abap-adt/llm-agent';

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
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/lib/logging-config', () => ({ applyLoggingConfig() {} }));
jest.mock('../../srv/agent-manager', () => ({
  ...require('./helpers/channel-harness').agentManagerMock(),
  createAgentProfileSource: () => ({
    list: async () => ({ ok: true, value: [] }),
  }),
  runWithCallerExposition: (
    _levels: string[] | undefined,
    run: () => Promise<object>,
  ) => run(),
}));
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  ...jest.requireActual('../../srv/lib/dialogue-sessions'),
  headlessDialogueFor: async (
    _req: object,
    _userId: string,
    _key: string,
    _destination: string,
    caller: NonNullable<CallOptions['caller']>,
  ) => ({
    caller,
    session: {
      callTool: async (_name: string, _args: object, options: CallOptions) => {
        require('./helpers/channel-harness').harness.seenOptions.push(options);
        return { ok: true, value: { content: 'Plan ready' } };
      },
    },
  }),
}));
jest.mock('../../srv/agent-config', () => ({
  parseToolResultMaxChars: jest.requireActual('../../srv/agent-config')
    .parseToolResultMaxChars,
  getAgentConfig: () => ({
    ...require('./helpers/channel-harness').agentConfigMock().getAgentConfig(),
    rag: { backends: { session: 'in-memory' } },
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

import { getCollectionRegistry } from '../../srv/agent-manager';
import { executeStep } from '../../srv/agent-mcp';
import { executeOrchestrationTool } from '../../srv/agent-mcp-orchestration';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { LocalRagMcpClient } from '../../srv/lib/dialogue-rag-tools';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  createHubRagAccess,
  getHubRagAccess,
  initHubRagAccess,
} from '../../srv/lib/rag-access';
import { bindCaller } from '../../srv/lib/rag-caller';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import { handleChatCompletions } from '../../srv/openai-handler';
import { harness, sessionChannel } from './helpers/channel-harness';

const caller = { userId: 'u1', exposition: undefined };
beforeEach(() => {
  harness.reset();
  harness.user.id = 'u1';
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      lifecycleHooks(),
    ),
  );
});
afterEach(() => setLongSessionsForTest(undefined));

test('MCP call without x-clh-session is refused naming the header', async () => {
  const { req } = sessionChannel();
  const results = [
    await executeStep(req, caller, { task: 'Read' }),
    await executeOrchestrationTool(req, caller, 'plan_create', {
      goal: 'Read',
    }),
    await executeOrchestrationTool(req, caller, 'plan_revise', {
      change: 'Read',
    }),
  ];
  for (const result of results) {
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('SESSION_REQUIRED');
    expect(result.content[0]?.text).toContain('x-clh-session');
  }
  expect(harness.seenOptions).toHaveLength(0);
});

test.each(['/chat/completions', '/messages'])(
  'a /v1 request without session gets a minted, bound session (%s)',
  async (path) => {
    const { req, res } = sessionChannel({}, path);
    const next = jest.fn();
    await sessionMiddleware({ userIdOf: () => 'u1' })(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sessionId).toMatch(/^s-/);
    expect(res.headers['Set-Cookie']).toContain(`clh_session=${req.sessionId}`);
    expect(
      await getHubRagAccess().access.bindings.getUserId(req.sessionId),
    ).toEqual({ ok: true, value: 'u1' });
  },
);

test.each(['/chat/completions', '/messages'])(
  'a clh_session cookie of u1 presented by u2 is refused (%s)',
  async (path) => {
    expect((await bindCaller('s-owned', 'u1', false)).ok).toBe(true);
    const { req, res } = sessionChannel({}, path);
    req.headers.cookie = 'clh_session=s-owned';
    const next = jest.fn();
    await sessionMiddleware({ userIdOf: () => 'u2', isLive: () => false })(
      req,
      res,
      next,
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(
      await getHubRagAccess().access.bindings.getUserId('s-owned'),
    ).toEqual({ ok: true, value: 'u1' });
    expect(harness.seenOptions).toHaveLength(0);
  },
);

test.each([
  { source: 'header', optional: false },
  { source: 'body', optional: false },
  { source: 'header', optional: true },
  { source: 'body', optional: true },
])(
  'foreign cookie is refused before explicit $source resolution (optional=$optional)',
  async ({ source, optional }) => {
    expect((await bindCaller('s-owned', 'u1', false)).ok).toBe(true);
    const { longSessions } = await import('../../srv/lib/long-session');
    const own = longSessions().open('u2', {
      destination: 'DEST',
      key: 'ls-own',
    });
    if ('refused' in own) throw new Error('Session open refused');
    expect((await bindCaller(own.key, 'u2', false)).ok).toBe(true);
    const key = optional ? 'stale-key' : own.key;
    const { req, res } = sessionChannel(
      source === 'body' ? { session: key } : {},
    );
    if (source === 'header') req.headers['x-clh-session'] = key;
    req.headers.cookie = 'clh_session=s-owned';
    const resolveSession = jest.fn(async () => (optional ? undefined : own));
    const isLive = jest.fn(() => false);
    const next = jest.fn();
    await sessionMiddleware({
      userIdOf: () => 'u2',
      resolveSession,
      isLive,
      keyOptional: () => optional,
    })(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
    expect(isLive).not.toHaveBeenCalled();
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(req.sessionId).toBeUndefined();
    expect(
      await getHubRagAccess().access.bindings.getUserId('s-owned'),
    ).toEqual({ ok: true, value: 'u1' });
    expect(await getHubRagAccess().access.bindings.getUserId(own.key)).toEqual({
      ok: true,
      value: 'u2',
    });
  },
);

test('two MCP sessions of one user do not share session collections or history', async () => {
  const { longSessions } = await import('../../srv/lib/long-session');
  const a = longSessions().open('u1', { destination: 'DEST', key: 'ls-a' });
  const b = longSessions().open('u1', { destination: 'DEST', key: 'ls-b' });
  if ('refused' in a || 'refused' in b) throw new Error('Session open refused');
  const registry = getCollectionRegistry();
  const tools = new LocalRagMcpClient(
    {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => {
        throw new Error('Unexpected external tool');
      },
    },
    () => registry,
  );
  let written = false;
  harness.process = async (messages, options) => {
    if (!options.caller) throw new Error('Agent caller missing');
    if (!written) {
      expect(options.sessionId).toBe(a.key);
      const created = await tools.callTool(
        'collection_create',
        {
          name: 'private-notes',
          scope: 'session',
        },
        options,
      );
      expect(created.ok && !created.value.isError).toBe(true);
      const added = await tools.callTool(
        'record_add',
        {
          collection: 'session/private-notes',
          record: 'private',
          text: 'Only session A',
        },
        options,
      );
      expect(added.ok && !added.value.isError).toBe(true);
      written = true;
    }
    const records = await tools.callTool(
      'rag_read',
      {
        collection: 'session/private-notes',
        id: 'private',
      },
      options,
    );
    expect(records.ok).toBe(true);
    if (!records.ok) throw records.error;
    if (options.sessionId === a.key) {
      if (messages.some((message) => message.content === 'Recall A')) {
        expect(JSON.stringify(messages)).toContain('Only session A history');
      }
      expect(records.value.isError).not.toBe(true);
      expect(records.value.content).toContain('Only session A');
      return { ok: true, value: { content: 'Only session A history' } };
    }
    expect(records.value.isError).toBe(true);
    expect(records.value.content).not.toContain('Only session A');
    expect(records.value.content).toContain('not found');
    expect(JSON.stringify(messages)).not.toContain('Only session A');
    return { ok: true, value: { content: 'Session B' } };
  };
  const { req } = sessionChannel();
  req.headers['x-clh-session'] = a.key;
  const first = await executeStep(req, caller, { task: 'Write private turn' });
  expect(first.isError).not.toBe(true);
  req.headers['x-clh-session'] = b.key;
  expect((await executeStep(req, caller, { task: 'Recall' })).isError).not.toBe(
    true,
  );
  req.headers['x-clh-session'] = a.key;
  expect(
    (await executeStep(req, caller, { task: 'Recall A' })).isError,
  ).not.toBe(true);
  expect(harness.seenOptions.map((o) => o.sessionId)).toEqual([
    a.key,
    b.key,
    a.key,
  ]);
});

test('no channel passes an empty sessionId to the agent', async () => {
  for (const path of ['/chat/completions', '/messages']) {
    const { req, res } = sessionChannel(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'Read' }],
        max_tokens: 32,
      },
      path,
    );
    await sessionMiddleware({ userIdOf: () => 'u1' })(req, res, () => {});
    await (path === '/messages'
      ? handleAnthropicMessages(req, res)
      : handleChatCompletions(req, res));
    expect(res.statusCode).toBe(200);
  }
  const { longSessions } = await import('../../srv/lib/long-session');
  const s = longSessions().open('u1', { destination: 'DEST' });
  if ('refused' in s) throw new Error('Session open refused');
  const { req } = sessionChannel();
  req.headers['x-clh-session'] = s.key;
  expect((await executeStep(req, caller, { task: 'Read' })).isError).not.toBe(
    true,
  );
  for (const name of ['plan_create', 'plan_revise'] as const) {
    expect(
      (
        await executeOrchestrationTool(req, caller, name, {
          goal: 'Read',
          change: 'Read',
        })
      ).isError,
    ).not.toBe(true);
  }
  expect(harness.seenOptions).toHaveLength(5);
  for (const options of harness.seenOptions) {
    expect(options.sessionId?.trim()).toBeTruthy();
    expect(options.sessionId).toBe(options.caller?.sessionId);
  }
});

test.each(['/chat/completions', '/messages'])(
  'a handler without middleware never invents a session (%s)',
  async (path) => {
    const { req, res } = sessionChannel(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'Read' }],
        max_tokens: 32,
      },
      path,
    );
    await (path === '/messages'
      ? handleAnthropicMessages(req, res)
      : handleChatCompletions(req, res));
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('SESSION_REQUIRED');
    expect(harness.seenOptions).toHaveLength(0);
  },
);
