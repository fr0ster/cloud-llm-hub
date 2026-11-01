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
jest.mock('../../srv/agent-manager', () => ({
  ...require('./helpers/channel-harness').agentManagerMock(),
  createAgentProfileSource: () => ({
    list: async () => ({ ok: true, value: [] }),
    getPrompts: async () => ({ ok: true, value: {} }),
    get: async (name: string) => ({
      ok: true,
      value: {
        name,
        description: '',
        systemPrompt: '',
        tools: name === 'writer' ? { allow: ['write'] } : 'read-only',
        result: name === 'checker' ? 'verdict' : 'report',
      },
    }),
  }),
}));
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
  const definitions = new Map<
    string,
    { description: string; inputSchema: object }
  >();
  const tools = new Map<
    string,
    (args: unknown, extra: { signal: AbortSignal }) => unknown
  >();
  return {
    tools,
    definitions,
    McpServer: class {
      registerTool(
        name: string,
        config: { description: string; inputSchema: object },
        cb: (args: unknown, extra: { signal: AbortSignal }) => unknown,
      ) {
        tools.set(name, cb);
        definitions.set(name, config);
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
import { z } from 'zod';
import { getCollectionRegistry } from '../../srv/agent-manager';
import {
  createAgentMcpServerForRequest,
  executeStep,
} from '../../srv/agent-mcp';
import { userCollectionId } from '../../srv/collection-ids';
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
  if (!(await getCollectionRegistry().getCollection('agents')))
    await getCollectionRegistry().createCollection({
      id: 'agents',
      logicalId: 'agents',
      displayName: 'Agents',
      description: '',
      scope: 'global',
      collectionKind: 'agents',
    });
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
    agentsCollectionId: 'agents',
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

it('R19 first execute_step adopts destination', async () => {
  const emptyReq = { headers: {} } as unknown as Request;
  await createAgentMcpServerForRequest(emptyReq);
  const session = await opened();
  const result = await executeStep(emptyReq, caller, {
    session,
    destination: 'DEST',
    task: 'first',
  });
  expect(result.isError).not.toBe(true);
  expect(longSessions().get('alice', session)?.destination).toBe('DEST');
  expect(harness.establishCalls).toEqual(['DEST']);
});

async function directHandle() {
  const { getSmartAgent } = await import('../../srv/agent-manager');
  const handle = await getSmartAgent(undefined, 'DEST');
  const executor = { process: jest.fn(handle.agent.process) };
  const records = [
    {
      call: { id: '', name: 'CreateDomain', arguments: {} },
      result: { content: '{"success":true,"status":"inactive"}' },
    },
  ];
  const extras = {
    executor,
    criticLlm: { chat: jest.fn(), streamChat: async function* () {} },
    recMcp: {
      ...(handle as unknown as { recMcp: object }).recMcp,
      getToolRecords: jest.fn(() => records),
    },
  };
  Object.assign(handle, extras);
  return { handle, ...extras };
}

it('runs only the executor and passes its output through verbatim', async () => {
  const { handle, executor } = await directHandle();
  const coordinator = jest.spyOn(handle.agent, 'process');
  harness.process = async () => ({
    ok: true,
    value: { content: '  answer\n' },
  });
  try {
    const result = await executeStep(req, caller, { task: 'hello' });
    expect(result.content[0].text).toBe('  answer\n');
    expect(executor.process).toHaveBeenCalledTimes(1);
    expect(coordinator).not.toHaveBeenCalled();
  } finally {
    coordinator.mockRestore();
    Reflect.deleteProperty(handle, 'executor');
  }
});

it('appends the canonical notice for a deterministic contradiction', async () => {
  const { handle, recMcp, criticLlm } = await directHandle();
  const content = 'The domain was created and activated successfully.';
  harness.process = async () => ({ ok: true, value: { content } });
  const { evaluateDeterministic } = await import('../../srv/lib/reviewer-core');
  const { renderNotice } = await import('../../srv/lib/notify-policy');
  try {
    const result = await executeStep(req, caller, {
      task: 'create the domain',
    });
    expect(result.content[0].text).toBe(
      content +
        renderNotice(evaluateDeterministic(content, recMcp.getToolRecords())),
    );
    expect(recMcp.getToolRecords).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-step-/),
    );
    expect(criticLlm.chat).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(handle, 'executor');
  }
});

it('direct executor steps share each prior turn exactly once', async () => {
  const { handle, executor } = await directHandle();
  const session = await opened();
  try {
    await executeStep(req, caller, { session, task: 'first' });
    await executeStep(req, caller, { session, task: 'second' });
    expect(executor.process.mock.calls[1][0]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
    ]);
  } finally {
    Reflect.deleteProperty(handle, 'executor');
  }
});

