import {
  type IDocumentEmbedder,
  type IEmbedResult,
  type IRag,
  type IRagBackendWriter,
  type IRagCatalogUpdater,
  type IRagEditor,
  type IRagProvider,
  type IRagScanner,
  type RagCatalogPatch,
  type RagCollectionRecord,
  type RagDocumentVectors,
  RagError,
  type RagMetadata,
  type RagScanPage,
  type RagScanRecord,
  type Result,
  validateRagAttributes,
} from '@mcp-abap-adt/llm-agent';
import {
  encodeAttributes,
  storeNameFor,
  unwrap,
} from '../../srv/lib/collection-persistence';
import {
  migrateEmbeddings,
  migrateStandaloneStore,
} from '../../srv/lib/embedder-migration';
import { historyCollectionName } from '../../srv/lib/session-history-collection';
import type { CollectionMeta } from '../../srv/rag-collections';

const current = '111111111111';
const previous = '222222222222';
const compatible = '333333333333';
const dimension = 2;

const meta: CollectionMeta = {
  id: 'notes',
  logicalId: 'notes',
  displayName: 'Notes',
  description: 'Test notes',
  scope: 'user',
  owner: 'alice',
  collectionKind: 'knowledge',
  createdAt: '2026-11-26T00:00:00.000Z',
  documentCount: 0,
  sourceCount: 0,
};

function registryRecord(embedder = previous) {
  return {
    scope: 'user',
    userId: 'alice',
    name: meta.id,
    storeName: storeNameFor(meta.id, 'prefix'),
    attributes: {
      ...encodeAttributes(meta, false, embedder),
      extra: { keep: [1, null, true] },
    },
  } satisfies RagCollectionRecord;
}

function row(id: string, metadata: RagMetadata = {}, text = id): RagScanRecord {
  return { id, text, metadata };
}

function ok<T>(value: T): Result<T, RagError> {
  return { ok: true, value };
}

function embedding(result: IEmbedResult = { vector: [1, 0] }) {
  const embedDocument = jest.fn(
    async (_text: string): Promise<IEmbedResult> => result,
  );
  return { embedDocument } satisfies IDocumentEmbedder;
}

type PrecomputedWrite = NonNullable<
  IRagBackendWriter['upsertManyPrecomputedRaw']
>;

function fixture(
  records: RagCollectionRecord[],
  pages: RagScanPage[],
  mode: 'bulk' | 'single' = 'bulk',
) {
  const events: string[] = [];
  const vectors = new Map<string, RagDocumentVectors>();
  const remaining = [...pages];
  const scan = jest.fn(async (..._args: Parameters<IRagScanner['scan']>) => {
    const page = remaining.shift();
    if (!page) throw new Error('Unexpected scan');
    return ok(page);
  });
  const upsertPrecomputedRaw = jest.fn(
    async (
      id: string,
      _text: string,
      vector: RagDocumentVectors,
      _metadata: RagMetadata,
    ) => {
      events.push(id);
      vectors.set(id, vector);
      return ok(undefined);
    },
  );
  const upsertManyPrecomputedRaw = jest.fn(
    async (items: Parameters<PrecomputedWrite>[0]) => {
      for (const { id, vector } of items) {
        events.push(id);
        vectors.set(id, vector);
      }
      return ok(undefined);
    },
  );
  const deleteByIdRaw = jest.fn(async (id: string) => ok(vectors.delete(id)));
  const writer: IRagBackendWriter = {
    upsertRaw: async () => {
      throw new Error('Unexpected raw upsert');
    },
    deleteByIdRaw,
    ...(mode === 'bulk'
      ? { upsertManyPrecomputedRaw }
      : { upsertPrecomputedRaw }),
  };
  const rag: IRag & IRagScanner = {
    scan,
    writer: () => writer,
    query: async () => ok([]),
    getById: async () => ok(null),
    healthCheck: async () => ok(undefined),
  };
  const editor: IRagEditor = {
    upsert: async () => {
      throw new Error('Unexpected editor upsert');
    },
    deleteById: deleteByIdRaw,
  };
  const openCollection = jest.fn(async (_record: RagCollectionRecord) =>
    ok({ rag, editor }),
  );
  const updateCollection = jest.fn(
    async (_storeName: string, _patch: RagCatalogPatch) => {
      events.push('catalog');
      return ok(undefined);
    },
  );
  const provider: IRagProvider & IRagCatalogUpdater = {
    name: 'test',
    kind: 'test',
    editable: true,
    supportedScopes: ['global', 'user'],
    createCollection: async () => {
      throw new Error('Unexpected create');
    },
    describeCollections: async () => ok({ records, rejected: [] }),
    openCollection,
    updateCollection,
  };
  const log = jest.fn((_: string) => {});
  const opts = {
    current,
    compatible: new Set([compatible]),
    embedder: embedding(),
    dimension,
    log,
  };
  return {
    provider,
    rag,
    opts,
    events,
    scan,
    vectors,
    openCollection,
    updateCollection,
    upsertManyPrecomputedRaw,
    upsertPrecomputedRaw,
    deleteByIdRaw,
  };
}

