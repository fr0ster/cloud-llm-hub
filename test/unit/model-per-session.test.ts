import { bindTestCaller } from './helpers/bind-test-caller';

const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

import { createServer } from 'node:http';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  unwrapBuilderResult,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import express from 'express';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { AgentProfileRunner } from '../../srv/lib/agent-profile-runner';
import { AgentProfileSource } from '../../srv/lib/agent-profile-source';
import { withCoordinatorModel } from '../../srv/lib/coordinator-model';
import { MemoryDialogueStore } from '../../srv/lib/dialogue-store';
import { runExecutorStep } from '../../srv/lib/executor-step';
import type { HubLlmConfig } from '../../srv/lib/llm-factory';
import { handleChatCompletions, handleModels } from '../../srv/openai-handler';

const mockCalls: string[] = [];
const mockOfferedTools: string[][] = [];
let mockLoop = false;
let mockRolePlan = false;
// Model selection does not exercise discovery. Do not leave startup retry
// timers making BTP requests after this suite has finished.
jest.mock('../../srv/lib/destination-watch', () => ({
  watchDestinations: () => () => {},
}));
jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: async (config: HubLlmConfig): Promise<ILlm> => ({
    model: config.model,
    chat: async (messages, tools) => {
      if (
        messages.some((message) =>
          message.content?.includes('Classify the last user request'),
        )
      )
        return {
          ok: true,
          value: {
            content: '{"action":false,"language":"uk"}',
            finishReason: 'stop',
          },
        };
      mockOfferedTools.push((tools ?? []).map((tool) => tool.name));
      mockCalls.push(config.model ?? '');
      if (mockLoop)
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { id: String(mockCalls.length), name: 'tick', arguments: {} },
            ],
            finishReason: 'tool_calls',
          },
        };
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        ok: true,
        value: {
          content: messages.some(
            (message) =>
              message.role === 'system' &&
              message.content?.includes('sequential adaptive plan'),
          )
            ? JSON.stringify({
                steps: mockRolePlan
                  ? [
                      {
                        id: 'exec',
                        kind: 'work',
                        goal: 'Answer',
                        worker: 'executor',
                      },
                      {
                        id: 'check',
                        kind: 'work',
                        goal: 'Review',
                        worker: 'checker',
                      },
                      { id: 'answer', kind: 'answer', from: 'exec' },
                    ]
                  : [{ id: 'answer', kind: 'answer', text: config.model }],
              })
            : (config.model ?? 'Done'),
          finishReason: 'stop',
        },
      };
    },
    streamChat: async function* (_messages, tools) {
      mockOfferedTools.push((tools ?? []).map((tool) => tool.name));
      mockCalls.push(config.model ?? '');
      if (mockLoop) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { id: String(mockCalls.length), name: 'tick', arguments: {} },
            ],
            finishReason: 'tool_calls',
          },
        };
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      yield {
        ok: true,
        value: { content: config.model ?? 'Done', finishReason: 'stop' },
      };
    },
  }),
}));

import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { clearAgentConfig, getAgentConfig } from '../../srv/agent-config';
import {
  buildAgentForDestination,
  buildExecutorWorker,
  buildLlmOnlyAgent,
  buildPlannerAgent,
  closeSmartAgent,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getCurrentModel,
  initProviders,
  initSmartAgents,
  withRequestModel,
} from '../../srv/agent-manager';
import { startProviders } from '../../srv/lib/providers';
import {
  buildRagToolSchemas,
  ragToolEffect,
} from '../../srv/lib/rag-tool-catalogue';

test.each(['smart', 'hard', 'pass'] as const)(
  'LLM-only offers read tools to the main LLM in %s mode',
  async (mode) => {
    const config = getAgentConfig();
    const handle = await buildLlmOnlyAgent(
      { ...config, agent: { ...config.agent, mode } },
      'waiting',
    );
    mockOfferedTools.length = 0;
    await handle.agent.process('Що в моїй колекції про ZMTO28?', {
      caller: taskCaller,
      sessionId: taskCaller.sessionId,
    });
    expect(mockOfferedTools).toHaveLength(1);
    expect(mockOfferedTools[0].sort()).toEqual(
      buildRagToolSchemas(false)
        .map(({ function: tool }) => tool.name)
        .filter((name) => ragToolEffect(name) === 'read')
        .sort(),
    );
  },
);

