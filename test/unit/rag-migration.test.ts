jest.mock('../../srv/lib/hub-store-restamp');
jest.mock('../../srv/lib/session-history-collection');
jest.mock('@mcp-abap-adt/pg-vector-rag', () => ({
  ...jest.requireActual<typeof import('@mcp-abap-adt/pg-vector-rag')>(
    '@mcp-abap-adt/pg-vector-rag',
  ),
  migratePgVectorRagAccess: jest.fn(),
}));
jest.mock('@mcp-abap-adt/hana-vector-rag', () => ({
  ...jest.requireActual<typeof import('@mcp-abap-adt/hana-vector-rag')>(
    '@mcp-abap-adt/hana-vector-rag',
  ),
  migrateHanaVectorRagAccess: jest.fn(),
}));
jest.mock('@mcp-abap-adt/qdrant-rag', () => ({
  ...jest.requireActual<typeof import('@mcp-abap-adt/qdrant-rag')>(
    '@mcp-abap-adt/qdrant-rag',
  ),
  migrateQdrantMultivectors: jest.fn(),
  migrateQdrantVectorRagAccess: jest.fn(),
}));

import {
  HanaVectorRagProvider,
  migrateHanaVectorRagAccess,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  RagError,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  fragmentOrdinalMigrationSql,
  migratePgVectorRagAccess,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  migrateQdrantMultivectors,
  migrateQdrantVectorRagAccess,
} from '@mcp-abap-adt/qdrant-rag';
import { restampHubStores } from '../../srv/lib/hub-store-restamp';
import {
  isRagMigrationReady,
  migrateHubRagProviders,
  migrateRagData,
} from '../../srv/lib/rag-migration';
import { createCollectionProvider } from '../../srv/lib/rag-provider-factory';
import { migrateSharedHistory } from '../../srv/lib/session-history-collection';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1] }) });
const queryPg = jest.fn(async () => ({ rows: [], rowCount: 0 }));

function provider() {
  return new PgVectorRagProvider({
    name: 'test',
    connection: { collectionName: 'test', schema: 'hub', layout: 'shared' },
    layout: 'shared',
    embedder,
    clientFactory: () => ({ query: queryPg, end: async () => {} }),
  });
}

const queryHana = jest.fn(
  async (): Promise<{ COLUMN_NAME: string }[]> => [
    { COLUMN_NAME: 'FRAGMENT_ORDINAL' },
  ],
);
const execHana = jest.fn(async () => ({ rowCount: 0 }));

function hanaProvider() {
  return new HanaVectorRagProvider({
    name: 'hana',
    embedder,
    connection: {
      host: 'localhost',
      collectionName: 'test',
      credential: staticLogin('test', 'test'),
      layout: 'shared',
      schema: 'HUB_HDI',
    },
    layout: 'shared',
    clientFactory: () => ({
      query: queryHana,
      exec: execHana,
      close: async () => {},
    }),
  });
}

test('checks the HDI column before migrating HANA records', async () => {
  const hana = hanaProvider();
  jest
    .mocked(migrateHanaVectorRagAccess)
    .mockResolvedValue({ ok: true, value: { reported: [] } });
  expect((await migrateRagData(hana, 'hana-vector', jest.fn())).ok).toBe(true);
  expect(queryHana).toHaveBeenCalledWith(
    expect.stringContaining("COLUMN_NAME = 'FRAGMENT_ORDINAL'"),
    ['HUB_HDI', 'RAG_DOCUMENTS'],
  );
  expect(queryHana.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(restampHubStores).mock.invocationCallOrder[0],
  );
  expect(execHana).not.toHaveBeenCalled();
  expect(migrateHanaVectorRagAccess).toHaveBeenCalledWith(hana);
});