it('falls back to the agent for an LLM-only handle', async () => {
  const { getSmartAgent } = await import('../../srv/agent-manager');
  const handle = await getSmartAgent(undefined, 'DEST');
  const process = jest.spyOn(handle.agent, 'process');
  try {
    const result = await executeStep(req, caller, { task: 'hello' });
    expect(result.content[0].text).toBe('done');
    expect(process).toHaveBeenCalledTimes(1);
  } finally {
    process.mockRestore();
  }
});

it('execute_step scopes the tool gate bypass to the executor call', async () => {
  const { isToolGateBypassed } = await import('../../srv/request-session');
  harness.process = async () => {
    expect(isToolGateBypassed()).toBe(true);
    return { ok: true, value: { content: 'done' } };
  };
  await executeStep(req, caller, {
    task: 'Read the class',
    destination: 'DEST',
  });
  expect(isToolGateBypassed()).toBe(false);
});

it('execute_step returns executor usage and ends with the footer with recording off', async () => {
  const previous = process.env.LLM_AGENT_USAGE;
  delete process.env.LLM_AGENT_USAGE;
  try {
    harness.process = async () => ({
      ok: true,
      value: {
        content: 'done',
        usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
      },
    });
    const result = await executeStep(req, caller, { task: 'work' });
    expect(result).toMatchObject({
      structuredContent: {
        result: 'done',
        usage: {
          prompt_tokens: 7,
          completion_tokens: 4,
          total_tokens: 11,
          duration_ms: expect.any(Number),
        },
      },
    });
    expect(result.content[0]?.text).toMatch(
      /^done\n\[usage\] prompt=7 completion=4 total=11 time=\d+\.\ds$/,
    );
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_USAGE;
    else process.env.LLM_AGENT_USAGE = previous;
  }
});

it.each([true, false])(
  'execute_step reports reviewer usage separately for verdict ok=%s',
  async (ok: boolean) => {
    const reviewer = await import('../../srv/lib/step-reviewer');
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    const review = jest.spyOn(reviewer, 'evaluateGated').mockResolvedValue(
      ok
        ? { ok: true, usage }
        : {
            ok: false,
            usage,
            issues: [
              {
                kind: 'unsupported-claim',
                confidence: 'high',
                reasons: 'test',
              },
            ],
          },
    );
    const { handle } = await directHandle();
    harness.process = async () => ({
      ok: true,
      value: {
        content: 'done',
        usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
      },
    });
    try {
      const result = await executeStep(req, caller, { task: 'work' });
      expect(result).toMatchObject({
        structuredContent: {
          result: ok ? 'done' : expect.stringContaining('UNVERIFIED_WRITE'),
          usage: {
            prompt_tokens: 7,
            completion_tokens: 4,
            total_tokens: 11,
            duration_ms: expect.any(Number),
          },
          usage_reviewer: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
          },
        },
      });
      expect(result.content[0]?.text).toMatch(
        /\[usage\] prompt=7 completion=4 total=11 reviewer=3 time=\d+\.\ds$/,
      );
      expect(review).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        structuredContent: {
          result: result.content[0]?.text?.split('\n[usage]')[0],
        },
      });
    } finally {
      review.mockRestore();
      Reflect.deleteProperty(handle, 'executor');
    }
  },
);

it.each(['', ' \n\t'])(
  'execute_step reports empty executor content %j with usage',
  async (content: string) => {
    harness.process = async () => ({
      ok: true,
      value: {
        content,
        iterations: 2,
        toolCallCount: 0,
        stopReason: 'stop',
        usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
      },
    });
    const result = await executeStep(req, caller, { task: 'work' });
    const text = result.content[0]?.text;
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^EMPTY_RESULT on destination "DEST":/);
    expect(text).toContain('executor finished without a reply');
    expect(text).toContain(
      'system state of the step is unknown and must be verified by a separate read step',
    );
    expect(text).toContain('iterations=2 toolCallCount=0 stopReason=stop');
    expect(text).toMatch(
      /\n\[usage\] prompt=7 completion=4 total=11 time=\d+\.\ds$/,
    );
    expect(result).toMatchObject({
      structuredContent: { result: text?.split('\n[usage]')[0] },
    });
  },
);

