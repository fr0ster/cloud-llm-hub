const mockContext = { user: { id: 'alice', is: (_role: string) => false } };
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockContext;
      },
    },
  }),
  { virtual: true },
);

import {
  InMemoryRag,
  RagError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import { userCollectionId } from '../../srv/collection-ids';
import {
  deleteCollectionOverrides,
  setCollectionOverride,
} from '../../srv/lib/collection-toggle';
import { plannerContext } from '../../srv/lib/planner-context';
import * as policy from '../../srv/lib/record-policy';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { dispatchRagTool } from '../../srv/rag-tool-dispatcher';
import { runWithSessionId } from '../../srv/request-session';
import { makeMockRouter, makeReq, runIdRoute } from './helpers/rag-routes';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) });
const id = userCollectionId('records', 'alice');
async function setup(backend = 'in-memory') {
  const registry = new CollectionRegistry({ embedder });
  if (backend === 'qdrant')
    registry.registerBackend(
      'qdrant',
      ({ store }) =>
        new QdrantRag({
          url: 'http://qdrant.test',
          collectionName: store,
          embedder,
        }),
    );
  await registry.createCollection({
    id,
    logicalId: 'records',
    displayName: 'Records',
    description: '',
    scope: 'user',
    owner: 'alice',
    backend,
  });
  return registry;
}

beforeEach(() => {
  mockContext.user = { id: 'alice', is: () => false };
});
afterEach(() => jest.restoreAllMocks());

test.each(['in-memory', 'vector', 'qdrant'])(
  '%s stores and returns flag; retrieval fills k past disabled hits',
  async (backend) => {
    // A Qdrant wire fake retains payloads verbatim, as the service does.
    interface Point {
      id: string;
      vector: number[];
      payload: { text: string; enabled?: boolean; id: string };
    }
    const points = new Map<string, Point>();
    if (backend === 'qdrant')
      jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const path = String(input);
          const body: { points?: Point[]; ids?: string[]; limit?: number } =
            typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          if (init?.method === 'PUT' && path.endsWith('/points')) {
            for (const point of body.points ?? []) points.set(point.id, point);
          }
          const result = path.endsWith('/search')
            ? [...points.values()]
                .slice(0, body.limit)
                .map((point) => ({ ...point, score: 1 }))
            : (body.ids ?? []).flatMap((key) => {
                const point = points.get(key);
                return point ? [point] : [];
              });
          return new Response(JSON.stringify({ result }), { status: 200 });
        });
    const registry = await setup(backend);
    for (let i = 0; i < 48; i++)
      await registry.addDocument(id, {
        id: String(i),
        text: 'record knowledge',
        metadata: { enabled: i >= 45 },
      });
    const store = await registry.getRagStore(id);
    if (!store) throw new Error('missing store');
    const policySpy = jest.spyOn(policy, 'recordPolicy');
    const result = await store.query(new TextOnlyEmbedding('record'), 3);
    expect(policySpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      true,
    );
    expect(result.ok && result.value.length).toBe(3);
    expect(
      result.ok && result.value.every((hit) => hit.metadata.enabled !== false),
    ).toBe(true);
    expect((await registry.getDocument(id, '0'))?.enabled).toBe(false);
    expect((await registry.listDocuments(id))?.documents[0].enabled).toBe(
      false,
    );
    const raw = await store.getById(`doc:${id}:0`);
    expect(raw.ok && raw.value?.metadata.enabled).toBe(false);
    await registry.setDocumentEnabled(id, '0', true);
    expect((await registry.getDocument(id, '0'))?.enabled).toBe(true);
    const enabledRaw = await store.getById(`doc:${id}:0`);
    expect(enabledRaw.ok && enabledRaw.value?.metadata.enabled).toBe(true);
    await registry.setDocumentEnabled(id, '0', false);
    const planner = await plannerContext({
      memory: () => undefined,
      embedding: { retrieval: embedder, key: 'test' },
      names: [id],
      collection: (name) => registry.getRagStore(name),
      warn: jest.fn(),
    });
    policySpy.mockClear();
    const knowledge = await planner.plannerKnowledge?.[0].search(
      { text: 'record' },
      3,
    );
    expect(knowledge).toHaveLength(3);
    expect(policySpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      true,
    );
    expect(knowledge?.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([`doc:${id}:45`, `doc:${id}:46`, `doc:${id}:47`]),
    );
    // Three enabled records remain; the disabled front of the index is skipped.
    expect(result.ok && result.value.map((hit) => hit.metadata.id)).toEqual(
      expect.arrayContaining([`doc:${id}:45`, `doc:${id}:46`, `doc:${id}:47`]),
    );
  },
);