test('a stale HANA table blocks startup with an HDI deployment diagnostic', async () => {
  queryHana.mockResolvedValueOnce([]);
  const log = jest.fn();
  const result = await migrateHubRagProviders(
    [{ provider: hanaProvider(), kind: 'hana-vector' }],
    log,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected a schema failure');
  expect(result.error.message).toContain('RAG_DOCUMENTS.FRAGMENT_ORDINAL');
  expect(isRagMigrationReady()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      'RAG_DOCUMENTS.FRAGMENT_ORDINAL is missing. Deploy the updated HDI artifacts',
    ),
  );
  expect(execHana).not.toHaveBeenCalled();
  expect(restampHubStores).not.toHaveBeenCalled();
  expect(migrateHanaVectorRagAccess).not.toHaveBeenCalled();
});

const qdrantConfig = {
  url: 'http://localhost:6333',
  prefix: 'hub',
  apiKey: 'key',
};

test('migrates Qdrant data, including a catalogued collection awaiting resume', async () => {
  const qdrant = createCollectionProvider(
    {
      backends: { tools: 'qdrant', persistent: 'qdrant', session: 'qdrant' },
      embedder: null,
      qdrant: qdrantConfig,
    },
    { retrieval: embedder },
  );
  if (!qdrant) throw new Error('Expected Qdrant provider');
  const collection = `hub_c_${'a'.repeat(40)}`;
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/collections/hub-collections-catalog')
        return Response.json({ result: {} });
      if (path === '/collections/hub-collections-catalog/points/scroll')
        return Response.json({
          result: {
            points: ['provider-created', 'hub_h_history'].map((name) => ({
              payload: {
                store_name: name,
                collection_name: name,
                scope: 'global',
                attributes_json: '{}',
              },
            })),
          },
        });
      if (path === '/collections')
        return Response.json({
          result: {
            collections: [
              'hub-collections-catalog',
              'hub-catalog',
              'hub-collections-catalog_rag_roles',
              'hub_h_other-collections-catalog',
              'hub_h_trust',
              'provider-created',
              'unrelated',
              collection,
            ].map((name) => ({ name })),
          },
        });
      throw new Error(`Unexpected request ${path}`);
    });

  jest
    .mocked(migrateQdrantVectorRagAccess)
    .mockResolvedValue({ ok: true, value: { reported: [] } });
  jest.mocked(migrateQdrantMultivectors).mockImplementation(async (options) => {
    expect(await options.credential?.secret()).toBe('key');
    expect(options.url).toBe(qdrantConfig.url);
    if (!options.collection)
      throw new Error('Expected a physical collection name');
    if (options.collection === 'hub-tools-writer')
      throw new RagError(
        'Qdrant collection "hub-tools-writer" does not exist',
        'RAG_MIGRATION_ERROR',
      );
    return [
      {
        collection: options.collection,
        temporaryCollection: 'backup',
        action:
          options.collection === 'hub_h_history'
            ? 'resume'
            : 'already-migrated',
      },
    ];
  });
  try {
    const log = jest.fn();
    expect(
      (
        await migrateHubRagProviders(
          [{ provider: qdrant, kind: 'qdrant' }],
          log,
          {
            config: qdrantConfig,
            standaloneCollections: [
              'hub-tools-reader',
              'hub-tools-writer',
              'hub-planner-memory',
            ],
          },
        )
      ).ok,
    ).toBe(true);
    expect(
      jest
        .mocked(migrateQdrantMultivectors)
        .mock.calls.map(([options]) => options.collection),
    ).toEqual([
      'hub-tools-reader',
      'hub-tools-writer',
      'hub-planner-memory',
      'provider-created',
      'hub_h_history',
      'hub_h_trust',
      collection,
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('collection=hub_h_history action=resume'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('collection=hub_h_trust action=already-migrated'),
    );
    expect(migrateQdrantVectorRagAccess).toHaveBeenCalledWith(qdrant);
  } finally {
    fetch.mockRestore();
  }
});

test('a failed Qdrant conversion logs the collection and blocks readiness', async () => {
  jest
    .mocked(migrateQdrantMultivectors)
    .mockRejectedValueOnce(new Error('private credentials'));
  const log = jest.fn();
  const result = await migrateHubRagProviders([], log, {
    config: qdrantConfig,
    standaloneCollections: ['hub-tools-reader'],
  });
  expect(result.ok).toBe(false);
  expect(isRagMigrationReady()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      'qdrant/multivectors/hub-tools-reader: QDRANT_MULTIVECTOR_ERROR',
    ),
  );
  expect(log.mock.calls.flat().join(' ')).not.toContain('private credentials');
});