test('re-embeds stale records and stamps the registry catalog last', async () => {
  const record = registryRecord();
  const f = fixture(
    [record],
    [
      { records: [row('one', { userId: 'alice', ttl: 123 })], cursor: 'next' },
      { records: [row('two', { embedder: 'older' })] },
    ],
  );

  const result = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');

  expect(f.events).toEqual(['one', 'two', 'catalog']);
  expect(f.updateCollection).toHaveBeenCalledWith(record.storeName, {
    attributes: { ...record.attributes, embedder: current },
  });
  expect(f.upsertManyPrecomputedRaw).toHaveBeenNthCalledWith(1, [
    {
      id: 'one',
      text: 'one',
      vector: [[1, 0]],
      metadata: { userId: 'alice', ttl: 123, embedder: current },
    },
  ]);
  expect(f.scan).toHaveBeenLastCalledWith({ cursor: 'next' });
  expect(result.stores).toMatchObject([
    {
      storeName: record.storeName,
      action: 'reembedded',
      records: 2,
      fragments: 2,
    },
  ]);
  expect(f.opts.log).toHaveBeenCalledTimes(1);
});

test('skips records that already carry the current stamp after a partial run', async () => {
  const f = fixture(
    [registryRecord()],
    [
      { records: [row('finished', { embedder: current })], cursor: 'next' },
      { records: [row('pending')] },
    ],
  );
  const result = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');
  expect(
    f.opts.embedder.embedDocument.mock.calls.map(([text]) => text),
  ).toEqual(['dimension probe', 'pending']);
  expect(f.events).toEqual(['pending', 'catalog']);
  expect(result.stores).toMatchObject([{ action: 'reembedded', records: 1 }]);
});

test('persists compatible catalog and record hashes for a rerun without compatibility configured', async () => {
  const compatibleRecord = '444444444444';
  const existingAlias = '555555555555';
  const unused = '666666666666';
  const base = registryRecord(compatible);
  const record = {
    ...base,
    attributes: { ...base.attributes, embedderAliases: [existingAlias] },
  };
  const page = {
    records: [
      row('one'),
      row('two', { embedder: compatibleRecord }),
      row('three', { embedder: existingAlias }),
    ],
  };
  const f = fixture([record], [page]);

  const result = unwrap(
    await migrateEmbeddings(f.provider, {
      ...f.opts,
      compatible: new Set([current, compatible, compatibleRecord, unused]),
    }),
    'migrate',
  );

  expect(f.scan).toHaveBeenCalledTimes(1);
  expect(f.opts.embedder.embedDocument.mock.calls).toEqual([
    ['dimension probe'],
  ]);
  expect(f.events).toEqual(['catalog']);
  expect(result.stores).toMatchObject([
    { action: 'restamped', records: 0, fragments: 0 },
  ]);
  const [[, patch]] = f.updateCollection.mock.calls;
  expect(patch.attributes).toMatchObject({
    embedder: current,
    embedderAliases: [existingAlias, compatible, compatibleRecord],
  });
  const attributes = unwrap(
    validateRagAttributes(patch.attributes),
    'attributes',
  );
  const rerun = fixture([{ ...record, attributes }], [page]);
  const repeated = unwrap(
    await migrateEmbeddings(rerun.provider, {
      ...rerun.opts,
      compatible: new Set(),
    }),
    'rerun',
  );
  expect(repeated.stores).toMatchObject([{ action: 'current', records: 0 }]);
  expect(rerun.opts.embedder.embedDocument.mock.calls).toEqual([
    ['dimension probe'],
  ]);
  expect(rerun.events).toEqual([]);
});