const saved = { ...process.env };
beforeAll(async () => {
  process.env.LLM_AGENT_PROVIDER = 'openai';
  process.env.LLM_AGENT_MODEL = 'worker-default';
  process.env.LLM_AGENT_MODELS = 'A,B';
  clearAgentConfig();
  initProviders(await startProviders(getAgentConfig()));
  await bindTestCaller(taskCaller);
  await getCollectionRegistry().seedAgentConfiguration('agents', 'coordinator');
  await initSmartAgents();
});
afterAll(async () => {
  await closeSmartAgent();
  process.env = saved;
  clearAgentConfig();
});

test('concurrent coordinators keep their models while executor keeps the deploy default', async () => {
  const config = getAgentConfig();
  const [a, b] = await Promise.all(
    ['A', 'B'].map((model) =>
      buildPlannerAgent(
        { ...config, llm: { ...config.llm, coordinatorModel: model } },
        'Answer briefly',
      ),
    ),
  );
  const source = new AgentProfileSource(getCollectionRegistry(), {
    userId: 'reader',
    globalCollectionId: 'agents',
    selectedCollectionId: () => 'agents',
    plannerRecord: 'coordinator',
    timeoutMs: 3000,
  });
  const sessions = await Promise.all(
    [a, b].map(async (agent, index) => {
      const caller = { ...taskCaller, sessionId: `session-${index}` };
      await bindTestCaller(caller);
      const store = new MemoryDialogueStore();
      return DialogueSession.open({
        caller,
        id: `session-${index}`,
        board: {},
        store: {
          load: (id) => store.load('reader', id),
          save: (id, state) => store.save('reader', id, state),
          delete: (id) => store.delete('reader', id),
        },
        profileSource: source,
        profileRunner: new AgentProfileRunner({
          catalogue: () => [],
          grants: () => new Set(),
          buildPlanner: async () => agent,
          buildWorker: async () => {
            throw new Error('No delegation expected');
          },
        }),
      });
    }),
  );
  await Promise.all(sessions.map((session) => session.send('Hello')));
  expect(mockCalls).toEqual(expect.arrayContaining(['A', 'B']));
  const worker = await buildExecutorWorker(
    {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => ({ ok: true, value: { content: '' } }),
    },
    new ExpositionFilteringRag(new InMemoryRag()),
    config,
  );
  await worker.run({ caller: taskCaller, task: 'Answer briefly' });
  expect(mockCalls.at(-1)).toBe('worker-default');
  await sessions[0].send('Again');
  expect(mockCalls.at(-1)).toBe('A');
  expect(getCurrentModel()).toBe('worker-default');
  await Promise.all(sessions.map((session) => session.close()));
});