test('history errors prevent backend migration', async () => {
  const log = jest.fn();
  jest.mocked(migrateSharedHistory).mockResolvedValue({
    ok: false,
    error: new RagError('Unresolved shared history identity: h_history/orphan'),
  });
  expect((await migrateRagData(provider(), 'pg-vector', log)).ok).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('h_history/orphan'));
  expect(migratePgVectorRagAccess).not.toHaveBeenCalled();
});

test('a failed provider keeps readiness false while other providers report findings', async () => {
  const log = jest.fn();
  jest.mocked(migratePgVectorRagAccess).mockResolvedValue({
    ok: true,
    value: { reported: [{ storeName: 'bad', reason: 'conflict' }] },
  });
  expect(
    (
      await migrateHubRagProviders(
        [
          { provider: provider(), kind: 'pg-vector' },
          { provider: provider(), kind: 'pg-vector' },
        ],
        log,
      )
    ).ok,
  ).toBe(false);
  expect(migratePgVectorRagAccess).toHaveBeenCalledTimes(2);
  expect(isRagMigrationReady()).toBe(false);
});

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(restampHubStores)
    .mockResolvedValue({ ok: true, value: { rewritten: 1 } });
  jest
    .mocked(migrateSharedHistory)
    .mockResolvedValue({ ok: true, value: { moved: 2 } });
  jest
    .mocked(migratePgVectorRagAccess)
    .mockResolvedValue({ ok: true, value: { reported: [] } });
});

test('upgrades the configured PG schema before restamp, history move and access migration', async () => {
  const order: string[] = [];
  queryPg.mockImplementationOnce(async () => {
    order.push('layout');
    return { rows: [], rowCount: 0 };
  });
  jest.mocked(restampHubStores).mockImplementation(async () => {
    order.push('restamp');
    return { ok: true, value: { rewritten: 1 } };
  });
  jest.mocked(migrateSharedHistory).mockImplementation(async () => {
    order.push('history');
    return { ok: true, value: { moved: 1 } };
  });
  jest.mocked(migratePgVectorRagAccess).mockImplementation(async () => {
    order.push('backend');
    return { ok: true, value: { reported: [] } };
  });
  expect((await migrateRagData(provider(), 'pg-vector', jest.fn())).ok).toBe(
    true,
  );
  expect(queryPg.mock.calls).toEqual([
    [fragmentOrdinalMigrationSql('rag_documents', 'shared', 'hub'), undefined],
  ]);
  expect(order).toEqual(['layout', 'restamp', 'history', 'backend']);
});

test('a PG layout failure prevents record migration and readiness', async () => {
  queryPg.mockRejectedValueOnce(new Error('DDL failed'));
  const log = jest.fn();
  const result = await migrateHubRagProviders(
    [{ provider: provider(), kind: 'pg-vector' }],
    log,
  );
  expect(result.ok).toBe(false);
  expect(isRagMigrationReady()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('pg-vector/storage layout'),
  );
  expect(restampHubStores).not.toHaveBeenCalled();
});

test('a reported finding fails the start and is logged', async () => {
  const log = jest.fn();
  jest.mocked(migratePgVectorRagAccess).mockResolvedValue({
    ok: true,
    value: {
      reported: [
        { storeName: 'notes', reason: 'ambiguous owner' },
        { storeName: 'other', reason: 'invalid catalog' },
      ],
    },
  });
  expect(
    (
      await migrateHubRagProviders(
        [{ provider: provider(), kind: 'pg-vector' }],
        log,
      )
    ).ok,
  ).toBe(false);
  expect(isRagMigrationReady()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('store=notes reason=ambiguous owner'),
  );
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('store=other reason=invalid catalog'),
  );
});