test('REST lists state, validates toggles, and changes all chunks of only one upload', async () => {
  const registry = await setup();
  for (const [key, uploadId] of [
    ['a', 'one'],
    ['b', 'one'],
    ['c', 'two'],
  ]) {
    await registry.addDocument(id, {
      id: key,
      text: key,
      metadata: { source: 'file.txt', uploadId, chunkIndex: 0 },
    });
  }
  const { router, routes } = makeMockRouter();
  registerRagRoutes(router, registry);
  const call = (
    path: string,
    body: { enabled: boolean | string; source?: string; uploadId?: string },
  ) =>
    runIdRoute(
      routes,
      'PATCH',
      `/rag/collections/:id/${path}`,
      makeReq({
        method: 'PATCH',
        path: `/${path}`,
        params: { id, did: 'a' },
        sessionId: 'reader-session',
        sessionMinted: false,
        body,
      }),
    );
  expect(
    (await call('documents/:did/enabled', { enabled: 'false' }))._status,
  ).toBe(400);
  expect(
    (
      await call('documents/enabled', {
        enabled: false,
        source: 'file.txt',
        uploadId: 'one',
      })
    )._body,
  ).toEqual({ updated: 2 });
  expect((await registry.getDocument(id, 'a'))?.enabled).toBe(false);
  expect((await registry.getDocument(id, 'b'))?.enabled).toBe(false);
  expect((await registry.getDocument(id, 'c'))?.enabled).toBe(true);
  const listed = await runIdRoute(
    routes,
    'GET',
    '/rag/collections/:id/documents',
    makeReq({ params: { id }, path: '/documents' }),
  );
  expect(listed._body).toMatchObject({
    documents: [
      { id: 'a', enabled: false },
      { id: 'b', enabled: false },
      { id: 'c', enabled: true },
    ],
  });
  expect(
    (await call('documents/:did/enabled', { enabled: true }))._body,
  ).toMatchObject({ enabled: true });
  mockContext.user = { id: 'reader', is: () => false };
  expect(
    (await call('documents/:did/enabled', { enabled: false }))._status,
  ).toBe(404);
  expect(
    (await call('documents/enabled', { enabled: false, source: 'file.txt' }))
      ._status,
  ).toBe(404);
  expect((await registry.getDocument(id, 'a'))?.enabled).toBe(true);
});

test('rag_list reports disabled state and rag_correct preserves it', async () => {
  const registry = await setup();
  await registry.addDocument(id, {
    id: 'a',
    text: 'old',
    metadata: { canonicalKey: 'key', enabled: false },
  });
  expect(
    await dispatchRagTool(registry, 'rag_list', { collection: 'records' }),
  ).toEqual({
    ok: true,
    total: 1,
    documents: [{ id: 'key', enabled: false, reason: 'record-disabled' }],
  });
  for (const recordId of ['key', 'a']) {
    expect(
      await dispatchRagTool(registry, 'rag_list', {
        collection: 'records',
        id: recordId,
      }),
    ).toEqual({
      ok: true,
      document: { id: 'key', enabled: false, reason: 'record-disabled' },
    });
  }
  expect(
    await dispatchRagTool(registry, 'rag_correct', {
      collection: 'records',
      id: 'key',
      newText: 'corrected',
      reason: 'fix',
    }),
  ).toEqual({ ok: true, id: 'key' });
  expect(await registry.getDocument(id, 'a')).toMatchObject({
    text: 'corrected',
    enabled: false,
  });
});