test('re-embeds an explicit stale stamp even when the catalog is current', async () => {
  const f = fixture(
    [registryRecord(current)],
    [
      {
        records: [
          row('stale', { embedder: previous }),
          row('implicit'),
          row('compatible', { embedder: compatible }),
        ],
      },
    ],
  );

  const result = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');

  expect(f.events).toEqual(['stale', 'catalog']);
  expect(f.updateCollection.mock.calls[0][1].attributes).toMatchObject({
    embedder: current,
    embedderAliases: [compatible],
  });
  expect(result.stores).toMatchObject([{ action: 'reembedded', records: 1 }]);
});

test('skips task-results, unstamped registry collections and zero-vector hub stores', async () => {
  const f = fixture(
    [
      {
        ...registryRecord(),
        attributes: { collectionKind: 'task-results', embedder: previous },
      },
      { ...registryRecord(), attributes: { collectionKind: 'knowledge' } },
      ...['h_sessions', 'h_runs', 'h_trust', 'h_dialogue'].map(
        (name): RagCollectionRecord => ({
          name,
          storeName: `prefix_${name}`,
          scope: 'global',
          attributes: { embedder: previous },
        }),
      ),
    ],
    [],
  );

  expect(await migrateEmbeddings(f.provider, f.opts)).toEqual(
    ok({ stores: [], promptTokens: 0, tokensReported: false }),
  );
  expect(f.openCollection).not.toHaveBeenCalled();
});

test('migrates h_history through storeEmbedder and preserves its catalog attributes', async () => {
  const attributes = { writtenBy: 'cloud-llm-hub', source: 'history' };
  const record: RagCollectionRecord = {
    name: 'h_history',
    storeName: 'prefix_h_history',
    scope: 'global',
    attributes,
  };
  const f = fixture([record], [{ records: [row('turn')] }]);
  const history = embedding({ vector: [0, 1] });
  const storeEmbedder = jest.fn((_record: RagCollectionRecord) => history);

  unwrap(
    await migrateEmbeddings(f.provider, { ...f.opts, storeEmbedder }),
    'migrate',
  );

  expect(storeEmbedder).toHaveBeenCalledWith(record);
  expect(history.embedDocument).toHaveBeenCalledWith(
    'turn',
    expect.objectContaining({ preserveEmbeddingInput: true }),
  );
  expect(f.vectors.get('turn')).toEqual([[0, 1]]);
  expect(f.updateCollection).toHaveBeenCalledWith(record.storeName, {
    attributes: { ...attributes, embedder: current },
  });
});

