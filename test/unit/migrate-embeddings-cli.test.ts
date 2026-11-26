import { createServer } from 'node:http';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  InMemoryRag,
  type IRagProvider,
  RagError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { getAgentConfig } from '../../srv/agent-config';
import { historyProvider, initProviders } from '../../srv/agent-manager';
import { EnvDestinationSource } from '../../srv/lib/destination-source';
import {
  migrateEmbeddings,
  migrateStandaloneStore,
} from '../../srv/lib/embedder-migration';
import { type Providers, startProviders } from '../../srv/lib/providers';
import { runStartMigrations } from '../../srv/lib/rag-migration';
import {
  PROVIDER_DEFAULT_DIMENSION,
  providerVectorDimension,
} from '../../srv/lib/rag-provider-factory';
import {
  createRagStoreFactory,
  type RagStoreFactory,
} from '../../srv/lib/rag-store-factory';
import { fingerprintHash } from '../../srv/lib/tool-corpus';
import { main } from '../../srv/migrate-embeddings';

jest.mock('../../srv/agent-config', () => ({
  ensureAiCoreCredentials: jest.fn(),
  getAgentConfig: jest.fn(),
}));
jest.mock('../../srv/agent-manager');
jest.mock('../../srv/lib/embedder-migration', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/embedder-migration')>(
    '../../srv/lib/embedder-migration',
  ),
  migrateEmbeddings: jest.fn(),
  migrateStandaloneStore: jest.fn(),
}));
jest.mock('../../srv/lib/providers');
jest.mock('../../srv/lib/rag-provider-factory', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/rag-provider-factory')>(
    '../../srv/lib/rag-provider-factory',
  ),
  providerVectorDimension: jest.fn(),
}));
jest.mock('../../srv/lib/rag-migration', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/rag-migration')>(
    '../../srv/lib/rag-migration',
  ),
  runStartMigrations: jest.fn(),
}));

const cf = { VCAP_APPLICATION: '{}' };
const fingerprint = {
  provider: 'sap-ai-sdk',
  embeddingModel: 'embedding-model',
  resourceGroup: 'current-group',
};
const breaker = new CircuitBreaker({
  failureThreshold: 30,
  recoveryWindowMs: 60_000,
});
const toolSearch = { embed: jest.fn(async () => ({ vector: [1, 0] })) };
const embedder = new CircuitBreakerEmbedder(
  { embed: async () => ({ vector: [0, 1] }) },
  breaker,
);
const embedding = {
  fingerprint,
  breaker,
  embedder,
  retrieval: symmetricEmbedder(embedder),
  toolSearchEmbedder: new CircuitBreakerEmbedder(toolSearch, breaker),
};

function provider(name: string): IRagProvider {
  return {
    name,
    kind: name,
    editable: true,
    supportedScopes: ['global'],
    createCollection: async () => {
      throw new Error('Unexpected store creation');
    },
  };
}

const collections = provider('pg-vector');
const history: IRagProvider = {
  ...provider('qdrant'),
  describeCollections: async () => ({
    ok: true,
    value: {
      rejected: [],
      records: [
        { scope: 'global', name: 'h_history', storeName: 'hub_h_history' },
        { scope: 'global', name: 'h_sessions', storeName: 'hub_h_sessions' },
      ],
    },
  }),
};
const providers: Providers = {
  embedding,
  collections,
  compatibleEmbeddingResourceGroups: ['previous-group'],
  stores: createRagStoreFactory(
    {
      embedder: null,
      backends: {
        tools: 'in-memory',
        session: 'pg-vector',
        persistent: 'pg-vector',
      },
    },
    embedding,
  ),
  destinations: new EnvDestinationSource([]),
};

const start = jest.mocked(startProviders);
const migrateLayout = jest.mocked(runStartMigrations);
const migrate = jest.mocked(migrateEmbeddings);
const migrateStandalone = jest.mocked(migrateStandaloneStore);
const resolveDimension = jest.fn(async (_name: string) => 2);

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  start.mockResolvedValue(providers);
  jest.mocked(historyProvider).mockReturnValue(collections);
  jest.mocked(providerVectorDimension).mockReturnValue(resolveDimension);
  resolveDimension.mockResolvedValue(2);
  migrateLayout.mockResolvedValue({ ok: true, value: undefined });
  migrate.mockImplementation(async (_provider, opts) => {
    opts.log(
      'Embedder migration h_history: reembedded, 1 records, 2 fragments, 3 ms',
    );
    return {
      ok: true,
      value: { stores: [], promptTokens: 12, tokensReported: true },
    };
  });
  migrateStandalone.mockResolvedValue({
    ok: true,
    value: { stores: [], promptTokens: 3, tokensReported: true },
  });
});

afterEach(() => jest.restoreAllMocks());

