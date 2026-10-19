/**
 * The collection registry over a real PgVectorRagProvider (shared layout) on
 * PGlite: lifecycle, backend-first document mutations, isolation of two users
 * with the same logical id, the request `backend` check and presets.
 */
const mockCdsContext: { user?: { id: string; is?: () => boolean } } = {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
}));

import {
  type IRag,
  type RagCollectionRecord,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import { userCollectionId } from '../../srv/collection-ids';
import {
  CollectionBackendError,
  createCollectionPersistence,
  storeNameFor,
} from '../../srv/lib/collection-persistence';
import { ensurePresets, presetCollectionId } from '../../srv/presets';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { dispatchRagTool } from '../../srv/rag-tool-dispatcher';
import { type PgliteHandle, startPglite } from './helpers/pglite';
import {
  findRoute,
  makeMockRouter,
  makeReq,
  makeRes,
  runIdRoute,
} from './helpers/rag-routes';

jest.setTimeout(120_000);

const DIM = 8;

type PgClient = Awaited<ReturnType<typeof createPgClient>>;

/** Deterministic bag-of-words vector; "EMBED_FAIL" in a text makes it throw. */
function vectorOf(text: string): number[] {
  const v: number[] = Array.from({ length: DIM }, () => 0);
  for (const w of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const embedder = symmetricEmbedder({
  embed: async (text: string) => {
    if (text.includes('EMBED_FAIL')) throw new Error('embedder unavailable');
    return { vector: vectorOf(text) };
  },
});

let pgl: PgliteHandle;
let real: PgClient;
/** While true every statement fails, as against an unreachable database. */
let down = false;
/** While set, every statement waits for it: a slow backend. */
let gate: Promise<void> | undefined;
const client: PgClient = {
  query: async (sql, params) => {
    if (gate) await gate;
    if (down) throw new Error('connect ECONNREFUSED (backend down)');
    return real.query(sql, params);
  },
  end: async () => {},
};

/** Hold every statement until the returned release is called. */
function holdBackend(): () => void {
  let release = () => {};
  gate = new Promise<void>((r) => {
    release = () => {
      gate = undefined;
      r();
    };
  });
  return release;
}

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

let provider: PgVectorRagProvider;
let reg: CollectionRegistry;

function newRegistry(p = provider): CollectionRegistry {
  return new CollectionRegistry({
    embedder,
    defaultBackend: 'pg-vector',
    persistence: createCollectionPersistence(p, 'fp-test'),
  });
}

async function records(): Promise<RagCollectionRecord[]> {
  const d = await provider.describeCollections();
  if (!d.ok) throw d.error;
  return [...d.value.records];
}

async function recordOf(id: string): Promise<RagCollectionRecord | undefined> {
  return (await records()).find((r) => r.storeName === storeNameFor(id));
}

/** A fresh handle on the stored collection: what a restart would read. */
async function backendDoc(id: string, docId: string) {
  const rec = await recordOf(id);
  if (!rec) throw new Error(`no record for ${id}`);
  const opened = await provider.openCollection(rec);
  if (!opened.ok) throw opened.error;
  const got = await opened.value.rag.getById(`doc:${id}:${docId}`);
  if (!got.ok) throw got.error;
  return got.value;
}

async function search(rag: IRag | null, text: string): Promise<string[]> {
  if (!rag) throw new Error('no store');
  const r = await rag.query(new TextOnlyEmbedding(text), 5);
  if (!r.ok) throw r.error;
  return r.value.map((x) => x.text);
}

function userMeta(logical: string, owner: string) {
  return {
    id: userCollectionId(logical, owner),
    logicalId: logical,
    displayName: logical,
    description: '',
    scope: 'user' as const,
    owner,
  };
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

beforeEach(async () => {
  down = false;
  gate = undefined;
  await real.query(
    `TRUNCATE "${pgl.schema}"."rag_documents", "${pgl.schema}"."rag_collections"`,
  );
  provider = newProvider();
  reg = newRegistry();
});

describe('lifecycle on the provider catalog', () => {
  it('create, add, query, update, delete, rename, disable, delete collection', async () => {
    const meta = userMeta('notes', 'alice');
    const created = await reg.createCollection(meta);
    expect(created.backend).toBe('pg-vector');

    // create: one record under the deterministic store name, owned by alice
    const rec = await recordOf(meta.id);
    expect(rec).toMatchObject({
      storeName: storeNameFor(meta.id),
      scope: 'user',
      userId: 'alice',
    });
    expect(rec?.attributes).toMatchObject({
      writtenBy: 'cloud-llm-hub',
      collectionId: meta.id,
      logicalId: 'notes',
      enabled: true,
      embedder: 'fp-test',
      hubOwner: { userId: 'alice' },
    });

    // add: in the backend with its identity, then in memory
    const doc = await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'kangaroo jumps over the fence',
      metadata: { tag: 'animals' },
    });
    const stored = await backendDoc(meta.id, 'd1');
    expect(stored?.text).toBe('kangaroo jumps over the fence');
    expect(stored?.metadata).toMatchObject({
      tag: 'animals',
      collectionId: meta.id,
      docId: 'd1',
      createdAt: doc.createdAt,
    });
    expect(reg.getCollection(meta.id)?.documentCount).toBe(1);

    // query
    await reg.addDocument(meta.id, {
      id: 'd2',
      text: 'quantum physics lecture',
      metadata: {},
    });
    const hits = await search(reg.getRagStore(meta.id), 'kangaroo fence');
    expect(hits[0]).toBe('kangaroo jumps over the fence');

    // update
    await reg.updateDocument(meta.id, 'd1', { text: 'wombat digs a burrow' });
    expect((await backendDoc(meta.id, 'd1'))?.text).toBe(
      'wombat digs a burrow',
    );
    expect(reg.getDocument(meta.id, 'd1')?.text).toBe('wombat digs a burrow');
    expect((await backendDoc(meta.id, 'd1'))?.metadata).toMatchObject({
      createdAt: doc.createdAt,
    });

    // delete a document
    expect(await reg.deleteDocument(meta.id, 'd2')).toBe(true);
    expect(await backendDoc(meta.id, 'd2')).toBeNull();
    expect(reg.getDocument(meta.id, 'd2')).toBeNull();

    // rename
    await reg.updateCollection(meta.id, {
      displayName: 'My notes',
      description: 'mine',
    });
    expect((await recordOf(meta.id))?.attributes).toMatchObject({
      displayName: 'My notes',
      description: 'mine',
    });

    // disable
    await reg.setEnabled('alice', meta.id, false);
    expect(reg.getEnabled('alice', meta.id)).toBe(false);
    expect((await recordOf(meta.id))?.attributes).toMatchObject({
      enabled: false,
    });

    // delete the collection: record and rows go
    expect(await reg.deleteCollection(meta.id)).toBe(true);
    expect(await recordOf(meta.id)).toBeUndefined();
    expect(reg.getCollection(meta.id)).toBeNull();
    const rows = await real.query(
      `SELECT count(*)::int AS n FROM "${pgl.schema}"."rag_documents" WHERE "collection" = $1`,
      [storeNameFor(meta.id)],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('a session collection: catalog owner is the session, the user is in hubOwner; the sweep deletes it', async () => {
    const id = 'scratch__s_0011223344556677';
    await reg.createCollection({
      id,
      logicalId: 'scratch',
      displayName: 'scratch',
      description: '',
      scope: 'session',
      owner: 'alice',
      sessionId: 'sess-1',
      expiresAt: Date.now() - 1,
    });
    const rec = await recordOf(id);
    expect(rec).toMatchObject({ scope: 'session', sessionId: 'sess-1' });
    expect(rec?.attributes).toMatchObject({
      hubOwner: { userId: 'alice', sessionId: 'sess-1' },
    });

    await reg.sweepExpiredSessions();
    expect(reg.getCollection(id)).toBeNull();
    expect(await recordOf(id)).toBeUndefined();
  });

  it('a record that exists in the backend but not in memory: 409 Duplicate, nothing deleted', async () => {
    const meta = userMeta('dup', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, { id: 'd1', text: 'keep me', metadata: {} });

    const other = newRegistry(); // another start, before restore exists
    const err = await other.createCollection(meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CollectionBackendError);
    expect((err as CollectionBackendError).httpStatus).toBe(409);
    expect(other.getCollection(meta.id)).toBeNull();
    expect((await backendDoc(meta.id, 'd1'))?.text).toBe('keep me');
  });
});

describe('a failing backend write leaves memory untouched (Review Focus 2)', () => {
  const meta = userMeta('fragile', 'alice');

  beforeEach(async () => {
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'original text',
      metadata: { v: 1 },
    });
  });

  it('add', async () => {
    await expect(
      reg.addDocument(meta.id, {
        id: 'd2',
        text: 'EMBED_FAIL now',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    down = true;
    await expect(
      reg.addDocument(meta.id, { id: 'd3', text: 'fine text', metadata: {} }),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    down = false;
    expect(reg.getDocument(meta.id, 'd2')).toBeNull();
    expect(reg.getDocument(meta.id, 'd3')).toBeNull();
    expect(reg.getCollection(meta.id)?.documentCount).toBe(1);
  });

  it('bulk add: failures are reported, none kept as unindexed', async () => {
    const res = await reg.addDocumentsBulk(
      meta.id,
      [
        { id: 'b1', text: 'good one', metadata: {} },
        { id: 'b2', text: 'EMBED_FAIL bad one', metadata: {} },
      ],
      undefined,
      { sleep: async () => {} },
    );
    expect(res.added).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(reg.getDocument(meta.id, 'b1')).not.toBeNull();
    expect(reg.getDocument(meta.id, 'b2')).toBeNull();
  });

  it('update (also what rag_correct calls)', async () => {
    await expect(
      reg.updateDocument(meta.id, 'd1', {
        text: 'EMBED_FAIL text',
        metadata: { v: 2 },
      }),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    expect(reg.getDocument(meta.id, 'd1')).toMatchObject({
      text: 'original text',
      metadata: { v: 1 },
    });
    expect((await backendDoc(meta.id, 'd1'))?.text).toBe('original text');
  });

  it('delete (also what rag_deprecate calls)', async () => {
    down = true;
    await expect(reg.deleteDocument(meta.id, 'd1')).rejects.toBeInstanceOf(
      CollectionBackendError,
    );
    down = false;
    expect(reg.getDocument(meta.id, 'd1')).not.toBeNull();
    expect(await backendDoc(meta.id, 'd1')).not.toBeNull();
  });

  it('rename, disable and delete collection', async () => {
    down = true;
    await expect(
      reg.updateCollection(meta.id, { displayName: 'renamed' }),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    await expect(
      reg.setEnabled('alice', meta.id, false),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    await expect(reg.deleteCollection(meta.id)).rejects.toBeInstanceOf(
      CollectionBackendError,
    );
    down = false;
    expect(reg.getCollection(meta.id)?.displayName).toBe('fragile');
    expect(reg.getEnabled('alice', meta.id)).toBeUndefined();
    expect(reg.getDocument(meta.id, 'd1')).not.toBeNull();
    // and it still works once the backend is back
    await reg.addDocument(meta.id, {
      id: 'd9',
      text: 'after recovery',
      metadata: {},
    });
    expect((await backendDoc(meta.id, 'd9'))?.text).toBe('after recovery');
  });

  it('create', async () => {
    down = true;
    const other = userMeta('never', 'alice');
    await expect(reg.createCollection(other)).rejects.toBeInstanceOf(
      CollectionBackendError,
    );
    down = false;
    expect(reg.getCollection(other.id)).toBeNull();
  });
});

describe('two users with the same logical id (Review Focus 1)', () => {
  it('get separate records and stores; neither sees the other', async () => {
    const a = userMeta('result', 'alice');
    const b = userMeta('result', 'bob');
    await reg.createCollection(a);
    await reg.createCollection(b);
    expect(a.id).not.toBe(b.id);
    expect(storeNameFor(a.id)).not.toBe(storeNameFor(b.id));
    expect(await recordOf(a.id)).toMatchObject({
      scope: 'user',
      userId: 'alice',
    });
    expect(await recordOf(b.id)).toMatchObject({
      scope: 'user',
      userId: 'bob',
    });

    await reg.addDocument(a.id, {
      id: 'same',
      text: 'alice secret kangaroo',
      metadata: {},
    });
    await reg.addDocument(b.id, {
      id: 'same',
      text: 'bob secret wombat',
      metadata: {},
    });

    expect(
      await search(reg.getRagStore(a.id), 'secret kangaroo wombat'),
    ).toEqual(['alice secret kangaroo']);
    expect(
      await search(reg.getRagStore(b.id), 'secret kangaroo wombat'),
    ).toEqual(['bob secret wombat']);

    await reg.deleteCollection(a.id);
    expect(await recordOf(b.id)).toBeDefined();
    expect((await backendDoc(b.id, 'same'))?.text).toBe('bob secret wombat');
  });
});

describe('routes over the persistent registry', () => {
  function routes() {
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    return routes;
  }

  beforeEach(() => {
    mockCdsContext.user = { id: 'alice', is: () => false };
  });

  it('/rag/backends lists only the persistent kind', async () => {
    const res = makeRes();
    await findRoute(routes(), 'GET', '/rag/backends').handler(
      makeReq({}),
      res.res,
    );
    expect(res._body).toEqual({ backends: ['pg-vector'] });
  });

  it('a request backend other than the persistent kind is 400; the same kind or none is created', async () => {
    const post = findRoute(routes(), 'POST', '/rag/collections');
    for (const backend of ['vector', 'in-memory', 'qdrant']) {
      const res = makeRes();
      await post.handler(
        makeReq({ body: { id: 'notes', displayName: 'Notes', backend } }),
        res.res,
      );
      expect(res._status).toBe(400);
    }
    expect(await records()).toHaveLength(0);

    const ok = makeRes();
    await post.handler(
      makeReq({
        body: { id: 'notes', displayName: 'Notes', backend: 'pg-vector' },
      }),
      ok.res,
    );
    expect(ok._status).toBe(201);
    expect(await records()).toHaveLength(1);
  });

  it('a backend failure is 502 and a taken record 409', async () => {
    const r = routes();
    const post = findRoute(r, 'POST', '/rag/collections');
    const created = makeRes();
    await post.handler(
      makeReq({ body: { id: 'notes', displayName: 'Notes' } }),
      created.res,
    );
    expect(created._status).toBe(201);
    const id = userCollectionId('notes', 'alice');

    down = true;
    const add = await runIdRoute(
      r,
      'POST',
      '/rag/collections/:id/documents',
      makeReq({
        method: 'POST',
        path: '/documents',
        params: { id },
        body: { id: 'd1', text: 'hello' },
      }),
    );
    down = false;
    expect(add._status).toBe(502);
    expect(reg.getDocument(id, 'd1')).toBeNull();

    // a second start (no restore yet) cannot take the same record
    reg = newRegistry();
    const again = makeRes();
    const post2 = findRoute(routes(), 'POST', '/rag/collections');
    await post2.handler(
      makeReq({ body: { id: 'notes', displayName: 'Notes' } }),
      again.res,
    );
    expect(again._status).toBe(409);
  });
});

describe('presets are not persisted', () => {
  it('stay in process memory, with their enabled flag', async () => {
    await ensurePresets(reg, 'alice', (pack) => [
      { id: `${pack}-doc`, text: `preset text for ${pack}` },
    ]);
    const id = presetCollectionId('rap-skills', 'alice');
    expect(reg.getCollection(id)).toMatchObject({
      preset: true,
      backend: 'vector',
    });
    expect(reg.getDocument(id, 'rap-skills-doc')).not.toBeNull();
    expect(await records()).toHaveLength(0);
    const rows = await real.query(
      `SELECT count(*)::int AS n FROM "${pgl.schema}"."rag_documents"`,
    );
    expect(rows.rows[0].n).toBe(0);

    down = true; // the enabled flag never reaches the backend
    await reg.setEnabled('alice', id, true);
    down = false;
    expect(reg.getEnabled('alice', id)).toBe(true);
    expect(await records()).toHaveLength(0);
  });
});

describe('the PGlite harness', () => {
  it('keeps the data across a backend restart', async () => {
    const meta = userMeta('durable', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'still here',
      metadata: {},
    });
    await real.end();
    await pgl.restart();
    real = await createPgClient({
      connectionString: pgl.url,
      credential: pgl.credential,
      collectionName: 'hub-collections',
      poolMax: 4,
    });
    provider = newProvider();
    expect(await recordOf(meta.id)).toBeDefined();
    expect((await backendDoc(meta.id, 'd1'))?.text).toBe('still here');
  });
});

describe('fix round 1', () => {
  it('a write while the collection is being deleted is a 409 CollectionBackendError', async () => {
    const meta = userMeta('going', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, { id: 'd1', text: 'hello', metadata: {} });
    mockCdsContext.user = { id: 'alice', is: () => false };

    const release = holdBackend();
    const deleting = reg.deleteCollection(meta.id);
    const conflict = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CollectionBackendError);
      expect((err as CollectionBackendError).httpStatus).toBe(409);
    };
    await conflict(
      reg.addDocument(meta.id, { id: 'd2', text: 'late', metadata: {} }),
    );
    await conflict(reg.updateDocument(meta.id, 'd1', { text: 'late' }));
    await conflict(reg.deleteDocument(meta.id, 'd1'));
    expect(
      await dispatchRagTool(reg, 'rag_add', {
        collection: 'going',
        id: 'late-fact',
        text: 'late',
      }),
    ).toMatchObject({ ok: false, status: 409 });
    const bulk = await reg.addDocumentsBulk(
      meta.id,
      [{ id: 'b1', text: 'late', metadata: {} }],
      undefined,
      { sleep: async () => {} },
    );
    expect(bulk.added).toBe(0);
    expect(bulk.errors[0]).toMatch(/being deleted/);
    release();
    await expect(deleting).resolves.toBe(true);
  });

  it('concurrent rename and disable both land in the record', async () => {
    const meta = userMeta('busy', 'alice');
    await reg.createCollection(meta);
    const release = holdBackend();
    const writes = Promise.all([
      reg.updateCollection(meta.id, { displayName: 'Renamed' }),
      reg.setEnabled('alice', meta.id, false),
      reg.updateCollection(meta.id, { description: 'described' }),
    ]);
    release();
    await writes;
    expect((await recordOf(meta.id))?.attributes).toMatchObject({
      displayName: 'Renamed',
      description: 'described',
      enabled: false,
    });
    expect(reg.getCollection(meta.id)).toMatchObject({
      displayName: 'Renamed',
      description: 'described',
    });
    expect(reg.getEnabled('alice', meta.id)).toBe(false);
  });

  it('an admin setting the enabled flag persists it as the collection flag', async () => {
    const meta = userMeta('owned', 'alice');
    await reg.createCollection(meta);
    await reg.setEnabled('admin', meta.id, false);
    expect((await recordOf(meta.id))?.attributes).toMatchObject({
      enabled: false,
    });
    expect(reg.getEnabled('alice', meta.id)).toBe(false);
    expect(reg.getEnabled('admin', meta.id)).toBe(false);
  });

  describe('rag tool status', () => {
    beforeEach(async () => {
      mockCdsContext.user = { id: 'alice', is: () => false };
      await reg.createCollection(userMeta('kb', 'alice'));
      await dispatchRagTool(reg, 'rag_add', {
        collection: 'kb',
        id: 'fact',
        text: 'the sky is blue',
      });
    });

    it.each([
      ['rag_add', { collection: 'kb', id: 'other', text: 'grass is green' }],
      [
        'rag_correct',
        { collection: 'kb', id: 'fact', newText: 'red', reason: 'r' },
      ],
      ['rag_deprecate', { collection: 'kb', id: 'fact', reason: 'r' }],
    ])('%s with the backend down is 502', async (name, args) => {
      down = true;
      const result = await dispatchRagTool(reg, name, args);
      down = false;
      expect(result).toMatchObject({ ok: false, status: 502 });
    });

    it('/rag/tool/:name answers with that status, and 400 for a plain failure', async () => {
      const { router, routes } = makeMockRouter();
      registerRagRoutes(router, reg);
      const route = findRoute(routes, 'POST', '/rag/tool/:name');

      down = true;
      const failed = makeRes();
      await route.handler(
        makeReq({
          params: { name: 'rag_correct' },
          body: { collection: 'kb', id: 'fact', newText: 'red', reason: 'r' },
        }),
        failed.res,
      );
      down = false;
      expect(failed._status).toBe(502);

      const plain = makeRes();
      await route.handler(
        makeReq({
          params: { name: 'rag_correct' },
          body: { collection: 'kb', id: 'missing', newText: 'x', reason: 'r' },
        }),
        plain.res,
      );
      expect(plain._status).toBe(400);
      expect(plain._body).not.toHaveProperty('status');
    });
  });

  it('POST /rag/collections: an anonymous caller is 401 even with a wrong backend', async () => {
    mockCdsContext.user = undefined;
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    const res = makeRes();
    await findRoute(routes, 'POST', '/rag/collections').handler(
      makeReq({ body: { id: 'n', displayName: 'n', backend: 'vector' } }),
      res.res,
    );
    expect(res._status).toBe(401);
  });
});