test('fails on dimension mismatch before opening or writing any store', async () => {
  const f = fixture([registryRecord()], []);
  const result = await migrateEmbeddings(f.provider, {
    ...f.opts,
    embedder: embedding({ vector: [1, 0, 0] }),
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'EMBEDDER_DIMENSION_MISMATCH',
      message: 'embedder dimension 3 does not match the store dimension 2',
    },
  });
  expect(f.openCollection).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

test('migrates unstamped per-session history and stamps its catalog record', async () => {
  const sessionId = 's1';
  const name = historyCollectionName(sessionId);
  const record = {
    scope: 'session',
    sessionId,
    name,
    storeName: `prefix_${name}`,
    attributes: { writtenBy: 'cloud-llm-hub', source: 'session-history' },
  } satisfies RagCollectionRecord;
  const f = fixture([record], [{ records: [row('turn', { sessionId })] }]);

  const report = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');

  expect(report.stores).toMatchObject([
    { storeName: record.storeName, action: 'reembedded', records: 1 },
  ]);
  expect(f.upsertManyPrecomputedRaw).toHaveBeenCalledWith([
    {
      id: 'turn',
      text: 'turn',
      vector: [[1, 0]],
      metadata: { sessionId, embedder: current },
    },
  ]);
  expect(f.updateCollection).toHaveBeenCalledWith(record.storeName, {
    attributes: { ...record.attributes, embedder: current },
  });
  expect(f.events).toEqual(['turn', 'catalog']);
});

test('re-embeds stale and unstamped standalone planner records while preserving metadata', async () => {
  const name = 'prefix-planner-memory';
  const f = fixture(
    [],
    [
      {
        records: [
          row('missing', { namespace: 'owner' }),
          row('accepted', { embedder: compatible }),
        ],
        cursor: 'next',
      },
      {
        records: [
          row('stale', { embedder: previous, namespace: 'owner' }),
          row('current', { embedder: current }),
        ],
      },
    ],
  );

  const report = unwrap(
    await migrateStandaloneStore(f.rag, name, f.opts),
    'migrate',
  );

  expect(report.stores).toMatchObject([
    { storeName: name, action: 'reembedded', records: 2, fragments: 2 },
  ]);
  expect(f.scan.mock.calls).toEqual([[{}], [{ cursor: 'next' }]]);
  expect(f.upsertManyPrecomputedRaw.mock.calls).toEqual(
    ['missing', 'stale'].map((id) => [
      [
        {
          id,
          text: id,
          vector: [[1, 0]],
          metadata: { namespace: 'owner', embedder: current },
        },
      ],
    ]),
  );
  expect(f.events).toEqual(['missing', 'stale']);
});

test('checks standalone planner memory dimension before scanning or writing', async () => {
  const f = fixture([], []);
  const result = await migrateStandaloneStore(f.rag, 'prefix-planner-memory', {
    ...f.opts,
    dimension: 3,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'EMBEDDER_DIMENSION_MISMATCH' },
  });
  expect(f.scan).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

test('identifies the failing record and its error code after a page batch fails', async () => {
  const record = registryRecord();
  const f = fixture(
    [record],
    [{ records: [row('first'), row('broken'), row('later')] }],
  );
  const embedDocuments = jest.fn(async (_texts: string[]) => {
    throw new RagError('Batch embedding failed', 'EMBEDDING_BATCH_ERROR');
  });
  f.opts.embedder.embedDocument
    .mockResolvedValueOnce({ vector: [1, 0] })
    .mockResolvedValueOnce({ vector: [1, 0] })
    .mockRejectedValueOnce(
      new RagError('Embedding failed', 'EMBEDDING_CONTEXT_EXCEEDED'),
    );

  const result = await migrateEmbeddings(f.provider, {
    ...f.opts,
    embedder: { ...f.opts.embedder, embedDocuments },
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'EMBEDDING_CONTEXT_EXCEEDED',
      message: expect.stringContaining(`${record.storeName}/broken`),
    },
  });
  expect(embedDocuments.mock.calls.map(([texts]) => texts)).toEqual([
    ['first', 'broken', 'later'],
  ]);
  expect(
    f.opts.embedder.embedDocument.mock.calls.map(([text]) => text),
  ).toEqual(['dimension probe', 'first', 'broken']);
  expect(f.opts.log).toHaveBeenCalledWith(
    `Embedder migration ${record.storeName}/broken: EMBEDDING_CONTEXT_EXCEEDED`,
  );
  expect(f.events).toEqual([]);
});

test('fails with the original batch error even when all per-record diagnostics pass', async () => {
  const record = registryRecord();
  const f = fixture(
    [record],
    [{ records: [row('one'), row('two'), row('three')] }],
  );
  const embedDocuments = jest.fn(
    async (texts: string[]): Promise<IEmbedResult[]> => {
      if (texts.includes('three'))
        throw new RagError('Batch embedding failed', 'EMBEDDING_BATCH_ERROR');
      return texts.map(() => ({
        vector: [0, 1],
        usage: { promptTokens: 10, totalTokens: 10 },
      }));
    },
  );
  const embedder = { ...f.opts.embedder, embedDocuments, maxBatchSize: 2 };
  f.opts.embedder.embedDocument
    .mockResolvedValueOnce({
      vector: [1, 0],
      usage: { promptTokens: 2, totalTokens: 2 },
    })
    .mockResolvedValue({
      vector: [1, 0],
      usage: { promptTokens: 3, totalTokens: 3 },
    });

  const result = await migrateEmbeddings(f.provider, { ...f.opts, embedder });

  expect(embedDocuments.mock.calls.map(([texts]) => texts)).toEqual([
    ['one', 'two'],
    ['three'],
  ]);
  expect(
    f.opts.embedder.embedDocument.mock.calls.map(([text]) => text),
  ).toEqual(['dimension probe', 'one', 'two', 'three']);
  expect(f.events).toEqual([]);
  expect(f.vectors.size).toBe(0);
  expect(f.opts.log).toHaveBeenCalledWith(
    `Embedder migration ${record.storeName}: EMBEDDING_BATCH_ERROR`,
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'EMBEDDING_BATCH_ERROR',
      message: `${record.storeName}: Batch embedding failed`,
    },
  });
});