test('restamp conflicts log row ids and stop before history and backend', async () => {
  const log = jest.fn();
  jest.mocked(restampHubStores).mockResolvedValue({
    ok: false,
    error: new RagError(
      'Hub restamp conflicts: [{"storeName":"h_runs","rowId":"row-1","keys":["userId","authorUserId"]}]',
      'HUB_RESTAMP_CONFLICT',
    ),
  });
  expect((await migrateRagData(provider(), 'pg-vector', log)).ok).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('row-1'));
  expect(migrateSharedHistory).not.toHaveBeenCalled();
  expect(migratePgVectorRagAccess).not.toHaveBeenCalled();
});

test('each distinct hub provider migrates once and readiness waits for all', async () => {
  const first = provider();
  const second = provider();
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  jest.mocked(migrateSharedHistory).mockImplementation(async (p) => {
    if (p === second) await pending;
    return { ok: true, value: { moved: 0 } };
  });
  const running = migrateHubRagProviders(
    [
      { provider: first, kind: 'pg-vector' },
      { provider: first, kind: 'pg-vector' },
      { provider: second, kind: 'pg-vector' },
    ],
    jest.fn(),
  );
  expect(isRagMigrationReady()).toBe(false);
  finish?.();
  expect((await running).ok).toBe(true);
  expect(restampHubStores).toHaveBeenCalledTimes(2);
  expect(migratePgVectorRagAccess).toHaveBeenCalledTimes(2);
  expect(isRagMigrationReady()).toBe(true);
});

test('in-memory requires no provider or migrations', async () => {
  expect(await migrateRagData(null, 'in-memory', jest.fn())).toEqual({
    ok: true,
    value: undefined,
  });
  expect(restampHubStores).not.toHaveBeenCalled();
});

test('driver failures are logged without contents or secrets', async () => {
  const log = jest.fn();
  jest.mocked(migratePgVectorRagAccess).mockResolvedValue({
    ok: false,
    error: new RagError('password=secret private row contents', 'DRIVER_ERROR'),
  });
  expect((await migrateRagData(provider(), 'pg-vector', log)).ok).toBe(false);
  expect(log.mock.calls.flat().join(' ')).not.toMatch(/secret|private row/);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('DRIVER_ERROR'));
});

test('a missing persistent provider fails closed', async () => {
  const log = jest.fn();
  const result = await migrateHubRagProviders(
    [{ provider: null, kind: 'pg-vector' }],
    log,
  );
  expect(result.ok).toBe(false);
  expect(isRagMigrationReady()).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('MISSING_PROVIDER'));
  expect(restampHubStores).not.toHaveBeenCalled();
});

test('a thrown driver failure keeps requests gated without logging secrets', async () => {
  const log = jest.fn();
  jest
    .mocked(migratePgVectorRagAccess)
    .mockRejectedValue(new Error('password=secret private row contents'));
  const result = await migrateHubRagProviders(
    [{ provider: provider(), kind: 'pg-vector' }],
    log,
  );
  expect(result.ok).toBe(false);
  expect(isRagMigrationReady()).toBe(false);
  expect(log.mock.calls.flat().join(' ')).not.toMatch(/secret|private row/);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('MIGRATION_EXCEPTION'),
  );
});

test.each([
  [
    'RAG access persistence requires Qdrant >= 1.17.0 (insert_only)',
    'RAG access persistence requires Qdrant >= 1.17.0 (insert_only)',
  ],
  [
    'Cannot migrate https://user:secret@example.com/store: HTTP 403',
    'Cannot migrate https://[redacted]@example.com/store: HTTP 403',
  ],
])(
  'backend migration logs technical reason with credentials redacted: %s',
  async (message, expected) => {
    jest.mocked(migratePgVectorRagAccess).mockResolvedValue({
      ok: false,
      error: new RagError(message, 'RAG_MIGRATION_ERROR'),
    });
    const log = jest.fn();
    expect((await migrateRagData(provider(), 'pg-vector', log)).ok).toBe(false);
    expect(log).toHaveBeenCalledWith(
      `RAG migration pg-vector/backend: RAG_MIGRATION_ERROR: ${expected}`,
    );
  },
);