test('a rejected toggle leaves registry and backend state unchanged', async () => {
  const raw = new InMemoryRag();
  const registry = new CollectionRegistry();
  registry.registerBackend('rejecting', () => raw);
  await registry.createCollection({
    id,
    logicalId: 'records',
    displayName: 'Records',
    description: '',
    scope: 'user',
    owner: 'alice',
    backend: 'rejecting',
  });
  await registry.addDocument(id, { id: 'a', text: 'keep', metadata: {} });
  const writer = raw.writer();
  jest.spyOn(raw, 'writer').mockReturnValue({
    ...writer,
    upsertRaw: async () => ({
      ok: false,
      error: new RagError('write failed', 'UPSERT_ERROR'),
    }),
  });
  await expect(registry.setDocumentEnabled(id, 'a', false)).rejects.toThrow(
    'write failed',
  );
  expect((await registry.getDocument(id, 'a'))?.enabled).toBe(true);
  const stored = await raw.getById(`doc:${id}:a`);
  expect(stored.ok && stored.value?.metadata.enabled).toBeUndefined();
});

test('all-disabled retrieval terminates, tags stay inactive, and legacy source toggles work', async () => {
  const registry = await setup();
  for (let i = 0; i < 25; i++)
    await registry.addDocument(id, {
      id: String(i),
      text: 'record',
      metadata: { source: 'legacy.txt', chunkIndex: i, enabled: false },
    });
  const store = await registry.getRagStore(id);
  if (!store) throw new Error('missing store');
  const empty = await store.query(new TextOnlyEmbedding('record'), 3);
  expect(empty.ok && empty.value).toEqual([]);
  expect(await registry.setSourceEnabled(id, 'legacy.txt', '', true)).toEqual({
    updated: 25,
  });
  await registry.updateDocument(id, '0', {
    metadata: { tags: ['deprecated'] },
  });
  await registry.updateDocument(id, '1', {
    metadata: { tags: ['superseded'] },
  });
  const active = await store.query(new TextOnlyEmbedding('record'), 25);
  expect(active.ok && active.value).toHaveLength(23);
});

test('rag_list hides content in both modes for a disabled collection and respects session overrides', async () => {
  const registry = await setup();
  await registry.addDocument(id, {
    id: 'a',
    text: 'Private title\nPrivate body',
    metadata: { canonicalKey: 'key', tags: ['private-tag'] },
  });
  await registry.setEnabled('alice', id, false);
  const hidden = { id: 'key', enabled: true, reason: 'collection-disabled' };
  expect(
    await dispatchRagTool(registry, 'rag_list', { collection: 'records' }),
  ).toEqual({ ok: true, total: 1, documents: [hidden] });
  expect(
    await dispatchRagTool(registry, 'rag_list', {
      collection: 'records',
      id: 'key',
    }),
  ).toEqual({ ok: true, document: hidden });
  setCollectionOverride('alice', 'policy-session', id, true);
  try {
    const visible = await runWithSessionId('policy-session', () =>
      dispatchRagTool(registry, 'rag_list', {
        collection: 'records',
        id: 'key',
      }),
    );
    expect(visible).toMatchObject({
      ok: true,
      document: { text: 'Private title\nPrivate body' },
    });
    await registry.setEnabled('alice', id, true);
    setCollectionOverride('alice', 'policy-session', id, false);
    expect(
      await runWithSessionId('policy-session', () =>
        dispatchRagTool(registry, 'rag_list', { collection: 'records' }),
      ),
    ).toEqual({ ok: true, total: 1, documents: [hidden] });
    expect(
      await runWithSessionId('policy-session', () =>
        dispatchRagTool(registry, 'rag_list', {
          collection: 'records',
          id: 'a',
        }),
      ),
    ).toEqual({ ok: true, document: hidden });
  } finally {
    deleteCollectionOverrides('alice', 'policy-session');
  }
  expect(
    await dispatchRagTool(registry, 'rag_deprecate', {
      collection: 'records',
      id: 'key',
      reason: 'retire',
    }),
  ).toEqual({ ok: true, id: 'key', reason: 'retire' });
});