test('stops when a write fails and leaves the catalog unchanged', async () => {
  const record = registryRecord();
  const f = fixture(
    [record],
    [{ records: [row('one')], cursor: 'later' }],
    'single',
  );
  f.upsertPrecomputedRaw.mockResolvedValueOnce({
    ok: false,
    error: new RagError('Write failed', 'UPSERT_ERROR'),
  });

  expect(await migrateEmbeddings(f.provider, f.opts)).toMatchObject({
    ok: false,
    error: {
      code: 'UPSERT_ERROR',
      message: expect.stringContaining(`${record.storeName}/one`),
    },
  });
  expect(f.scan).toHaveBeenCalledTimes(1);
  expect(f.updateCollection).not.toHaveBeenCalled();
});

test('fails when the scanner repeats a cursor', async () => {
  const f = fixture(
    [registryRecord()],
    [
      { records: [], cursor: 'same' },
      { records: [], cursor: 'same' },
    ],
  );

  expect(await migrateEmbeddings(f.provider, f.opts)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('scan did not advance') },
  });
  expect(f.scan).toHaveBeenCalledTimes(2);
  expect(f.events).toEqual([]);
});

test('an empty catalog reports zero stores and never calls the embedder', async () => {
  const f = fixture([], []);
  expect(await migrateEmbeddings(f.provider, f.opts)).toEqual(
    ok({ stores: [], promptTokens: 0, tokensReported: false }),
  );
  expect(f.opts.embedder.embedDocument).not.toHaveBeenCalled();
});

test('an empty current store reports zero migrated records and fragments', async () => {
  const f = fixture([registryRecord(current)], [{ records: [] }]);
  const result = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');
  expect(result).toMatchObject({
    stores: [{ action: 'current', records: 0, fragments: 0 }],
    promptTokens: 0,
    tokensReported: false,
  });
  expect(f.events).toEqual([]);
});

test('sums only reported prompt tokens, including the dimension probe', async () => {
  const f = fixture(
    [registryRecord()],
    [{ records: [row('one'), row('two')] }],
  );
  f.opts.embedder.embedDocument
    .mockResolvedValueOnce({
      vector: [1, 0],
      usage: { promptTokens: 2, totalTokens: 200 },
    })
    .mockResolvedValueOnce({
      vector: [1, 0],
      usage: { promptTokens: 3, totalTokens: 300 },
    });

  const result = unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');
  expect(result).toMatchObject({ promptTokens: 5, tokensReported: true });
});

test('batches stale records once per page and preserves record and fragment order', async () => {
  const f = fixture(
    [registryRecord()],
    [
      {
        records: [
          row('one', {}, '1234'),
          row('current', { embedder: current }),
          row('two', {}, '56'),
        ],
        cursor: 'next',
      },
      { records: [row('three', {}, '78'), row('four', {}, '90')] },
    ],
  );
  const embedDocuments = jest.fn(
    async (texts: string[]): Promise<IEmbedResult[]> =>
      texts.map((text) => ({
        vector: [Number(text), 0],
        usage: { promptTokens: 0, totalTokens: 0 },
      })),
  );
  const embedder = {
    ...f.opts.embedder,
    getMaxInputChars: async () => 2,
    embedDocuments,
  };

  const result = unwrap(
    await migrateEmbeddings(f.provider, { ...f.opts, embedder }),
    'migrate',
  );

  expect(embedDocuments.mock.calls.map(([texts]) => texts)).toEqual([
    ['12', '34', '56'],
    ['78', '90'],
  ]);
  expect(f.opts.embedder.embedDocument.mock.calls).toEqual([
    ['dimension probe'],
  ]);
  expect(f.upsertManyPrecomputedRaw).toHaveBeenCalledTimes(2);
  expect([...f.vectors]).toEqual([
    [
      'one',
      [
        [12, 0],
        [34, 0],
      ],
    ],
    ['two', [[56, 0]]],
    ['three', [[78, 0]]],
    ['four', [[90, 0]]],
  ]);
  expect(result).toMatchObject({
    stores: [{ records: 4, fragments: 5 }],
    promptTokens: 0,
    tokensReported: true,
  });
});

test.each(['bulk', 'single'] as const)(
  'surplus fragments do not survive a %s replacement',
  async (mode) => {
    const f = fixture([registryRecord()], [{ records: [row('one')] }], mode);
    f.vectors.set('one', [
      [0, 1],
      [0, 1],
      [0, 1],
    ]);

    unwrap(await migrateEmbeddings(f.provider, f.opts), 'migrate');

    expect(f.vectors.get('one')).toEqual([[1, 0]]);
    expect(f.deleteByIdRaw).not.toHaveBeenCalled();
  },
);
