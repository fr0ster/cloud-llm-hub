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
  migratePgVectorRagAccess,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  migrateQdrantVectorRagAccess,
  QdrantRagProvider,
} from '@mcp-abap-adt/qdrant-rag';
import { restampHubStores } from '../../srv/lib/hub-store-restamp';
import {
  isRagMigrationReady,
  migrateHubRagProviders,
  migrateRagData,
} from '../../srv/lib/rag-migration';
import { migrateSharedHistory } from '../../srv/lib/session-history-collection';

function provider() {
  return new PgVectorRagProvider({
    name: 'test',
    connection: 'postgres://localhost/test',
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [1] }) }),
  });
}

test('dispatches the HANA and Qdrant backend migrations', async () => {
  const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1] }) });
  const hana = new HanaVectorRagProvider({
    name: 'hana',
    embedder,
    connection: {
      host: 'localhost',
      collectionName: 'test',
      credential: staticLogin('test', 'test'),
    },
  });
  const qdrant = new QdrantRagProvider({
    name: 'qdrant',
    url: 'http://localhost:6333',
    embedder,
  });
  jest
    .mocked(migrateHanaVectorRagAccess)
    .mockResolvedValue({ ok: true, value: { reported: [] } });
  jest
    .mocked(migrateQdrantVectorRagAccess)
    .mockResolvedValue({ ok: true, value: { reported: [] } });
  expect((await migrateRagData(hana, 'hana-vector', jest.fn())).ok).toBe(true);
  expect((await migrateRagData(qdrant, 'qdrant', jest.fn())).ok).toBe(true);
  expect(migrateHanaVectorRagAccess).toHaveBeenCalledWith(hana);
  expect(migrateQdrantVectorRagAccess).toHaveBeenCalledWith(qdrant);
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

test('runs restamp, history move, backend migration in that order', async () => {
  const order: string[] = [];
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
  expect(order).toEqual(['restamp', 'history', 'backend']);
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
