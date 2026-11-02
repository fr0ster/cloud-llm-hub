import {
  type ILlm,
  type IMcpClient,
  InMemoryRag,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type { AgentConfig } from '../../srv/agent-config';
import * as agentConfig from '../../srv/agent-config';
import {
  buildAgentForDestination,
  buildPlannerAgent,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getSmartAgent,
  initProviders,
  releasePlannerAgent,
} from '../../srv/agent-manager';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import {
  profileToolAllowed,
  runWithProfileTools,
  runWithSessionId,
} from '../../srv/request-session';
import { liveSession } from './helpers/canonical-rag';

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(),
}));
const config: AgentConfig = {
  trust: {
    defaults: { global: 4.5, system: 4.5, docs: 3.5, user: 3, session: 2 },
  },
  llm: {
    provider: 'openai',
    model: 'test',
    classifierModel: 'test',
    temperature: 0,
    maxTokens: 2000,
    apiKey: 'fake',
    baseUrl: 'http://localhost',
    whenThrottled: new WaitIfShortEnough(20_000),
  },
  mcp: { destination: '', systemDestinations: {} },
  agent: {
    dialogue: {
      executors: 7,
      executorPool: 6,
      maxTasks: 50,
      maxCorrections: 2,
      followMaxMs: 1_800_000,
    },
    chatCoordinator: 'adaptive',
    mode: 'smart',
    maxIterations: 10,
    ragType: 'in-memory',
    ragQueryK: 5,
    skillRagK: 0,
    allowLlmOnlyFallback: false,
  },
  rag: {
    embedder: null,
    backends: {
      tools: 'in-memory',
      session: 'in-memory',
      persistent: 'in-memory',
    },
  },
  destinations: { source: 'btp' },
};

const readTools = [
  'rag_search',
  'rag_read',
  'collection_records',
  'collections_list',
];
const offered: string[][] = [];
const model: ILlm = {
  model: 'planner-test',
  chat: async (_messages, tools) => {
    offered.push((tools ?? []).map((tool) => tool.name));
    return { ok: true, value: { content: 'ready', finishReason: 'stop' } };
  },
  streamChat: async function* (_messages, tools) {
    offered.push((tools ?? []).map((tool) => tool.name));
    yield {
      ok: true as const,
      value: { content: 'ready', finishReason: 'stop' as const },
    };
  },
};

beforeAll(async () => {
  jest.mocked(makeHubLlm).mockResolvedValue(model);
  initProviders(await startProviders(config));
});

