import {
  InMemoryRag,
  type IRagCatalogUpdater,
  type IRagEditor,
  type IRagProvider,
  type RagCollectionRecord,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import {
  addPersistentDocument,
  createCollectionPersistence,
  deletePersistentDocument,
  type PersistentEntry,
  storeNameFor,
  updatePersistentDocument,
} from '../../srv/lib/collection-persistence';
import { CollectionRegistry } from '../../srv/rag-collections';

function fixture() {
  const record = (id: string): RagCollectionRecord => ({
    storeName: storeNameFor(id),
    name: id,
    scope: 'global',
    attributes: {
      writtenBy: 'cloud-llm-hub',
      collectionId: id,
      logicalId: id,
      collectionKind: 'agents',
      embedder: 'fp',
      hubOwner: { userId: '' },
    },
  });
  const rag = new InMemoryRag();
  const scan = jest.spyOn(rag, 'scan');
  const records = [record('unrelated'), record('agents')];
  const stores = new Map<string, InMemoryRag>(
    records.map((entry) => [entry.storeName, rag]),
  );
  const editor = (store: InMemoryRag): IRagEditor => ({
    upsert: async (text, metadata) => {
      const { id, ...attributes } = metadata;
      if (typeof id !== 'string') throw new Error('Missing id');
      const result = await store.writer().upsertRaw(id, text, attributes);
      return result.ok ? { ok: true, value: { id } } : result;
    },
    deleteById: (id) => store.writer().deleteByIdRaw(id),
  });
  const provider: IRagProvider & IRagCatalogUpdater = {
    name: 'test',
    kind: 'vector',
    editable: true,
    supportedScopes: ['global'],
    createCollection: async (storeName, options) => {
      const store = new InMemoryRag();
      stores.set(storeName, store);
      records.push({
        storeName,
        name: options.collectionName ?? storeName,
        ...options,
      });
      return { ok: true, value: { rag: store, editor: editor(store) } };
    },
    deleteCollection: async (storeName) => {
      const index = records.findIndex((entry) => entry.storeName === storeName);
      if (index >= 0) records.splice(index, 1);
      stores.delete(storeName);
      return { ok: true, value: undefined };
    },
    updateCollection: async (storeName, update) => {
      const entry = records.find((item) => item.storeName === storeName);
      if (!entry) throw new Error('Missing catalog entry');
      Object.assign(entry, update);
      return { ok: true, value: undefined };
    },
    describeCollections: async () => ({
      ok: true,
      value: { records, rejected: [] },
    }),
    openCollection: async (entry) => {
      const store = stores.get(entry.storeName);
      if (!store) throw new Error('Missing store');
      return { ok: true, value: { rag: store, editor: editor(store) } };
    },
  };
  const persistence = createCollectionPersistence(provider, 'fp');
  const registry = new CollectionRegistry({ persistence });
  return { provider, persistence, registry, scan, rag, records };
}

test('authoritative registry reads open and paginate only the requested collection', async () => {
  const { registry, provider, scan } = fixture();
  const open = jest.spyOn(provider, 'openCollection');
  scan.mockClear();
  scan.mockResolvedValueOnce({
    ok: true,
    value: { records: [], cursor: 'next' },
  });
  scan.mockResolvedValueOnce({ ok: true, value: { records: [] } });
  const controller = new AbortController();
  const options = { signal: controller.signal };
  expect((await registry.readAgentCollection('agents', options))?.meta.id).toBe(
    'agents',
  );
  expect(open.mock.calls.map(([record]) => record.storeName)).toEqual([
    storeNameFor('agents'),
  ]);
  expect(scan.mock.calls).toEqual([
    [{}, options],
    [{ cursor: 'next' }, options],
  ]);
});

test.each(['catalogue', 'open'] as const)(
  'cancellation stops a blocked %s read',
  async (stage) => {
    const { registry, provider } = fixture();
    await registry.ready;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (stage === 'catalogue')
      jest.spyOn(provider, 'describeCollections').mockImplementation(() => {
        entered();
        return new Promise(() => {});
      });
    else
      jest.spyOn(provider, 'openCollection').mockImplementation(() => {
        entered();
        return new Promise(() => {});
      });
    const controller = new AbortController();
    const pending = registry.readAgentCollection('agents', {
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
  },
);

const profile = {
  id: 'analyst',
  text: 'original',
  metadata: {
    canonicalKey: 'analyst',
    name: 'analyst',
    kind: 'profile',
    description: 'Analysis',
    tools: 'read-only',
    result: 'report',
    enabled: true,
  },
};

test('agents writes invalidate their record and all generic reads stay authoritative', async () => {
  const { registry, rag } = fixture();
  await registry.ready;
  await registry.createAgentRecord('agents', profile);
  expect((await registry.getDocument('agents', 'analyst'))?.text).toBe(
    'original',
  );
  expect((await registry.listDocuments('agents'))?.total).toBe(1);
  const write = await rag.writer().upsertRaw('doc:agents:analyst', 'external', {
    ...profile.metadata,
    id: 'analyst',
  });
  expect(write.ok).toBe(true);
  await registry.setDocumentEnabled('agents', 'analyst', false);
  expect((await registry.getDocument('agents', 'analyst'))?.text).toBe(
    'external',
  );
  expect(
    (await registry.getDocument('agents', 'analyst'))?.metadata.enabled,
  ).toBe(false);
  await registry.updateDocument('agents', 'analyst', { text: 'replacement' });
  expect((await registry.listDocuments('agents'))?.documents[0]?.text).toBe(
    'replacement',
  );
  await registry.addDocumentsBulk('agents', [{ ...profile, text: 'bulk' }]);
  expect(
    (await registry.findActiveByCanonicalKey('agents', 'analyst'))?.text,
  ).toBe('bulk');
  await registry.deleteDocument('agents', 'analyst');
  expect(await registry.getDocument('agents', 'analyst')).toBeNull();
  expect((await registry.listDocuments('agents'))?.total).toBe(0);
  expect(await registry.deleteDocument('agents', 'analyst')).toBe(false);
});

test.each(['create', 'replace', 'partial', 'delete'] as const)(
  '%s drops only the written agents record after successful and uncertain writes',
  async (operation) => {
    for (const failed of [false, true]) {
      const upsert = jest
        .fn<
          ReturnType<PersistentEntry['rag']['upsert']>,
          Parameters<PersistentEntry['rag']['upsert']>
        >()
        .mockImplementation(async () =>
          failed
            ? { ok: false, error: new RagError('after write', 'TEST') }
            : { ok: true, value: { id: 'analyst' } },
        );
      const deleteById = jest
        .fn<
          ReturnType<PersistentEntry['rag']['deleteById']>,
          Parameters<PersistentEntry['rag']['deleteById']>
        >()
        .mockImplementation(async () =>
          failed
            ? { ok: false, error: new RagError('after delete', 'TEST') }
            : { ok: true, value: true },
        );
      const authoritative = {
        ...profile,
        text: 'authoritative',
        createdAt: '',
      };
      const entry: PersistentEntry = {
        meta: {
          id: 'agents',
          logicalId: 'agents',
          displayName: '',
          description: '',
          scope: 'global',
          collectionKind: 'agents',
          createdAt: '',
          documentCount: 2,
          sourceCount: 0,
        },
        documents: new Map([
          ['analyst', { ...profile, text: 'stale', createdAt: '' }],
          ['other', { ...profile, id: 'other', createdAt: '' }],
        ]),
        rag: { upsert, deleteById },
      };
      const write =
        operation === 'delete'
          ? deletePersistentDocument(entry, 'analyst')
          : operation === 'partial'
            ? updatePersistentDocument(entry, authoritative, {
                metadata: { enabled: false },
              })
            : addPersistentDocument(entry, { ...profile, text: 'new' });
      if (failed) await expect(write).rejects.toThrow();
      else await write;
      expect(entry.documents.has('analyst')).toBe(false);
      expect([...entry.documents.keys()]).toEqual(['other']);
      expect(entry.documents.get('other')?.text).toBe('original');
      if (operation === 'partial')
        expect(upsert.mock.calls[0]?.[0]).toBe('authoritative');
    }
  },
);

test('startup seeds are immediately visible through generic agents listing', async () => {
  const { registry } = fixture();
  await registry.seedAgentConfiguration('agents', 'planner');
  expect(
    (await registry.listDocuments('agents'))?.total,
  ).toBeGreaterThanOrEqual(5);
  expect((await registry.getDocument('agents', 'planner'))?.metadata.kind).toBe(
    'planner',
  );
});

test('persistent copies read current source data and remain fresh through writes and collection deletion', async () => {
  const { registry, rag, provider } = fixture();
  await registry.ready;
  await registry.addDocument('agents', profile);
  await rag
    .writer()
    .upsertRaw('doc:agents:analyst', 'external source', profile.metadata);
  await registry.copyAgentCollection('agents', {
    id: 'own',
    logicalId: 'own',
    displayName: 'Own',
    description: '',
    scope: 'user',
    owner: 'alice',
    collectionKind: 'agents',
  });
  expect((await registry.getDocument('own', 'analyst'))?.text).toBe(
    'external source',
  );
  await registry.setDocumentEnabled('own', 'analyst', false);
  expect((await registry.getDocument('own', 'analyst'))?.enabled).toBe(false);
  await registry.updateDocument('own', 'analyst', { text: 'own edit' });
  expect((await registry.listDocuments('own'))?.documents[0]?.text).toBe(
    'own edit',
  );
  expect((await registry.getDocument('agents', 'analyst'))?.text).toBe(
    'external source',
  );
  const remove = provider.deleteCollection;
  if (!remove) throw new Error('Missing delete');
  jest.spyOn(provider, 'deleteCollection').mockImplementation(async (id) => {
    await remove(id);
    throw new Error('uncertain deletion');
  });
  await expect(registry.deleteCollection('own')).rejects.toThrow();
  expect(await registry.getCollection('own')).toBeNull();
  expect(await registry.listDocuments('own')).toBeNull();
  expect(
    (await registry.listCollections('alice')).some((meta) => meta.id === 'own'),
  ).toBe(false);
});

test('collection partial updates preserve out-of-band agents catalog changes', async () => {
  const { registry, records } = fixture();
  await registry.ready;
  const entry = records.find((record) => record.name === 'agents');
  if (!entry) throw new Error('Missing catalog entry');
  const attributes = entry.attributes;
  if (
    !attributes ||
    typeof attributes !== 'object' ||
    Array.isArray(attributes)
  )
    throw new Error('Invalid attributes');
  const index = records.indexOf(entry);
  records[index] = {
    ...entry,
    attributes: {
      ...attributes,
      description: 'external description',
      displayName: 'external name',
    },
  };
  await registry.updateCollection('agents', { displayName: 'new name' });
  expect((await registry.getCollection('agents'))?.description).toBe(
    'external description',
  );
  records[index] = {
    ...entry,
    attributes: { ...attributes, description: 'latest description' },
  };
  await registry.setEnabled('alice', 'agents', false);
  expect((await registry.getCollection('agents'))?.description).toBe(
    'latest description',
  );
});

test.each([
  'create',
  'replace',
  'partial',
  'enable',
  'delete',
  'bulk',
  'seed',
  'catalog',
  'collection-enable',
] as const)(
  '%s preserves unrelated cached agents records and reads current state',
  async (operation) => {
    const { registry } = fixture();
    await registry.ready;
    await registry.addDocument('agents', profile);
    const stored = registry['collections'].get('agents');
    if (!stored) throw new Error('Missing collection');
    const other = { ...profile, id: 'other', createdAt: '' };
    stored.documents.set('other', other);
    stored.documents.set('analyst', {
      ...profile,
      text: 'stale',
      createdAt: '',
    });
    if (operation === 'create')
      await registry.createAgentRecord('agents', {
        ...profile,
        id: 'new',
        metadata: { ...profile.metadata, name: 'new', canonicalKey: 'new' },
      });
    else if (operation === 'replace')
      await registry.addDocument('agents', { ...profile, text: 'new' });
    else if (operation === 'partial')
      await registry.updateDocument('agents', 'analyst', { text: 'new' });
    else if (operation === 'enable')
      await registry.setDocumentEnabled('agents', 'analyst', false);
    else if (operation === 'delete')
      await registry.deleteDocument('agents', 'analyst');
    else if (operation === 'bulk')
      await registry.addDocumentsBulk('agents', [
        { ...profile, text: 'new' },
        {
          ...profile,
          id: 'new',
          metadata: { ...profile.metadata, name: 'new', canonicalKey: 'new' },
        },
      ]);
    else if (operation === 'seed')
      await registry.seedAgentConfiguration('agents', 'planner');
    else if (operation === 'catalog')
      await registry.updateCollection('agents', { displayName: 'New' });
    else await registry.setEnabled('alice', 'agents', false);
    expect(stored.documents.get('other')).toBe(other);
    const writesAnalyst = [
      'replace',
      'partial',
      'enable',
      'delete',
      'bulk',
    ].includes(operation);
    expect(stored.documents.has('analyst')).toBe(!writesAnalyst);
    expect(stored.documents.has('new')).toBe(false);
    const current = await registry.getDocument('agents', 'analyst');
    if (operation === 'delete') expect(current).toBeNull();
    else {
      expect(current?.text).toBe(
        ['replace', 'partial', 'bulk'].includes(operation) ? 'new' : 'original',
      );
      if (operation === 'enable') expect(current?.enabled).toBe(false);
    }
  },
);
