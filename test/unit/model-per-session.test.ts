import { createServer } from 'node:http';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '@mcp-abap-adt/llm-agent-libs';
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
jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: async (config: HubLlmConfig): Promise<ILlm> => ({
    model: config.model,
    chat: async () => {
      mockCalls.push(config.model ?? '');
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        ok: true,
        value: { content: config.model ?? 'Done', finishReason: 'stop' },
      };
    },
    streamChat: async function* () {
      mockCalls.push(config.model ?? '');
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

const saved = { ...process.env };
beforeAll(async () => {
  process.env.LLM_AGENT_PROVIDER = 'openai';
  process.env.LLM_AGENT_MODEL = 'worker-default';
  process.env.LLM_AGENT_MODELS = 'A,B';
  clearAgentConfig();
  initProviders(await startProviders(getAgentConfig()));
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
      const store = new MemoryDialogueStore();
      return DialogueSession.open({
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
  await worker.run({ task: 'Answer briefly' });
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
    await runExecutorStep(
      () => source,
      handle,
      'reader',
      'Read',
      'executor',
      {},
    );
    await runExecutorStep(
      () => source,
      handle,
      'reader',
      'Read',
      'executor',
      {},
      [],
      undefined,
      'A',
    );
    await runExecutorStep(
      () => source,
      handle,
      'reader',
      'Read',
      'executor',
      {},
    );
    await expect(
      runExecutorStep(
        () => source,
        handle,
        'reader',
        'Read',
        'executor',
        {},
        [],
        undefined,
        'foreign',
      ),
    ).rejects.toThrow('MODEL_NOT_ALLOWED');
    expect(seen).toEqual(['B', 'A', 'B']);
  } finally {
    await registry.updateDocument('agents', 'executor', {
      metadata: record.metadata,
    });
  }
  await runExecutorStep(() => source, handle, 'reader', 'Read', 'executor', {});
  expect(seen.at(-1)).toBe('worker-default');
});

test.each([false, true])(
  'destination requests isolate models (stream=%s)',
  async (stream) => {
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
      { ...config, agent: { ...config.agent, chatCoordinator: 'fixed' } },
    );
    const agents = [
      withRequestModel(base.agent, 'A'),
      withRequestModel(base.agent, 'B'),
      base.agent,
    ];
    mockCalls.length = 0;
    await Promise.all(
      agents.map(async (agent, index) => {
        const options = { sessionId: `request-${stream}-${index}` };
        if (stream) {
          for await (const result of agent.streamProcess('Hello', options)) {
            expect(result.ok).toBe(true);
          }
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
    mockCalls.length = 0;
    await base.agent.process('Hello again');
    expect(mockCalls).toContain('worker-default');
    expect(mockCalls).not.toContain('A');
    expect(mockCalls).not.toContain('B');
  },
);