it('execute_step reports empty executor content without known usage', async () => {
  harness.process = async () => ({ ok: true, value: { content: '' } });
  const result = await executeStep(req, caller, { task: 'work' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toMatch(
    /^EMPTY_RESULT on destination "DEST":/,
  );
  expect(result.content[0]?.text).not.toContain('[usage]');
});

it('execute_step preserves HTTP arrival time while agent resolution waits', async () => {
  const request = new Proxy(req, {});
  const gate = deferred();
  harness.agentGate = gate.promise;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1793275200000);
  try {
    const done = executeStep(request, caller, { task: 'first' });
    clock.mockReturnValue(1793275260000);
    gate.resolve();
    await done;
    expect(harness.seenOptions).toHaveLength(1);
    expect(harness.seenOptions[0].requestStartedAt).toBe(1793275200000);
  } finally {
    gate.resolve();
    clock.mockRestore();
  }
});

test('MCP session_open selects own copy, preserves omission, rejects foreign and deleted copies', async () => {
  const registry = getCollectionRegistry();
  const own = userCollectionId('mcp-agents', 'alice');
  const foreign = userCollectionId('mcp-agents', 'bob');
  for (const [id, owner] of [
    [own, 'alice'],
    [foreign, 'bob'],
  ])
    await registry.createCollection({
      id,
      logicalId: 'mcp-agents',
      displayName: '',
      description: '',
      scope: 'user',
      owner,
      collectionKind: 'agents',
    });
  const wire = z.object({
    session: z.string(),
    agentsCollectionId: z.string(),
  });
  const opened = wire.parse(
    JSON.parse(
      (await call('session_open', { agentsCollectionId: own })).content[0].text,
    ),
  );
  expect(opened.agentsCollectionId).toBe(own);
  for (const agentsCollectionId of [foreign, 'missing']) {
    expect(
      (
        await call('session_open', {
          session: opened.session,
          agentsCollectionId,
        })
      ).isError,
    ).toBe(true);
    expect(
      longSessions().get('alice', opened.session)?.agentsCollectionId,
    ).toBe(own);
  }
  expect(
    wire.parse(
      JSON.parse(
        (await call('session_open', { session: opened.session })).content[0]
          .text,
      ),
    ).agentsCollectionId,
  ).toBe(own);
  await registry.deleteCollection(own);
  expect(
    (
      await call('session_open', {
        session: opened.session,
        agentsCollectionId: own,
      })
    ).isError,
  ).toBe(true);
  expect(longSessions().get('alice', opened.session)?.agentsCollectionId).toBe(
    own,
  );
});

test('execute_step ignores agents selection supplied as an extra execution field', async () => {
  const session = await opened();
  const input = { session, task: 'work', agentsCollectionId: 'missing' };
  const result = await executeStep(req, caller, input);
  expect(result.isError).not.toBe(true);
  expect(longSessions().get('alice', session)?.agentsCollectionId).toBe(
    'agents',
  );
});

it('agent MCP lists all 23 tools including orchestration', async () => {
  const { coordinatorToolsClient } = await import(
    '../../srv/lib/coordinator-tools-client'
  );
  const { DialogueRagMcpClient } = await import(
    '../../srv/lib/dialogue-rag-tools'
  );
  const internal = await new DialogueRagMcpClient(
    coordinatorToolsClient(coordinatorDependencies()),
  ).listTools();
  if (!internal.ok) throw new Error(internal.error.message);
  expect(internal.value.map((tool) => tool.name).sort()).toEqual(
    [...tools.keys(), 'deliver', 'new_request', 'search_knowledge']
      .filter((name) => name !== 'session_open' && name !== 'session_close')
      .sort(),
  );
  const { PlannerToolsClient } = await import('@mcp-abap-adt/llm-agent-libs');
  const library = await new PlannerToolsClient().listTools();
  if (!library.ok) throw new Error(library.error.message);
  const catalogue = await coordinatorToolsClient(
    coordinatorDependencies(),
  ).listTools();
  if (!catalogue.ok) throw new Error(catalogue.error.message);
  for (const tool of library.value)
    expect(catalogue.value).toContainEqual(tool);
  expect(tools.size).toBe(25);
  const {
    executeStepSchema,
    EXECUTE_STEP_DESCRIPTION,
    listDestinationsDefinition,
  } = await import('../../srv/lib/coordinator-tool-definitions');
  const { definitions } = jest.requireMock<{
    definitions: Map<string, { description: string; inputSchema: object }>;
  }>('@modelcontextprotocol/sdk/server/mcp.js');
  expect(definitions.get('execute_step')?.inputSchema).toBe(executeStepSchema);
  expect(definitions.get('list_destinations')).toBe(listDestinationsDefinition);
  expect(
    internal.value.find((tool) => tool.name === 'execute_step'),
  ).toMatchObject({
    description: EXECUTE_STEP_DESCRIPTION,
    inputSchema: z.toJSONSchema(z.object(executeStepSchema)),
  });
  expect(
    internal.value.find((tool) => tool.name === 'list_destinations'),
  ).toMatchObject({
    description: listDestinationsDefinition.description,
    inputSchema: z.toJSONSchema(
      z.object(listDestinationsDefinition.inputSchema),
    ),
  });
  for (const name of [
    'plan_create',
    'plan_revise',
    'plan_get',
    'plan_update',
    'delegate_task',
    'get_task',
    'list_tasks',
    'stop_task',
  ])
    expect(tools.has(name)).toBe(true);
});

it.each(['checker', 'writer'])(
  'execute_step resolves %s through the profile runner and enforces its grants',
  async (worker) => {
    const manager = jest.requireMock<typeof import('../../srv/agent-manager')>(
      '../../srv/agent-manager',
    );
    const { AgentProfileRunner } = await import(
      '../../srv/lib/agent-profile-runner'
    );
    const { profileToolAllowed } = await import('../../srv/request-session');
    const original = manager.getSmartAgent;
    const runner = new AgentProfileRunner({
      catalogue: () => [
        { name: 'read', effect: 'read' },
        { name: 'write', effect: 'write' },
      ],
      grants: () => new Set(['read']),
      buildPlanner: async () => {
        throw new Error('No coordinator turn expected');
      },
      buildWorker: async (profile) => ({
        name: profile.name,
        capabilities: { contextPolicy: 'optional' },
        run: async () => {
          if (profile.name === 'writer' && !profileToolAllowed('write'))
            throw new Error('Worker tool forbidden by caller grants');
          return { output: '{"verdict":"pass"}' };
        },
      }),
    });
    const spy = jest
      .spyOn(manager, 'getSmartAgent')
      .mockImplementation(async (...args) => ({
        ...(await original(...args)),
        profileRunner: runner,
      }));
    try {
      const result = await executeStep(req, caller, { task: 'Check', worker });
      const { coordinatorToolsClient } = await import(
        '../../srv/lib/coordinator-tools-client'
      );
      const { runWithSessionId } = await import('../../srv/request-session');
      const session = await opened();
      const internal = runWithSessionId(
        session,
        () =>
          coordinatorToolsClient(coordinatorDependencies()).callTool(
            'execute_step',
            {
              task: 'Check',
              worker,
            },
          ),
        undefined,
        'alice',
      );
      if (worker === 'checker') {
        await expect(internal).resolves.toMatchObject({
          ok: true,
          value: { content: '{"verdict":"pass"}' },
        });
      } else {
        await expect(internal).rejects.toThrow('forbidden by caller grants');
      }

      if (worker === 'checker') {
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('"verdict":"pass"');
      } else {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('forbidden by caller grants');
      }
    } finally {
      spy.mockRestore();
    }
  },
);

it('internal execute_step completes synchronously in the current session scope', async () => {
  const { coordinatorToolsClient } = await import(
    '../../srv/lib/coordinator-tools-client'
  );
  const { runWithSessionId, getRequestSessionId, getRequestUserId } =
    await import('../../srv/request-session');
  const manager = jest.requireMock<typeof import('../../srv/agent-manager')>(
    '../../srv/agent-manager',
  );
  const original = manager.getSmartAgent;
  const session = await opened();
  let finish = () => {};
  const spy = jest
    .spyOn(manager, 'getSmartAgent')
    .mockImplementation(async (...args) => ({
      ...(await original(...args)),
      executor: undefined,
      agent: Object.assign((await original(...args)).agent, {
        process: async () => {
          expect(getRequestSessionId()).toBe(session);
          expect(getRequestUserId()).toBe('alice');
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return {
            ok: true as const,
            value: {
              content: 'step done',
              iterations: 1,
              toolCallCount: 0,
              stopReason: 'stop' as const,
            },
          };
        },
      }),
    }));
  try {
    let settled = false;
    const call = runWithSessionId(
      session,
      () =>
        coordinatorToolsClient(coordinatorDependencies())
          .callTool('execute_step', { task: 'Read' })
          .then((result) => {
            settled = true;
            return result;
          }),
      undefined,
      'alice',
    );
    for (let i = 0; i < 30 && spy.mock.calls.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await call).toMatchObject({
      ok: true,
      value: { content: 'step done', isError: false },
    });
  } finally {
    finish();
    spy.mockRestore();
  }
});

function coordinatorDependencies() {
  const manager = jest.requireMock<typeof import('../../srv/agent-manager')>(
    '../../srv/agent-manager',
  );
  const { runExecutorStep } = jest.requireActual<
    typeof import('../../srv/lib/executor-step')
  >('../../srv/lib/executor-step');
  return {
    wrapRun: <T extends { ok: boolean }>(
      run: (signal: AbortSignal | undefined) => Promise<T>,
    ) => run(undefined),
    getSmartAgent: manager.getSmartAgent,
    runExecutorStep: (
      ...args: Parameters<
        typeof import('../../srv/agent-manager').runExecutorStep
      >
    ) => runExecutorStep(manager.createAgentProfileSource, ...args),
  };
}