test('foreign OpenAI and Anthropic ids are ignored with a header and models metadata stays fixed', async () => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', handleChatCompletions);
  app.post('/v1/messages', handleAnthropicMessages);
  app.get('/v1/models', handleModels);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      for (const model of [
        'claude-sonnet-4',
        'bad\r\nmodel',
        '????' + 'x'.repeat(200),
      ]) {
        const response = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        });
        const text = await response.text();
        if (!response.headers.get('x-clh-model-ignored'))
          throw new Error(`${path} ${response.status}: ${text}`);
        expect(response.headers.get('x-clh-model-ignored')).toBe(
          model === 'claude-sonnet-4'
            ? model
            : model === 'bad\r\nmodel'
              ? 'badmodel'
              : '????' + 'x'.repeat(124),
        );
      }
    }
    const selected = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'B',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    await selected.text();
    const models = await fetch(`${base}/v1/models`);
    expect(await models.json()).toMatchObject({
      _active_model: 'worker-default',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('execute_step uses executor profile default, main fallback, and a call-only override', async () => {
  const registry = getCollectionRegistry();
  const source = new AgentProfileSource(registry, {
    userId: 'reader',
    globalCollectionId: 'agents',
    selectedCollectionId: () => 'agents',
    plannerRecord: 'coordinator',
    timeoutMs: 3000,
  });
  const base = await buildLlmOnlyAgent(getAgentConfig(), 'waiting');
  let executor = base.agent;
  await buildExecutorWorker(
    {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => ({ ok: true, value: { content: '' } }),
    },
    new ExpositionFilteringRag(new InMemoryRag()),
    getAgentConfig(),
    (agent) => {
      executor = agent;
    },
  );
  const handle = { ...base, agent: executor };
  const seen = mockCalls;
  seen.length = 0;
  const record = await registry.getDocument('agents', 'executor');
  if (!record) throw new Error('Missing executor');
  await registry.updateDocument('agents', 'executor', {
    metadata: { ...record.metadata, model: 'B' },
  });
  try {
    await runExecutorStep(() => source, handle, 'reader', 'Read', 'executor', {
      caller: taskCaller,
      sessionId: taskCaller.sessionId,
    });
    await runExecutorStep(
      () => source,
      handle,
      'reader',
      'Read',
      'executor',
      { caller: taskCaller, sessionId: taskCaller.sessionId },
      [],
      'A',
    );
    await runExecutorStep(() => source, handle, 'reader', 'Read', 'executor', {
      caller: taskCaller,
      sessionId: taskCaller.sessionId,
    });
    await expect(
      runExecutorStep(
        () => source,
        handle,
        'reader',
        'Read',
        'executor',
        { caller: taskCaller, sessionId: taskCaller.sessionId },
        [],
        'foreign',
      ),
    ).rejects.toThrow('MODEL_NOT_ALLOWED');
    expect(seen).toEqual(['B', 'A', 'B']);
  } finally {
    await registry.updateDocument('agents', 'executor', {
      metadata: record.metadata,
    });
  }
  await runExecutorStep(() => source, handle, 'reader', 'Read', 'executor', {
    caller: taskCaller,
    sessionId: taskCaller.sessionId,
  });
  expect(seen.at(-1)).toBe('worker-default');
});

test.each(
  (['fixed', 'adaptive'] as const).flatMap((coordinator) =>
    [false, true].map((stream) => ({ coordinator, stream })),
  ),
)(
  'destination requests isolate models (coordinator=$coordinator, stream=$stream)',
  async ({ coordinator, stream }) => {
    const config = getAgentConfig();
    const adapter = new McpClientAdapter(
      new MCPClientWrapper({ transport: 'embedded' }),
    );
    jest.spyOn(adapter, 'listTools').mockResolvedValue({ ok: true, value: [] });
    jest
      .spyOn(adapter, 'healthCheck')
      .mockResolvedValue({ ok: true, value: true });
    const base = await buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      { ...config, agent: { ...config.agent, chatCoordinator: coordinator } },
    );
    const agents = [
      withRequestModel(base.agent, 'A'),
      withRequestModel(base.agent, 'B'),
      base.agent,
    ];
    mockCalls.length = 0;
    await Promise.all(
      agents.map(async (agent, index) => {
        const options = {
          ...(await bindTestCaller({
            ...taskCaller,
            sessionId: `request-${coordinator}-${stream}-${index}`,
          })),
        };
        if (stream) {
          const chunks: string[] = [];
          for await (const result of agent.streamProcess('Hello', options)) {
            expect(result.ok).toBe(true);
            if (result.ok) chunks.push(result.value.content);
          }
          expect(chunks.join('')).toContain(
            ['A', 'B', 'worker-default'][index],
          );
        } else {
          const result = await agent.process('Hello', options);
          expect(result.ok).toBe(true);
          if (result.ok)
            expect(result.value.content).toContain(
              ['A', 'B', 'worker-default'][index],
            );
        }
      }),
    );
    expect(mockCalls).toEqual(
      expect.arrayContaining(['A', 'B', 'worker-default']),
    );
    if (coordinator === 'adaptive') expect(mockCalls).toHaveLength(3);
    mockCalls.length = 0;
    await base.agent.process('Hello again', {
      caller: taskCaller,
      sessionId: taskCaller.sessionId,
    });
    expect(mockCalls).toContain('worker-default');
    expect(mockCalls).not.toContain('A');
    expect(mockCalls).not.toContain('B');
  },
);

test('the plan author runs on the user planner model, else LLM_AGENT_PLANNER_MODEL, else the deploy model', async () => {
  const { withRoleModels } = await import('../../srv/lib/role-models-scope');
  for (const plannerModel of [undefined, 'B']) {
    const config = getAgentConfig();
    const adapter = new McpClientAdapter(
      new MCPClientWrapper({ transport: 'embedded' }),
    );
    jest.spyOn(adapter, 'listTools').mockResolvedValue({ ok: true, value: [] });
    jest
      .spyOn(adapter, 'healthCheck')
      .mockResolvedValue({ ok: true, value: true });
    const handle = await buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      {
        ...config,
        llm: { ...config.llm, plannerModel },
      },
    );
    for (const model of ['A', undefined]) {
      await withRoleModels(model ? { planner: { model } } : {}, async () => {
        const prepared = await handle.profileRunner.preparePlanAuthor({
          systemPrompt: 'Answer briefly',
          mode: 'create',
        });
        if (!prepared.ok) throw new Error(prepared.error.message);
        await prepared.value.process('Hello', {
          caller: taskCaller,
          sessionId: taskCaller.sessionId,
        });
        expect(mockCalls.at(-1)).toBe(
          model ?? plannerModel ?? 'worker-default',
        );
      });
    }
  }
});

