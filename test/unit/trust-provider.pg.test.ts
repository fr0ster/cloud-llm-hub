jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {},
    },
  }),
  { virtual: true },
);

import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import { userCollectionId } from '../../srv/collection-ids';
import {
  createCollectionPersistence,
  storeNameFor,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
import { setRagTrust } from '../../srv/lib/rag-write-operations';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import { CollectionRegistry } from '../../srv/rag-collections';
import { type PgliteHandle, startPglite } from './helpers/pglite';

jest.setTimeout(120_000);

const DIM = 8;

/** Writes never embed; the registry below needs an embedder for its own use. */
const embedder = symmetricEmbedder({
  embed: async () => {
    return { vector: [1, 0, 0, 0, 0, 0, 0, 0] };
  },
});

type PgClient = Awaited<ReturnType<typeof createPgClient>>;
let pgl: PgliteHandle;
let real: PgClient;
const client: PgClient = {
  query: (sql, params) => real.query(sql, params),
  end: async () => {},
};

function newProvider(): PgVectorRagProvider {
  return new PgVectorRagProvider({
    name: 'hub-collections',
    embedder,
    connection: {
      collectionName: 'hub-collections',
      dimension: DIM,
      schema: pgl.schema,
      layout: 'shared',
    },
    layout: 'shared',
    clientFactory: () => client,
  });
}

beforeAll(async () => {
  pgl = await startPglite({ dimension: DIM });
  real = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'hub-collections',
    poolMax: 4,
  });
});
afterAll(async () => {
  await real?.end();
  await pgl?.stop();
});
function newRegistry(provider = newProvider()) {
  const registry = new CollectionRegistry({
    embedder,
    defaultBackend: 'pg-vector',
    persistence: createCollectionPersistence(provider, 'fp'),
  });
  registry.trustResolver = new TrustResolver(
    registry,
    undefined,
    parseTrustDefaults(undefined),
  );
  return registry;
}

test('admin setters persist bounded history and clearing across registry restarts', async () => {
  let registry = newRegistry();
  const id = 'trust-setters-global';
  const identity = { userId: 'alice', admin: true };
  await registry.createCollection({
    id,
    logicalId: id,
    displayName: id,
    description: '',
    scope: 'global',
  });
  for (const record of ['changed', 'sibling'])
    await registry.addDocument(id, { id: record, text: record, metadata: {} });
  for (let index = 0; index < 22; index++) {
    await setRagTrust(registry, id, { trust: index % 5 }, identity);
    await setRagTrust(
      registry,
      id,
      { record: 'changed', trust: index % 5 },
      identity,
    );
  }
  registry = newRegistry();
  await registry.restore();
  expect(await registry.getCollection(id)).toMatchObject({
    trust: 1,
    trustHistory: expect.arrayContaining([
      expect.objectContaining({ actor: 'alice' }),
    ]),
  });
  expect((await registry.getCollection(id))?.trustHistory).toHaveLength(20);
  expect(
    (await registry.getDocument(id, 'changed'))?.metadata._trustHistory,
  ).toHaveLength(20);
  expect(
    (await registry.getDocument(id, 'sibling'))?.metadata._trustHistory,
  ).toBeUndefined();
  await setRagTrust(registry, id, { record: 'changed', trust: null }, identity);
  registry = newRegistry();
  await registry.restore();
  const cleared = await registry.getDocument(id, 'changed');
  expect(cleared?.metadata._trust).toBeUndefined();
  expect(cleared).toMatchObject({
    trust: 1,
    metadata: {
      _trustHistory: expect.arrayContaining([
        expect.objectContaining({ from: 1, to: null, actor: 'alice' }),
      ]),
    },
  });
  expect(cleared).not.toHaveProperty('trustOverride');
});
test('PGlite source/record/history survive restart and trust store survives sweep', async () => {
  const store = await TrustStore.open(newProvider(), DIM);
  await store.setSource('skills', 4, 'admin');
  await store.setRecord('skills', 'first', 1.5, 'admin');
  const resolver = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
  );
  expect(await resolver.skill('first')).toBe(1.5);
  expect(await resolver.skill('sibling')).toBe(4);
  await store.setRecord('skills', 'first', null, 'admin');
  expect(await resolver.skill('first')).toBe(4);
  for (let index = 0; index < 25; index++)
    await store.setSource('skills', index % 5, 'admin');
  const persistence = createCollectionPersistence(newProvider(), 'fp');
  const restored = await persistence.restore();
  expect(restored.ok).toBe(true);
  if (restored.ok) expect(restored.value.foreign).not.toContain('h_trust');
  const expired = await persistence.expiredSessions(Date.now());
  expect(expired).toEqual({ ok: true, value: [] });
  await real.end();
  await pgl.restart();
  real = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'hub-collections',
    poolMax: 4,
  });
  const reopened = await TrustStore.open(newProvider(), DIM);
  expect(await reopened.getSource('skills')).toBe(4);
  expect(await reopened.getSourceHistory('skills')).toHaveLength(20);
  expect(await reopened.getRecordHistory('skills', 'first')).toEqual([
    expect.objectContaining({ from: null, to: 1.5, actor: 'admin' }),
    expect.objectContaining({ from: 1.5, to: null, actor: 'admin' }),
  ]);
});
test('catalog and record trust persist, spoofed metadata is stripped, content replacement preserves override', async () => {
  const provider = newProvider();
  let registry = newRegistry(provider);
  const id = userCollectionId('trust-notes', 'alice');
  const history = Array.from({ length: 25 }, (_, index) => ({
    from: null,
    to: index % 5,
    actor: 'admin',
    at: String(index),
  }));
  await registry.createCollection({
    id,
    logicalId: 'trust-notes',
    displayName: 'Trust Notes',
    description: '',
    scope: 'user',
    owner: 'alice',
    trust: 4,
    trustHistory: history,
  });
  const spoof = {
    source: 'file.txt',
    trust: 5,
    trustHistory: [],
    _trust: 5,
    _trustHistory: [],
  };
  await registry.addDocument(id, {
    id: 'a',
    text: 'original',
    metadata: spoof,
  });
  await registry.addDocumentsBulk(id, [
    { id: 'b', text: 'bulk', metadata: spoof },
  ]);
  expect((await registry.getDocument(id, 'a'))?.metadata).toEqual({
    source: 'file.txt',
  });
  expect((await registry.getDocument(id, 'b'))?.metadata).toEqual({
    source: 'file.txt',
  });
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  const record = catalog.value.records.find(
    (entry) => entry.storeName === storeNameFor(id),
  );
  if (!record) throw new Error('missing collection');
  const opened = await provider.openCollection(record);
  if (!opened.ok) throw opened.error;
  const writer = opened.value.rag.writer?.();
  if (!writer?.upsertPrecomputedRaw) throw new Error('missing writer');
  const write = await writer.upsertPrecomputedRaw(
    `doc:${id}:a`,
    'original',
    [1, 0, 0, 0, 0, 0, 0, 0],
    {
      collectionId: id,
      docId: 'a',
      createdAt: '',
      source: 'file.txt',
      _trust: 1.5,
      _trustHistory: history,
    },
  );
  if (!write.ok) throw write.error;
  registry = newRegistry();
  await registry.restore();
  expect(await registry.getCollection(id)).toMatchObject({
    trust: 4,
    trustHistory: history.slice(-20),
  });
  expect(await registry.getDocument(id, 'a')).toMatchObject({
    trust: 1.5,
    trustOverride: 1.5,
    source: 'user:Trust Notes/a',
  });
  await registry.updateDocument(id, 'a', { text: 'updated', metadata: spoof });
  await registry.addDocument(id, {
    id: 'a',
    text: 'replacement',
    metadata: spoof,
  });
  registry = newRegistry();
  await registry.restore();
  expect(await registry.getDocument(id, 'a')).toMatchObject({
    text: 'replacement',
    trust: 1.5,
    metadata: {
      source: 'file.txt',
      _trust: 1.5,
      _trustHistory: history.slice(-20),
    },
  });
});

