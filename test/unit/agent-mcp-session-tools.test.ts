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
jest.mock('../../srv/agent-manager', () =>
  require('./helpers/channel-harness').agentManagerMock(),
);
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  // Records itself into `harness.events`: it's the first thing
  // `buildConnectionForDestination` calls, so its absence is how a test
  // proves a closed destination is refused before a connection is built.
  resolveDestinationSapConfig: async () => {
    require('./helpers/channel-harness').harness.events.push(
      'resolveDestinationSapConfig',
    );
    return {
      proxyType: 'Internet',
      authenticationType: 'OAuth2JWTBearer',
      sapConfig: { authType: 'jwt' },
      destinationName: 'DEST',
    };
  },
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => ({ connect: async () => {} }),
}));
jest.mock('../../srv/lib/request-system-context', () =>
  require('./helpers/channel-harness').requestSystemMock(),
);
jest.mock('../../srv/lib/principal', () => ({
  ...jest.requireActual('../../srv/lib/principal'),
  computeDumpScope: () => undefined,
}));
// The SDK's server, reduced to what the test needs from it: the callback
// `registerTool` was handed, so a test can call it the way the SDK does —
// with the request's `extra`, whose signal the transport aborts on close.
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools = new Map<
    string,
    (args: unknown, extra: { signal: AbortSignal }) => unknown
  >();
  return {
    tools,
    McpServer: class {
      registerTool(
        name: string,
        _config: unknown,
        cb: (args: unknown, extra: { signal: AbortSignal }) => unknown,
      ) {
        tools.set(name, cb);
      }
      async connect() {}
    },
  };
});
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async close() {}
  },
}));

import type { Request } from 'express';
import {
  createAgentMcpServerForRequest,
  executeStep,
} from '../../srv/agent-mcp';
import {
  LongSessionRegistry,
  longSessions,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';
import { deferred, harness, tick } from './helpers/channel-harness';

const caller = { userId: 'alice', exposition: undefined };
const req = { headers: { 'x-sap-destination': 'DEST' } } as unknown as Request;
const tools = jest.requireMock('@modelcontextprotocol/sdk/server/mcp.js').tools;
const call = (name: string, args = {}) =>
  tools.get(name)(args, { signal: new AbortController().signal });
async function opened() {
  const result = await call('session_open');
  return JSON.parse(result.content[0].text).session;
}
beforeEach(async () => {
  harness.reset();
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      lifecycleHooks(),
    ),
  );
  await createAgentMcpServerForRequest(req);
});
afterEach(() => setLongSessionsForTest(undefined));
it('session_open returns an ls- key', async () => {
  const result = JSON.parse((await call('session_open')).content[0].text);
  expect(result).toEqual({
    session: expect.stringMatching(/^ls-/),
    ttlSeconds: 3600,
    destination: 'DEST',
  });
});
it('session_close closes it (second close ? SESSION_NOT_FOUND)', async () => {
  const session = await opened();
  expect(
    JSON.parse((await call('session_close', { session })).content[0].text),
  ).toEqual({ closed: true });
  expect((await call('session_close', { session })).content[0].text).toContain(
    'SESSION_NOT_FOUND',
  );
});
it('execute_step with session reuses one connection across two calls', async () => {
  const session = await opened();
  await executeStep(req, caller, { session, task: 'first' });
  await executeStep(req, caller, { session, task: 'second' });
  expect(harness.establishCalls).toEqual(['DEST']);
  expect(harness.events).not.toContain('safeStop');
  expect(harness.seenOptions.map((o) => o.sessionId)).toEqual([
    session,
    session,
  ]);
  expect(harness.seenOptions[0].trace).not.toEqual(
    harness.seenOptions[1].trace,
  );
});
it('execute_step calls of one session run one after another', async () => {
  const session = await opened();
  const gate = deferred();
  harness.process = async () => {
    await gate.promise;
    return { ok: true, value: { content: 'done' } };
  };
  const first = executeStep(req, caller, { session, task: 'first' });
  await tick();
  const second = executeStep(req, caller, { session, task: 'second' });
  await tick();
  expect(harness.seenOptions).toHaveLength(1);
  gate.resolve();
  await Promise.all([first, second]);
  expect(harness.seenOptions).toHaveLength(2);
});
it("execute_step with another destination than the session's ? error naming both", async () => {
  const session = await opened();
  const result = await executeStep(req, caller, {
    session,
    destination: 'OTHER',
    task: 'first',
  });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('DEST');
  expect(result.content[0].text).toContain('OTHER');
  expect(harness.seenOptions).toHaveLength(0);
});
it("execute_step with a session sees the previous step's turn in its messages", async () => {
  const session = await opened();
  const messages: unknown[] = [];
  harness.process = async (m) => {
    messages.push(m);
    return { ok: true, value: { content: 'answer' } };
  };
  await executeStep(req, caller, { session, task: 'first' });
  await executeStep(req, caller, { session, task: 'second' });
  expect(messages[1]).toEqual([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ]);
});
it('execute_step without session keeps the throwaway session', async () => {
  await executeStep(req, caller, { task: 'first' });
  expect(harness.seenOptions[0].sessionId).toMatch(/^agent-step-/);
  expect(harness.events).toContain('safeStop');
});

it('refuses missing or changed credentials as MCP errors without closing the held connection', async () => {
  const credentials = jest.requireMock('../../srv/lib/request-connection');
  const session = await opened();
  await executeStep(req, caller, { session, task: 'first' });
  const held = longSessions().get('alice', session)?.connection;
  const spy = jest.spyOn(credentials, 'readRequestCredential');
  try {
    spy.mockReturnValue({ kind: 'none' });
    const missing = await executeStep(req, caller, { session, task: 'second' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('SAP_CREDENTIALS_REQUIRED');
    spy.mockReturnValue({ kind: 'basic', sapLogin: 'BOB' });
    const mismatch = await executeStep(req, caller, { session, task: 'third' });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0].text).toContain('SESSION_CREDENTIAL_MISMATCH');
    expect(harness.establishCalls).toHaveLength(1);
    expect(longSessions().get('alice', session)?.connection).toBe(held);
  } finally {
    spy.mockRestore();
  }
});
it('refuses unknown and another user sessions', async () => {
  const session = await opened();
  for (const [userId, key] of [
    ['bob', session],
    ['alice', 'ls-unknown'],
  ]) {
    const result = await executeStep(
      req,
      { userId, exposition: undefined },
      { session: key, task: 'first' },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SESSION_NOT_FOUND');
  }
  expect(harness.seenOptions).toHaveLength(0);
});
it('session_open returns SESSION_LIMIT at the cap', async () => {
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 1, maxPerUser: 1, queueLength: 0 },
      lifecycleHooks(),
    ),
  );
  await opened();
  const result = await call('session_open');
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('SESSION_LIMIT');
});
it('session_close answers closed even when cleanup fails', async () => {
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 1, maxPerUser: 1, queueLength: 0 },
      {
        onClose: async () => {
          throw new Error('cleanup failed');
        },
      },
    ),
  );
  const session = await opened();
  expect(
    JSON.parse((await call('session_close', { session })).content[0].text),
  ).toEqual({ closed: true });
  expect((await call('session_close', { session })).content[0].text).toContain(
    'SESSION_NOT_FOUND',
  );
});