test('shared destination executor applies scoped model and maxIterations without leaking to another session', async () => {
  const { withRoleModels } = await import('../../srv/lib/role-models-scope');
  const { withExecutionLimits } = await import(
    '../../srv/lib/execution-limits'
  );
  const config = getAgentConfig();
  const adapter = new McpClientAdapter(
    new MCPClientWrapper({ transport: 'embedded' }),
  );
  jest.spyOn(adapter, 'listTools').mockResolvedValue({
    ok: true,
    value: [
      {
        name: 'tick',
        description: 'Read',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  });
  jest
    .spyOn(adapter, 'callTool')
    .mockResolvedValue({ ok: true, value: { content: 'tick' } });
  jest
    .spyOn(adapter, 'healthCheck')
    .mockResolvedValue({ ok: true, value: true });
  const shared = await withExecutionLimits({}, () =>
    buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      config,
    ),
  );
  const source = new AgentProfileSource(getCollectionRegistry(), {
    userId: 'reader',
    globalCollectionId: 'agents',
    selectedCollectionId: () => 'agents',
    plannerRecord: 'coordinator',
  });
  mockLoop = true;
  try {
    mockCalls.length = 0;
    await withRoleModels(
      { executor: { model: 'A' } },
      () =>
        runExecutorStep(() => source, shared, 'reader', 'Run', 'executor', {
          caller: taskCaller,
          sessionId: taskCaller.sessionId,
        }),
      { executor: { maxIterations: 3, maxToolCalls: 'off' } },
    );
    expect(mockCalls).toEqual(['A', 'A', 'A']);
    mockCalls.length = 0;
    await withRoleModels({}, () =>
      runExecutorStep(() => source, shared, 'reader', 'Run', 'executor', {
        caller: taskCaller,
        sessionId: taskCaller.sessionId,
      }),
    );
    expect(mockCalls).toHaveLength(10);
    expect(new Set(mockCalls)).toEqual(new Set(['worker-default']));
  } finally {
    mockLoop = false;
  }
});

test.each(['/v1/chat/completions', '/v1/messages'])(
  '%s clears a coordinator header without persisting it as the request model',
  async (path) => {
    const cds = (await import('@sap/cds')).default;
    const manager = await import('../../srv/agent-manager');
    const connections = await import('../../srv/lib/request-connection');
    const { closeDialogue } = await import('../../srv/lib/dialogue-sessions');
    const { getDialogueStoreBackend } = await import(
      '../../srv/lib/dialogue-store'
    );
    const { LongSessionRegistry, setLongSessionsForTest } = await import(
      '../../srv/lib/long-session'
    );
    const config = getAgentConfig();
    const adapter = new McpClientAdapter(
      new MCPClientWrapper({ transport: 'embedded' }),
    );
    jest.spyOn(adapter, 'listTools').mockResolvedValue({ ok: true, value: [] });
    jest
      .spyOn(adapter, 'healthCheck')
      .mockResolvedValue({ ok: true, value: true });
    const handle = await buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      config,
    );
    const resolver = await import('../../srv/connections/destinationResolver');
    const destination = jest
      .spyOn(resolver, 'resolveDestinationSapConfig')
      .mockResolvedValue({
        destinationName: 'TEST',
        sapConfig: { url: 'https://test.invalid', authType: 'basic' },
        authenticationType: 'BasicAuthentication',
      });
    const smart = jest
      .spyOn(manager, 'getSmartAgent')
      .mockResolvedValue(handle);
    const connection = jest
      .spyOn(connections, 'establishRequestConnection')
      .mockResolvedValue({ handled: false, credential: { kind: 'none' } });
    let registry = new LongSessionRegistry(
      { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
      { onClose: async () => {} },
    );
    const opened = registry.open('role-http', {
      key: path,
      destination: 'TEST',
    });
    if ('refused' in opened) throw new Error(opened.refused);
    let session = opened;
    setLongSessionsForTest(registry);
    process.env.LLM_AGENT_CHAT_COORDINATOR = 'dialogue';
    clearAgentConfig();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const context = new cds.EventContext({ event: 'chat' });
      context.user = new cds.User({
        id: 'role-http',
        attr: {},
        roles: ['MCP_Admin', 'MCP_Reader'],
      });
      cds.context = context;
      Object.assign(req, { longSession: session, sessionId: session.key });
      next();
    });
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/messages', handleAnthropicMessages);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const chat = async (headers: Record<string, string>, model?: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-clh-session': path,
          ...headers,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      const text = await response.text();
      if (response.status !== 200)
        throw new Error(`${path}: ${response.status}: ${text}`);
      return text;
    };
    try {
      expect(await chat({}, 'A')).toContain('A');
      expect(await chat({ 'x-clh-model-coordinator': 'B' })).toContain('B');
      expect(
        (await getDialogueStoreBackend().load('role-http', path))
          ?.coordinatorModel,
      ).toBe('A');
      expect(await chat({ 'x-clh-model-coordinator': 'auto' })).toContain('A');
      expect(await chat({})).toContain('A');
      await closeDialogue('role-http', path, 'shutdown', false);
      await registry.closeAll('shutdown');
      registry = new LongSessionRegistry(
        { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
        { onClose: async () => {} },
      );
      const reopened = registry.open('role-http', {
        key: path,
        destination: 'TEST',
      });
      if ('refused' in reopened) throw new Error(reopened.refused);
      session = reopened;
      setLongSessionsForTest(registry);
      expect(await chat({})).toContain('A');
      expect(
        (await getDialogueStoreBackend().load('role-http', path))
          ?.coordinatorModel,
      ).toBe('A');
    } finally {
      await closeDialogue('role-http', path, 'explicit');
      await registry.closeAll('shutdown');
      setLongSessionsForTest(undefined);
      smart.mockRestore();
      connection.mockRestore();
      destination.mockRestore();
      delete process.env.LLM_AGENT_CHAT_COORDINATOR;
      clearAgentConfig();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test.each(['coordinator', 'planner'] as const)(
  '%s visibly refuses a session model removed after a successful build',
  async (role) => {
    const { withRoleModels } = await import('../../srv/lib/role-models-scope');
    const adapter = new McpClientAdapter(
      new MCPClientWrapper({ transport: 'embedded' }),
    );
    jest.spyOn(adapter, 'listTools').mockResolvedValue({ ok: true, value: [] });
    jest
      .spyOn(adapter, 'healthCheck')
      .mockResolvedValue({ ok: true, value: true });
    const handle = await buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      getAgentConfig(),
    );
    await withRoleModels({ [role]: { model: 'A' } }, async () => {
      const input = { systemPrompt: 'Answer', mode: 'create' as const };
      const prepare = () =>
        role === 'planner'
          ? handle.profileRunner.preparePlanAuthor(input)
          : handle.profileRunner.preparePlanner(input);
      expect((await prepare()).ok).toBe(true);
      const previous = process.env.LLM_AGENT_MODELS;
      process.env.LLM_AGENT_MODELS = 'B';
      mockCalls.length = 0;
      try {
        expect(await prepare()).toMatchObject({
          ok: false,
          error: {
            code: 'MODEL_NOT_ALLOWED',
            message: expect.stringContaining(`${role}.model`),
          },
        });
        expect(mockCalls).toEqual([]);
      } finally {
        process.env.LLM_AGENT_MODELS = previous;
      }
    });
  },
);

test.each(
  ['/v1/chat/completions', '/v1/messages'].flatMap((path) =>
    [false, true].map((stream) => ({ path, stream })),
  ),
)(
  'LLM-only HTTP builds use session limits and restore defaults ($path, stream=$stream)',
  async ({ path, stream }) => {
    const cds = (await import('@sap/cds')).default;
    const { SmartAgentBuilder } = await import('@mcp-abap-adt/llm-agent-libs');
    const { LongSessionRegistry, setLongSessionsForTest } = await import(
      '../../srv/lib/long-session'
    );
    const { clearRoleModels } = await import(
      '../../srv/lib/role-model-settings'
    );
    const { clearExecutionLimits } = await import(
      '../../srv/lib/execution-limits'
    );
    const registry = new LongSessionRegistry(
      { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
      { onClose: async () => {} },
    );
    setLongSessionsForTest(registry);
    const first = registry.open('llm-http', { key: 'ls-llm-configured' });
    const second = registry.open('llm-http', { key: 'ls-llm-default' });
    if ('refused' in first || 'refused' in second)
      throw new Error('Cannot open sessions');
    const builds: { iterations: number; calls?: number; history: boolean }[] =
      [];
    const original = SmartAgentBuilder.prototype.build;
    const build = jest
      .spyOn(SmartAgentBuilder.prototype, 'build')
      .mockImplementation(async function (
        this: InstanceType<typeof SmartAgentBuilder>,
      ) {
        const result = await original.call(this);
        const handle = unwrapBuilderResult(result);
        const config = handle.agent.getAgentConfig();
        builds.push({
          iterations: config.maxIterations,
          calls: config.maxToolCalls,
          history: handle.agent['deps'].sessionManager !== undefined,
        });
        return result;
      });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const context = new cds.EventContext({ event: 'chat' });
      context.user = new cds.User({
        id: 'llm-http',
        attr: {},
        roles: ['MCP_Admin'],
      });
      cds.context = context;
      const session =
        req.headers['x-clh-session'] === 'ls-llm-configured' ? first : second;
      Object.assign(req, { longSession: session, sessionId: session.key });
      next();
    });
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/messages', handleAnthropicMessages);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    try {
      for (const key of [
        'ls-llm-configured',
        'ls-llm-configured',
        'ls-llm-default',
      ]) {
        builds.length = 0;
        const response = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-clh-session': key,
              ...(key === 'ls-llm-configured'
                ? {
                    'x-clh-model-coordinator': 'A',
                    'x-clh-limits': JSON.stringify({
                      coordinator: { maxIterations: 3, maxToolCalls: 'off' },
                      historyTokenBudget: 'off',
                    }),
                  }
                : {}),
            },
            body: JSON.stringify({
              model: 'A',
              stream,
              messages: [{ role: 'user', content: 'Hello' }],
            }),
          },
        );
        await response.text();
        expect(response.status).toBe(200);
        expect(builds.length).toBeGreaterThan(0);
        for (const built of builds)
          expect(built).toEqual(
            key === 'ls-llm-configured'
              ? { iterations: 3, calls: undefined, history: false }
              : {
                  iterations: getAgentConfig().agent.maxIterations,
                  calls: 30,
                  history: true,
                },
          );
      }
      const allowlist = process.env.LLM_AGENT_MODELS;
      process.env.LLM_AGENT_MODELS = 'B';
      builds.length = 0;
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-clh-session': 'ls-llm-configured',
            },
            body: JSON.stringify({
              stream,
              messages: [{ role: 'user', content: 'Hello again' }],
            }),
          },
        );
        expect(await response.text()).toContain('coordinator.model');
        expect(builds).toEqual([]);
      } finally {
        process.env.LLM_AGENT_MODELS = allowlist;
      }
    } finally {
      build.mockRestore();
      for (const key of ['ls-llm-configured', 'ls-llm-default']) {
        clearRoleModels('llm-http', key);
        clearExecutionLimits('llm-http', key);
      }
      await registry.closeAll('shutdown');
      setLongSessionsForTest(undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test.each(
  (['fixed', 'adaptive'] as const).flatMap((mode) =>
    ['/v1/chat/completions', '/v1/messages'].flatMap((path) =>
      [false, true].map((stream) => ({ mode, path, stream })),
    ),
  ),
)(
  'HTTP worker role models persist and isolate ($mode, $path, stream=$stream)',
  async ({ mode, path, stream }) => {
    const cds = (await import('@sap/cds')).default;
    const manager = await import('../../srv/agent-manager');
    const connections = await import('../../srv/lib/request-connection');
    const resolver = await import('../../srv/connections/destinationResolver');
    const { LongSessionRegistry, setLongSessionsForTest } = await import(
      '../../srv/lib/long-session'
    );
    const { clearRoleModels } = await import(
      '../../srv/lib/role-model-settings'
    );
    const savedEnv = { ...process.env };
    process.env.LLM_AGENT_CHAT_COORDINATOR = mode;
    clearAgentConfig();
    const adapter = new McpClientAdapter(
      new MCPClientWrapper({ transport: 'embedded' }),
    );
    jest.spyOn(adapter, 'listTools').mockResolvedValue({ ok: true, value: [] });
    jest
      .spyOn(adapter, 'healthCheck')
      .mockResolvedValue({ ok: true, value: true });
    const handle = await buildAgentForDestination(
      adapter,
      new ExpositionFilteringRag(new InMemoryRag()),
      getAgentConfig(),
    );
    const smart = jest
      .spyOn(manager, 'getSmartAgent')
      .mockResolvedValue(handle);
    const connection = jest
      .spyOn(connections, 'establishRequestConnection')
      .mockResolvedValue({ handled: false, credential: { kind: 'none' } });
    const destination = jest
      .spyOn(resolver, 'resolveDestinationSapConfig')
      .mockResolvedValue({
        destinationName: 'TEST',
        sapConfig: { url: 'https://test.invalid', authType: 'basic' },
        authenticationType: 'BasicAuthentication',
      });
    const registry = new LongSessionRegistry(
      { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
      { onClose: async () => {} },
    );
    const configured = registry.open('worker-http', {
      key: 'configured',
    });
    const defaults = registry.open('worker-http', {
      key: 'default',
    });
    if ('refused' in configured || 'refused' in defaults)
      throw new Error('Cannot open sessions');
    setLongSessionsForTest(registry);
    const failures: { code: string; message: string }[] = [];
    const createWorker = AgentProfileRunner.prototype.createWorker;
    const workers = jest
      .spyOn(AgentProfileRunner.prototype, 'createWorker')
      .mockImplementation(async function (
        this: AgentProfileRunner,
        ...args: Parameters<AgentProfileRunner['createWorker']>
      ) {
        const result = await createWorker.apply(this, args);
        if (!result.ok) failures.push(result.error);
        return result;
      });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const context = new cds.EventContext({ event: 'chat' });
      context.user = new cds.User({
        id: 'worker-http',
        attr: {},
        roles: ['MCP_Admin', 'MCP_Reader'],
      });
      cds.context = context;
      const session =
        req.headers['x-clh-session'] === 'configured' ? configured : defaults;
      Object.assign(req, { longSession: session, sessionId: session.key });
      next();
    });
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/messages', handleAnthropicMessages);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const chat = async (key: string, headers: Record<string, string> = {}) => {
      mockCalls.length = 0;
      failures.length = 0;
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-clh-session': key,
          ...headers,
        },
        body: JSON.stringify({
          model: 'worker-default',
          stream,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      return { status: response.status, text: await response.text() };
    };
    mockRolePlan = true;
    try {
      const updates: Record<string, string>[] = [
        { 'x-clh-model-executor': 'A', 'x-clh-model-checker': 'B' },
        {},
      ];
      for (const headers of updates) {
        expect((await chat('configured', headers)).status).toBe(200);
        expect(mockCalls).toContain('A');
        if (mode === 'adaptive') expect(mockCalls).toContain('B');
      }
      expect((await chat('default')).status).toBe(200);
      expect(new Set(mockCalls)).toEqual(new Set(['worker-default']));
      process.env.LLM_AGENT_MODELS = 'B';
      await chat('configured');
      expect(failures).toContainEqual({
        code: 'MODEL_NOT_ALLOWED',
        message: expect.stringContaining('executor.model'),
      });
      expect(mockCalls).not.toContain('A');
      if (mode === 'adaptive') {
        process.env.LLM_AGENT_MODELS = 'A';
        await chat('configured');
        expect(failures).toContainEqual({
          code: 'MODEL_NOT_ALLOWED',
          message: expect.stringContaining('checker.model'),
        });
        expect(mockCalls).not.toContain('B');
      }
    } finally {
      mockRolePlan = false;
      workers.mockRestore();
      smart.mockRestore();
      connection.mockRestore();
      destination.mockRestore();
      clearRoleModels('worker-http', 'configured');
      clearRoleModels('worker-http', 'default');
      await registry.closeAll('shutdown');
      setLongSessionsForTest(undefined);
      process.env = savedEnv;
      clearAgentConfig();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