test('agent maps survive global and user-copy writes and restoration without becoming record trust', async () => {
  let registry = newRegistry();
  await registry.seedAgentConfiguration('agents', 'coordinator');
  const global = await registry.getDocument('agents', 'executor');
  if (!global) throw new Error('missing executor');
  const metadata = { ...global.metadata, trust: { user: 4, docs: 2 } };
  await registry.updateDocument('agents', 'executor', { metadata });
  const copyId = userCollectionId('my-agents', 'alice');
  await registry.copyAgentCollection('agents', {
    id: copyId,
    logicalId: 'my-agents',
    displayName: 'My Agents',
    description: '',
    scope: 'user',
    owner: 'alice',
    collectionKind: 'agents',
  });
  await registry.updateDocument(copyId, 'executor', {
    text: 'custom',
    metadata: { ...metadata, trust: { user: 1 } },
  });
  registry = newRegistry();
  await registry.restore();
  expect(await registry.getDocument('agents', 'executor')).toMatchObject({
    trusted: false,
    metadata: { trust: { user: 4, docs: 2 } },
  });
  const copy = await registry.getDocument(copyId, 'executor');
  expect(copy).toMatchObject({
    trusted: false,
    text: 'custom',
    metadata: { trust: { user: 1 } },
  });
  expect(copy).not.toHaveProperty('trust');
  expect(copy).not.toHaveProperty('source');
});
test('old collections inherit defaults without a write on read', async () => {
  const provider = newProvider();
  let registry = newRegistry(provider);
  const id = userCollectionId('legacy-notes', 'alice');
  await registry.createCollection({
    id,
    logicalId: 'legacy-notes',
    displayName: 'Legacy',
    description: '',
    scope: 'user',
    owner: 'alice',
  });
  await registry.addDocument(id, { id: 'r', text: 'old', metadata: {} });
  registry = newRegistry();
  await registry.restore();
  expect((await registry.getCollection(id))?.trust).toBeUndefined();
  expect(await registry.getDocument(id, 'r')).toMatchObject({
    trust: 3.5,
    source: 'user:Legacy/r',
  });
  const rows = await provider.describeCollections();
  if (!rows.ok) throw rows.error;
  expect(
    rows.value.records.find((row) => row.storeName === storeNameFor(id))
      ?.attributes,
  ).not.toHaveProperty('trust');
});