it('initializes providers, runs startup migrations, and logs store and token summaries', async () => {
  expect(await main(cf)).toBe(0);
  expect(getAgentConfig).toHaveBeenCalled();
  expect(initProviders).toHaveBeenCalledWith(providers);
  expect(migrateLayout.mock.calls[0][0]).toBe(providers);
  expect(migrateLayout.mock.invocationCallOrder[0]).toBeLessThan(
    migrate.mock.invocationCallOrder[0],
  );
  expect(migrate).toHaveBeenCalledTimes(1);
  const [usedProvider, options] = migrate.mock.calls[0];
  expect(usedProvider).toBe(collections);
  expect(options.dimension).toBe(PROVIDER_DEFAULT_DIMENSION);
  expect(options.current).toBe(fingerprintHash(fingerprint));
  expect(options.compatible).toContain(
    fingerprintHash({ ...fingerprint, resourceGroup: 'previous-group' }),
  );
  expect(options.embedder).toBe(embedding.retrieval);
  expect(
    options.storeEmbedder?.({
      scope: 'global',
      name: 'h_planner_memory',
      storeName: 'h_planner_memory',
    }),
  ).toBe(embedding.retrieval);
  toolSearch.embed.mockResolvedValue({ vector: [1, 0] });
  const histories = [
    { scope: 'global', name: 'h_history', storeName: 'h_history' },
    {
      scope: 'session',
      name: 'h_hist_test',
      storeName: 'h_hist_test',
      sessionId: 's1',
      attributes: { source: 'session-history' },
    },
  ] as const;
  for (const record of histories)
    expect(await options.storeEmbedder?.(record).embedDocument('text')).toEqual(
      {
        vector: [1, 0],
      },
    );
  expect(migrateStandalone).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('h_history'),
  );
  expect(console.log).toHaveBeenCalledWith('tokens embedding-model: input 12');
});

it('migrates a distinct history provider with the physical Qdrant dimension', async () => {
  start.mockResolvedValue({
    ...providers,
    stores: {
      ...providers.stores,
      backendOf: (name) => (name === 'session' ? 'qdrant' : 'pg-vector'),
      listStores: async () => ({ ok: true, value: [] }),
    },
  });
  jest.mocked(historyProvider).mockReturnValue(history);

  expect(await main(cf)).toBe(0);
  expect(migrate).toHaveBeenCalledTimes(2);
  expect(migrate.mock.calls[1][0]).toBe(history);
  expect(migrate.mock.calls[1][1].dimension).toBe(2);
  expect(resolveDimension.mock.calls).toEqual([['hub_h_history']]);
  expect(migrateStandalone).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith('tokens embedding-model: input 24');
});

it('migrates the standalone session planner store using its physical Qdrant dimension', async () => {
  const rag = new InMemoryRag();
  const create = jest.fn(() => rag);
  const listStores = jest.fn(
    async (): ReturnType<RagStoreFactory['listStores']> => ({
      ok: true,
      value: ['planner-memory'],
    }),
  );
  start.mockResolvedValue({
    ...providers,
    stores: {
      ...providers.stores,
      backendOf: (name) => (name === 'session' ? 'qdrant' : 'pg-vector'),
      qdrantCollection: (name) => `hub-${name}`,
      listStores,
      create,
    },
  });
  jest.mocked(historyProvider).mockReturnValue(history);
  resolveDimension.mockResolvedValueOnce(2).mockResolvedValueOnce(3);

  expect(await main(cf)).toBe(0);
  expect(listStores).toHaveBeenCalledWith('session', 'planner-memory');
  expect(create).toHaveBeenCalledWith('session', 'planner-memory');
  expect(resolveDimension.mock.calls).toEqual([
    ['hub_h_history'],
    ['hub-planner-memory'],
  ]);
  expect(migrateStandalone).toHaveBeenCalledWith(rag, 'hub-planner-memory', {
    current: fingerprintHash(fingerprint),
    compatible: new Set([
      fingerprintHash(fingerprint),
      fingerprintHash({ ...fingerprint, resourceGroup: 'previous-group' }),
    ]),
    embedder: embedding.retrieval,
    dimension: 3,
    log: console.log,
  });
  expect(console.log).toHaveBeenCalledWith('tokens embedding-model: input 27');
});

it('returns 1 when the startup migration fails', async () => {
  migrateLayout.mockResolvedValue({
    ok: false,
    error: new RagError('layout failed'),
  });

  expect(await main(cf)).toBe(1);
  expect(migrate).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith('layout failed');
});

it('returns 1 when the embedding migration fails', async () => {
  migrate.mockResolvedValue({
    ok: false,
    error: new RagError('embedding failed'),
  });

  expect(await main(cf)).toBe(1);
  expect(console.error).toHaveBeenCalledWith('embedding failed');
});

it('exits successfully without an embedder', async () => {
  start.mockResolvedValue({ ...providers, embedding: null, collections: null });

  expect(await main(cf)).toBe(0);
  expect(migrateLayout).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('No embedding'),
  );
});

it('refuses locally on a health response and continues after connection refusal', async () => {
  const request = jest.fn(
    (method: string | undefined, url: string | undefined) => [method, url],
  );
  const server = createServer((req, res) => {
    request(req.method, req.url);
    res.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const env = { PORT: String(address.port) };
  try {
    expect(await main(env)).toBe(1);
    expect(request.mock.calls).toEqual([['GET', '/health']]);
    expect(start).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('stop the hub before migrating');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  migrate.mockResolvedValue({
    ok: true,
    value: { stores: [], promptTokens: 0, tokensReported: false },
  });
  expect(await main(env)).toBe(0);
  expect(console.log).toHaveBeenCalledWith(
    'tokens embedding-model: not reported',
  );
});