test('destination author offers exactly four canonical read tools and inherits caller ceilings', async () => {
  const client = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () => [],
    callToolHandler: async () => ({ content: [] }),
  });
  await client.connect();
  const handle = await buildAgentForDestination(
    new McpClientAdapter(client),
    new ExpositionFilteringRag(new InMemoryRag()),
    config,
  );
  const clients = jest.spyOn(SmartAgentBuilder.prototype, 'withMcpClients');
  const prepared = await runWithSessionId(
    'author-session',
    () =>
      handle.profileRunner.preparePlanAuthor({
        systemPrompt: 'Plan',
        mode: 'create',
      }),
    undefined,
    'alice',
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const authorClient = clients.mock.calls.at(-1)?.[0][0];
  if (!authorClient) throw new Error('Missing author MCP client');
  await expect(authorClient.callTool('record_add', {})).rejects.toThrow(
    'forbidden',
  );
  const registry = getCollectionRegistry();
  const agents = {
    id: 'agents',
    logicalId: 'agents',
    displayName: 'agents',
    description: '',
    scope: 'global' as const,
    collectionKind: 'agents' as const,
    documentCount: 1,
    sourceCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const meta = jest.spyOn(registry, 'getCollection').mockResolvedValue(agents);
  const list = jest
    .spyOn(registry, 'listCollections')
    .mockResolvedValue([agents]);
  liveSession('alice', 'author-session');
  try {
    for (const name of readTools) {
      const result = await runWithSessionId(
        'author-session',
        () =>
          authorClient.callTool(name, {
            collection: 'agents',
            collections: ['agents'],
            record: 'coordinator',
            query: 'secret',
          }),
        undefined,
        'alice',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Missing tool result');
      if (name === 'collections_list') {
        expect(result.value.content).toBe('{"collections":[]}');
      } else {
        expect(result.value.isError).toBe(true);
      }
    }
  } finally {
    meta.mockRestore();
    list.mockRestore();
  }
  clients.mockRestore();
  await runWithSessionId(
    'author-session',
    () => prepared.value.process('Create a plan'),
    undefined,
    'alice',
  );
  expect(offered.at(-1)?.sort()).toEqual([...readTools].sort());

  const restricted = await runWithSessionId(
    'author-session',
    () =>
      runWithProfileTools(new AgentToolPermissions(['rag_read']), () =>
        handle.profileRunner.preparePlanAuthor({
          systemPrompt: 'Revise',
          mode: 'revise',
        }),
      ),
    undefined,
    'alice',
  );
  if (!restricted.ok) throw new Error(restricted.error.message);
  await runWithSessionId(
    'author-session',
    () => restricted.value.process('Revise a plan'),
    undefined,
    'alice',
  );
  expect(offered.at(-1)).toEqual(['rag_read']);
});

test.each([undefined, 'explicit-planner'])(
  'author uses the deploy main model unless planner model is set (%s)',
  async (plannerModel) => {
    const authorConfig: AgentConfig = {
      ...config,
      llm: { ...config.llm, model: 'author-deploy-default', plannerModel },
    };
    const configSpy = jest
      .spyOn(agentConfig, 'getAgentConfig')
      .mockReturnValue(authorConfig);
    jest.mocked(makeHubLlm).mockImplementation(async (options) => ({
      ...model,
      model: options.model,
    }));
    const empty: IMcpClient = {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => ({ ok: true, value: { content: '' } }),
    };
    const selected = jest.spyOn(SmartAgentBuilder.prototype, 'withMainLlm');
    try {
      for (const mainModel of ['main-before-switch', 'main-after-switch']) {
        await getSmartAgent(mainModel);
        const callsBeforeAuthor = jest.mocked(makeHubLlm).mock.calls.length;
        const author = await buildPlannerAgent(authorConfig, 'Author', empty);
        releasePlannerAgent(author);
        expect(makeHubLlm).toHaveBeenCalledTimes(
          callsBeforeAuthor + (mainModel === 'main-before-switch' ? 1 : 0),
        );
        expect(makeHubLlm).toHaveBeenLastCalledWith(
          expect.objectContaining({
            component: 'planner-author',
            model: plannerModel ?? authorConfig.llm.model,
          }),
          config.llm.temperature,
        );
        expect(selected.mock.calls.at(-1)?.[0].model).toBe(
          plannerModel ?? authorConfig.llm.model,
        );
      }
    } finally {
      selected.mockRestore();
      configSpy.mockRestore();
    }
  },
);

test('coordinator defaults to planner model and an override selects a separate model', async () => {
  jest.mocked(makeHubLlm).mockImplementation(async (options) => ({
    ...model,
    model: options.model,
  }));
  const selected = jest.spyOn(SmartAgentBuilder.prototype, 'withMainLlm');
  const plannerConfig = {
    ...config,
    llm: { ...config.llm, plannerModel: 'planner-model' },
  };
  const coordinator = await buildPlannerAgent(plannerConfig, 'Coordinate');
  releasePlannerAgent(coordinator);
  expect(selected.mock.calls.at(-1)?.[0].model).toBe('planner-model');
  expect(makeHubLlm).toHaveBeenLastCalledWith(
    expect.objectContaining({ model: 'planner-model' }),
    0,
  );
  const overrideConfig = {
    ...plannerConfig,
    llm: { ...plannerConfig.llm, coordinatorModel: 'coordinator-model' },
  };
  const override = await buildPlannerAgent(overrideConfig, 'Coordinate');
  releasePlannerAgent(override);
  expect(selected.mock.calls.at(-1)?.[0].model).toBe('coordinator-model');
  expect(makeHubLlm).toHaveBeenLastCalledWith(
    expect.objectContaining({ model: 'coordinator-model' }),
    0,
  );
  const empty: IMcpClient = {
    listTools: async () => ({ ok: true, value: [] }),
    callTool: async () => ({ ok: true, value: { content: '' } }),
  };
  const author = await buildPlannerAgent(overrideConfig, 'Author', empty);
  releasePlannerAgent(author);
  expect(selected.mock.calls.at(-1)?.[0].model).toBe('planner-model');
  selected.mockRestore();
  // The cached planner LLM is reused; the coordinator override never replaces it.
  await author.process('Plan');
});
