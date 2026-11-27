import { createServer } from 'node:http';
import {
  CircuitBreaker,
  CircuitBreakerEmbedderBase,
  InMemoryRag,
  type IRagCatalogUpdater,
  type IRagProvider,
  type RagCollectionRecord,
  RagError,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { getAgentConfig } from '../../srv/agent-config';
import { historyProvider, initProviders } from '../../srv/agent-manager';
import {
  storeNameFor,
  unwrap,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
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
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';
import { historyCollectionName } from '../../srv/lib/session-history-collection';
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
const qdrant = { prefix: 'hub', url: 'http://localhost:6333' };
const unstampedStoreName = storeNameFor('notes', qdrant.prefix);
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
const embedder = new CircuitBreakerEmbedderBase(
  { embed: async () => ({ vector: [0, 1] }) },
  breaker,
);
const embedding = {
  fingerprint,
  breaker,
  embedder,
  retrieval: symmetricEmbedder(embedder),
  toolSearchEmbedder: new CircuitBreakerEmbedderBase(toolSearch, breaker),
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
        {
          scope: 'user',
          userId: 'alice',
          name: 'notes',
          storeName: unstampedStoreName,
          attributes: {
            writtenBy: WRITTEN_BY,
            collectionId: 'notes',
            logicalId: 'notes',
            hubOwner: { userId: 'alice' },
          },
        },
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
  const config = jest
    .requireActual<typeof import('../../srv/agent-config')>(
      '../../srv/agent-config',
    )
    .getAgentConfig();
  jest.mocked(getAgentConfig).mockReturnValue({
    ...config,
    rag: { ...config.rag, qdrant },
  });
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

it('re-embeds and restamps two stale session history records on CF with a non-batch provider', async () => {
  const { buildEmbedding } = jest.requireActual<
    typeof import('../../srv/lib/providers')
  >('../../srv/lib/providers');
  const { migrateEmbeddings: migrateActual } = jest.requireActual<
    typeof import('../../srv/lib/embedder-migration')
  >('../../srv/lib/embedder-migration');
  migrate.mockImplementation(migrateActual);
  const vector = new Array<number>(PROVIDER_DEFAULT_DIMENSION).fill(1);
  const embed = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockResolvedValue({ vector });
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: fingerprint.embeddingModel,
    resourceGroup: fingerprint.resourceGroup,
  });
  if (!embedding) throw new Error('Expected AI Core embedding');
  const sessionId = 'session-to-migrate';
  const name = historyCollectionName(sessionId);
  const record = {
    scope: 'session',
    sessionId,
    name,
    storeName: name,
    attributes: { source: 'session-history', embedder: 'stale' },
  } satisfies RagCollectionRecord;
  const rag = new VectorRag(embedding.retrieval);
  const oldVector = vector.map((_, index) => Number(index === 0));
  for (const text of ['first turn', 'second turn']) {
    unwrap(
      await rag.upsertPrecomputed(text, oldVector, {
        id: text,
        embedder: 'stale',
      }),
      'seed session history',
    );
  }
  const sessionHistory: IRagProvider & IRagCatalogUpdater = {
    ...provider('pg-vector'),
    supportedScopes: ['session'],
    describeCollections: async () => ({
      ok: true,
      value: { records: [record], rejected: [] },
    }),
    openCollection: async () => ({
      ok: true,
      value: {
        rag,
        editor: {
          upsert: async () => {
            throw new Error('Unexpected editor upsert');
          },
          deleteById: rag.writer().deleteByIdRaw,
        },
      },
    }),
    updateCollection: jest.fn(async () => ({
      ok: true as const,
      value: undefined,
    })),
  };
  jest.mocked(historyProvider).mockReturnValue(sessionHistory);
  start.mockResolvedValue({ ...providers, embedding, collections: null });

  const exitCode = await main(cf);

  expect(console.error).not.toHaveBeenCalled();
  expect(exitCode).toBe(0);
  expect(embed.mock.calls.map(([text]) => text)).toEqual([
    'dimension probe',
    'first turn',
    'second turn',
  ]);
  const current = fingerprintHash(fingerprint);
  const { records } = unwrap(await rag.scan({}), 'scan migrated history');
  expect(
    records.map(({ text, metadata }) => [text, metadata.embedder]),
  ).toEqual([
    ['first turn', current],
    ['second turn', current],
  ]);
  expect(sessionHistory.updateCollection).toHaveBeenCalledWith(name, {
    attributes: { ...record.attributes, embedder: current },
  });
});

it('checks the physical Qdrant dimension for history and unstamped registry collections', async () => {
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
  expect(migrate.mock.calls[1][1].storePrefix).toBe(qdrant.prefix);
  expect(resolveDimension.mock.calls).toEqual([
    ['hub_h_history'],
    [unstampedStoreName],
  ]);
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
  resolveDimension.mockImplementation(async (name) =>
    name === 'hub-planner-memory' ? 3 : 2,
  );

  expect(await main(cf)).toBe(0);
  expect(listStores).toHaveBeenCalledWith('session', 'planner-memory');
  expect(create).toHaveBeenCalledWith('session', 'planner-memory');
  expect(resolveDimension.mock.calls).toEqual([
    ['hub_h_history'],
    [unstampedStoreName],
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
