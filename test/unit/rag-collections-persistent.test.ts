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
  ...jest.requireActual('../../srv/request-session'),
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
}));

import {
  type IRag,
  type RagCollectionRecord,
  RagError,
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
  restoreHealth,
  retryRestore,
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
    expect((await reg.getCollection(meta.id))?.documentCount).toBe(1);

    // query
    await reg.addDocument(meta.id, {
      id: 'd2',
      text: 'quantum physics lecture',
      metadata: {},
    });
    const hits = await search(await reg.getRagStore(meta.id), 'kangaroo fence');
    expect(hits[0]).toBe('kangaroo jumps over the fence');

    // update
    await reg.updateDocument(meta.id, 'd1', { text: 'wombat digs a burrow' });
    expect((await backendDoc(meta.id, 'd1'))?.text).toBe(
      'wombat digs a burrow',
    );
    expect((await reg.getDocument(meta.id, 'd1'))?.text).toBe(
      'wombat digs a burrow',
    );
    expect((await backendDoc(meta.id, 'd1'))?.metadata).toMatchObject({
      createdAt: doc.createdAt,
    });

    // delete a document
    expect(await reg.deleteDocument(meta.id, 'd2')).toBe(true);
    expect(await backendDoc(meta.id, 'd2')).toBeNull();
    expect(await reg.getDocument(meta.id, 'd2')).toBeNull();

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
    expect(await reg.getCollection(meta.id)).toBeNull();
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
    expect(await reg.getCollection(id)).toBeNull();
    expect(await recordOf(id)).toBeUndefined();
  });

  it('a record that exists in the backend but not in memory: 409 Duplicate, nothing deleted', async () => {
    // Another instance, restored before this one created the record.
    const other = newRegistry();
    await other.ready;
    const meta = userMeta('dup', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, { id: 'd1', text: 'keep me', metadata: {} });

    const err = await other.createCollection(meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CollectionBackendError);
    expect((err as CollectionBackendError).httpStatus).toBe(409);
    expect(await other.getCollection(meta.id)).toBeNull();
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
    expect(await reg.getDocument(meta.id, 'd2')).toBeNull();
    expect(await reg.getDocument(meta.id, 'd3')).toBeNull();
    expect((await reg.getCollection(meta.id))?.documentCount).toBe(1);
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
    expect(await reg.getDocument(meta.id, 'b1')).not.toBeNull();
    expect(await reg.getDocument(meta.id, 'b2')).toBeNull();
  });

  it('update (also what rag_correct calls)', async () => {
    await expect(
      reg.updateDocument(meta.id, 'd1', {
        text: 'EMBED_FAIL text',
        metadata: { v: 2 },
      }),
    ).rejects.toBeInstanceOf(CollectionBackendError);
    expect(await reg.getDocument(meta.id, 'd1')).toMatchObject({
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
    expect(await reg.getDocument(meta.id, 'd1')).not.toBeNull();
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
    expect((await reg.getCollection(meta.id))?.displayName).toBe('fragile');
    expect(reg.getEnabled('alice', meta.id)).toBeUndefined();
    expect(await reg.getDocument(meta.id, 'd1')).not.toBeNull();
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
    expect(await reg.getCollection(other.id)).toBeNull();
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
      await search(await reg.getRagStore(a.id), 'secret kangaroo wombat'),
    ).toEqual(['alice secret kangaroo']);
    expect(
      await search(await reg.getRagStore(b.id), 'secret kangaroo wombat'),
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
    // Another instance, restored before the record below exists.
    const second = newRegistry();
    await second.ready;
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
    expect(await reg.getDocument(id, 'd1')).toBeNull();

    // the other instance cannot take the same record
    reg = second;
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
    expect(await reg.getCollection(id)).toMatchObject({
      preset: true,
      backend: 'vector',
    });
    expect(await reg.getDocument(id, 'rap-skills-doc')).not.toBeNull();
    expect(await records()).toHaveLength(0);
    const rows = await real.query(
      `SELECT count(*)::int AS n FROM "${pgl.schema}"."rag_documents"`,
    );
    expect(rows.rows[0].n).toBe(0);

    // A write to a preset waits for the restore (a restored collection under
    // its id would replace it): restore first, then take the backend down.
    await reg.ready;
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
    expect(await reg.getCollection(meta.id)).toMatchObject({
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

describe('session collections: ownership, sweep and expiry (Task 6)', () => {
  const sessionMeta = (
    logical: string,
    owner: string,
    sessionId: string,
    expiresAt: number,
  ) => ({
    id: `${logical}__${owner}__s_${sessionId}`,
    logicalId: logical,
    displayName: logical,
    description: '',
    scope: 'session' as const,
    owner,
    sessionId,
    expiresAt,
  });

  it("after a restart a user sees their own session collection and not another user's", async () => {
    const mine = sessionMeta('notes', 'alice', 'sa', Date.now() + 60_000);
    const theirs = sessionMeta('notes', 'bob', 'sb', Date.now() + 60_000);
    await reg.createCollection(mine);
    await reg.createCollection(theirs);
    await reg.addDocument(mine.id, {
      id: 'd1',
      text: 'alice note',
      metadata: {},
    });

    // A new provider over the same database, and a registry restored from it.
    await real.end();
    await pgl.restart();
    real = await createPgClient({
      connectionString: pgl.url,
      credential: pgl.credential,
      collectionName: 'hub-collections',
      poolMax: 4,
    });
    provider = newProvider();
    const restarted = newRegistry(provider);
    expect((await restarted.listCollections('alice')).map((c) => c.id)).toEqual(
      [mine.id],
    );
    expect((await restarted.listCollections('bob')).map((c) => c.id)).toEqual([
      theirs.id,
    ]);
    expect((await restarted.getDocument(mine.id, 'd1'))?.text).toBe(
      'alice note',
    );

    const recs = await records();
    const aliceRecs = recs.filter(
      (r) =>
        (r.attributes as { hubOwner?: { userId?: string } }).hubOwner
          ?.userId === 'alice',
    );
    expect(aliceRecs).toHaveLength(1);
    expect(aliceRecs[0]).toMatchObject({
      scope: 'session',
      sessionId: 'sa',
      storeName: storeNameFor(mine.id),
    });
    expect(aliceRecs[0].attributes).toMatchObject({
      expiresAt: mine.expiresAt,
    });
    expect((await backendDoc(mine.id, 'd1'))?.text).toBe('alice note');
    // Bob's record has another session and another user: not alice's.
    expect(recs.some((r) => r.storeName === storeNameFor(theirs.id))).toBe(
      true,
    );
    expect(aliceRecs.some((r) => r.storeName === storeNameFor(theirs.id))).toBe(
      false,
    );
  });

  it('an expired, unleased session collection is deleted in the backend; a leased one is kept', async () => {
    const leased = sessionMeta('a', 'alice', 'leased', Date.now() - 1);
    const free = sessionMeta('b', 'alice', 'free', Date.now() - 1);
    const live = sessionMeta('c', 'alice', 'live', Date.now() + 60_000);
    for (const m of [leased, free, live]) await reg.createCollection(m);
    await reg.sweepExpiredSessions((_u, sid) => sid !== 'leased');
    expect(await recordOf(free.id)).toBeUndefined();
    expect(await reg.getCollection(free.id)).toBeNull();
    expect(await recordOf(leased.id)).toBeDefined();
    expect(await reg.getCollection(leased.id)).not.toBeNull();
    expect(await recordOf(live.id)).toBeDefined();
    // Once the lease is gone the next sweep takes it.
    await reg.sweepExpiredSessions(() => true);
    expect(await recordOf(leased.id)).toBeUndefined();
    expect(await recordOf(live.id)).toBeDefined();
  });

  it('a failed backend delete leaves the record; the next sweep re-sweeps it, even from a new registry', async () => {
    const m = sessionMeta('x', 'alice', 'sx', Date.now() - 1);
    await reg.createCollection(m);
    down = true;
    await reg.sweepExpiredSessions();
    down = false;
    expect(await reg.getCollection(m.id)).toBeNull();
    expect(await recordOf(m.id)).toBeDefined(); // the record is still there

    const fresh = newRegistry(); // a restart before restore: no memory entry
    const exp = await createCollectionPersistence(
      provider,
      'fp-test',
    ).expiredSessions(Date.now());
    expect(exp.ok && exp.value.map((x) => x.id)).toEqual([m.id]);
    // A leased session is skipped; then released.
    await fresh.sweepExpiredSessions(() => false);
    expect(await recordOf(m.id)).toBeDefined();
    await fresh.sweepExpiredSessions(() => true);
    expect(await recordOf(m.id)).toBeUndefined();
  });

  it("deleteSessionCollections removes the session's records and no other", async () => {
    const a = sessionMeta('a', 'alice', 's1', Date.now() + 60_000);
    const b = sessionMeta('b', 'alice', 's2', Date.now() + 60_000);
    await reg.createCollection(a);
    await reg.createCollection(b);
    await reg.deleteSessionCollections('alice', 's1');
    expect(await recordOf(a.id)).toBeUndefined();
    expect(await recordOf(b.id)).toBeDefined();
  });

  it('refreshSessionExpiry persists the new expiry; a failed write leaves the old one', async () => {
    const m = sessionMeta('r', 'alice', 'sr', Date.now() + 1_000);
    await reg.createCollection(m);
    await reg.refreshSessionExpiry(m.id);
    const stored = (await recordOf(m.id))?.attributes as { expiresAt: number };
    expect(stored.expiresAt).toBeGreaterThan(m.expiresAt + 60_000);
    expect((await reg.getCollection(m.id))?.expiresAt).toBe(stored.expiresAt);
    // The record, not memory, is what a restart sees.
    const exp = await createCollectionPersistence(
      provider,
      'fp-test',
    ).expiredSessions(Date.now() + 1_000_000);
    expect(exp.ok).toBe(true);

    const m2 = sessionMeta('r2', 'alice', 'sr2', Date.now() + 1_000);
    await reg.createCollection(m2);
    down = true;
    await expect(reg.refreshSessionExpiry(m2.id)).resolves.toBeUndefined();
    down = false;
    expect((await reg.getCollection(m2.id))?.expiresAt).toBe(m2.expiresAt);
    expect((await recordOf(m2.id))?.attributes).toMatchObject({
      expiresAt: m2.expiresAt,
    });
  });
});

// ---------------------------------------------------------------------------
// Task 7: restore at startup, retry, health
// ---------------------------------------------------------------------------

/** End the pool, restart PGlite on the same data, and open a new pool. */
async function restartBackend(): Promise<void> {
  await real.end();
  await pgl.restart();
  real = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'hub-collections',
    poolMax: 4,
  });
  provider = newProvider();
}

/** A new process: a new registry over a new provider, restored. */
async function restarted(fp = 'fp-test'): Promise<CollectionRegistry> {
  await restartBackend();
  const r = new CollectionRegistry({
    embedder,
    defaultBackend: 'pg-vector',
    persistence: createCollectionPersistence(provider, fp),
  });
  await r.ready;
  return r;
}

/** Let pending promise callbacks run until `cond` holds. */
async function flush(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++)
    await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('condition not reached');
}

/** A rejection, or undefined when `p` resolves. */
async function failureOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('restore at startup (Task 7)', () => {
  beforeEach(() => {
    mockCdsContext.user = { id: 'alice', is: () => false };
  });

  /** Every read the API offers on alice's collection, as JSON text. */
  async function snapshot(id: string): Promise<Record<string, string>> {
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    const list = makeRes();
    await findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({}),
      list.res,
    );
    const get = await runIdRoute(
      routes,
      'GET',
      '/rag/collections/:id',
      makeReq({ params: { id } }),
    );
    const docs = await runIdRoute(
      routes,
      'GET',
      '/rag/collections/:id/documents',
      makeReq({ params: { id }, path: '/documents' }),
    );
    const doc = await runIdRoute(
      routes,
      'GET',
      '/rag/collections/:id/documents/:did',
      makeReq({ params: { id, did: 'd1' }, path: '/documents/d1' }),
    );
    const query = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/query',
      makeReq({
        method: 'POST',
        params: { id },
        path: '/query',
        body: { text: 'kangaroo fence' },
      }),
    );
    for (const r of [list, get, docs, doc, query]) expect(r._status).toBe(200);
    const hits = (query._body as { results: { text: string }[] }).results;
    return {
      list: JSON.stringify(list._body),
      get: JSON.stringify(get._body),
      documents: JSON.stringify(docs._body),
      document: JSON.stringify(doc._body),
      query: JSON.stringify(hits.map((h) => h.text)),
    };
  }

  it('create, then restart: list, get, export and query are byte-identical', async () => {
    const meta = userMeta('notes', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'kangaroo jumps over the fence',
      metadata: { tag: 'animals', nested: { z: 1, a: [1, 2] }, b: true },
    });
    await reg.addDocumentsBulk(
      meta.id,
      [
        {
          id: 'c1',
          text: 'quantum physics lecture',
          metadata: { source: 'f.txt', uploadId: 'u1', chunkIndex: 0 },
        },
        {
          id: 'c2',
          text: 'second chunk',
          metadata: { source: 'f.txt', uploadId: 'u1', chunkIndex: 1 },
        },
      ],
      undefined,
      { sleep: async () => {} },
    );
    await reg.updateDocument(meta.id, 'd1', { metadata: { reviewed: 'yes' } });
    await reg.updateCollection(meta.id, {
      displayName: 'My notes',
      description: 'mine',
    });
    const session = {
      id: 'scratch__s_aa11',
      logicalId: 'scratch',
      displayName: 'scratch',
      description: '',
      scope: 'session' as const,
      owner: 'alice',
      sessionId: 'sess-a',
      expiresAt: Date.now() + 60_000,
    };
    await reg.createCollection(session);
    await reg.setEnabled('alice', session.id, false);

    const before = await snapshot(meta.id);
    const sessionBefore = JSON.stringify(await reg.getCollection(session.id));

    reg = await restarted();

    expect(await snapshot(meta.id)).toEqual(before);
    expect(JSON.stringify(await reg.getCollection(session.id))).toBe(
      sessionBefore,
    );
    expect(reg.getEnabled('alice', session.id)).toBe(false);
    // The payload bookkeeping never reaches the API.
    const d1 = await reg.getDocument(meta.id, 'd1');
    for (const k of [
      'collectionId',
      'docId',
      'createdAt',
      'namespace',
      '_createdAtMs',
      'id',
    ])
      expect(d1?.metadata).not.toHaveProperty(k);
    // And the restored collection takes writes.
    await reg.addDocument(meta.id, { id: 'd9', text: 'later', metadata: {} });
    expect((await backendDoc(meta.id, 'd9'))?.text).toBe('later');
  });

  it("after a restore a user cannot reach another user's collection", async () => {
    const a = userMeta('secret', 'alice');
    await reg.createCollection(a);
    await reg.addDocument(a.id, { id: 'd1', text: 'alice only', metadata: {} });
    reg = await restarted();

    mockCdsContext.user = { id: 'bob', is: () => false };
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    const list = makeRes();
    await findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({}),
      list.res,
    );
    expect(list._status).toBe(200);
    expect(list._body).toEqual({ collections: [] });
    for (const id of [a.id, 'secret']) {
      for (const [method, path, suffix] of [
        ['GET', '/rag/collections/:id', '/'],
        ['GET', '/rag/collections/:id/documents', '/documents'],
        ['POST', '/rag/collections/:id/query', '/query'],
      ] as const) {
        const res = await runIdRoute(
          routes,
          method,
          path,
          makeReq({
            method,
            params: { id },
            path: suffix,
            body: { text: 'x' },
          }),
        );
        expect(res._status).toBe(404);
      }
    }
    expect(
      await dispatchRagTool(reg, 'rag_correct', {
        collection: 'secret',
        id: 'd1',
        newText: 'stolen',
        reason: 'r',
      }),
    ).toMatchObject({ ok: false });
    expect((await backendDoc(a.id, 'd1'))?.text).toBe('alice only');
  });

  it('a restored expired session collection is collected by the memory pass of the sweep', async () => {
    const id = 'old__s_bb22';
    await reg.createCollection({
      id,
      logicalId: 'old',
      displayName: 'old',
      description: '',
      scope: 'session',
      owner: 'alice',
      sessionId: 'sess-old',
      expiresAt: Date.now() - 1,
    });
    reg = await restarted();
    expect(await reg.getCollection(id)).not.toBeNull();
    const asked: string[] = [];
    await reg.sweepExpiredSessions((_u, sid) => {
      asked.push(sid);
      return true;
    });
    // Asked once: by the memory pass; the catalog pass then had nothing left.
    expect(asked).toEqual(['sess-old']);
    expect(await reg.getCollection(id)).toBeNull();
    expect(await recordOf(id)).toBeUndefined();
  });

  it('the catalog sweep deletes only expired records this hub wrote', async () => {
    reg = await restarted();
    // Written after this registry's restore: in the catalog, not in memory.
    const expiredBob = {
      id: 'x__s_bob1',
      logicalId: 'x',
      displayName: 'x',
      description: '',
      scope: 'session' as const,
      owner: 'bob',
      sessionId: 'sess-bob',
      expiresAt: Date.now() - 1,
      createdAt: new Date().toISOString(),
      documentCount: 0,
      sourceCount: 0,
    };
    const liveBob = {
      ...expiredBob,
      id: 'y__s_bob2',
      logicalId: 'y',
      sessionId: 'sess-bob2',
      expiresAt: Date.now() + 60_000,
    };
    const other = createCollectionPersistence(provider, 'fp-test');
    for (const m of [expiredBob, liveBob])
      expect((await other.create(m, true)).ok).toBe(true);
    const foreign = await provider.createCollection('foreign_expired', {
      scope: 'session',
      sessionId: 'sess-f',
      collectionName: 'foreign',
      attributes: {
        writtenBy: 'another-tool',
        source: 'session',
        expiresAt: 1,
        hubOwner: { userId: 'alice', sessionId: 'sess-f' },
      },
    });
    expect(foreign.ok).toBe(true);

    await reg.sweepExpiredSessions(() => true);
    expect(await recordOf(expiredBob.id)).toBeUndefined();
    expect(await recordOf(liveBob.id)).toBeDefined();
    expect(
      (await records()).some((r) => r.storeName === 'foreign_expired'),
    ).toBe(true);
  });

  it('a foreign record is neither opened nor shown', async () => {
    const mine = userMeta('mine', 'alice');
    await reg.createCollection(mine);
    const foreign = await provider.createCollection('foreign_store', {
      scope: 'user',
      userId: 'alice',
      collectionName: 'foreign',
      attributes: { writtenBy: 'another-tool' },
    });
    expect(foreign.ok).toBe(true);
    // A hub-shaped record whose catalog owner is not its hubOwner.
    const forged = userMeta('forged', 'alice');
    const forgedRec = await provider.createCollection(storeNameFor(forged.id), {
      scope: 'user',
      userId: 'mallory',
      collectionName: forged.id,
      attributes: {
        writtenBy: 'cloud-llm-hub',
        collectionId: forged.id,
        logicalId: 'forged',
        embedder: 'fp-test',
        hubOwner: { userId: 'alice' },
      },
    });
    expect(forgedRec.ok).toBe(true);

    await restartBackend();
    const opened: string[] = [];
    const open = provider.openCollection.bind(provider);
    provider.openCollection = async (rec) => {
      opened.push(rec.storeName);
      return open(rec);
    };
    const r = newRegistry(provider);
    await r.ready;
    expect(opened).toEqual([storeNameFor(mine.id)]);
    expect((await r.listCollections('alice')).map((c) => c.id)).toEqual([
      mine.id,
    ]);
    expect(await r.listCollections('mallory')).toEqual([]);
    expect(
      (await records()).filter((x) =>
        ['foreign_store', storeNameFor(forged.id)].includes(x.storeName),
      ),
    ).toHaveLength(2);
  });

  it('a fingerprint mismatch restores the collection as incompatible', async () => {
    const meta = userMeta('old-embedder', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'kangaroo jumps over the fence',
      metadata: {},
    });
    reg = await restarted('fp-new');

    const got = await reg.getCollection(meta.id);
    expect(got).toMatchObject({ status: 'incompatible', documentCount: 1 });
    expect(got?.statusError).toMatch(/fp-test/);
    expect(got?.statusError).toMatch(/fp-new/);
    // Listed, read and exported.
    expect((await reg.listDocuments(meta.id))?.total).toBe(1);
    expect((await reg.getDocument(meta.id, 'd1'))?.text).toBe(
      'kangaroo jumps over the fence',
    );
    // Search and writes: an explicit 409 naming both fingerprints.
    for (const p of [
      reg.getRagStore(meta.id),
      reg.addDocument(meta.id, { id: 'd2', text: 'x', metadata: {} }),
      reg.updateDocument(meta.id, 'd1', { text: 'y' }),
      reg.deleteDocument(meta.id, 'd1'),
    ] as Promise<unknown>[]) {
      const err = await failureOf(p);
      expect(err).toBeInstanceOf(CollectionBackendError);
      expect((err as CollectionBackendError).httpStatus).toBe(409);
      expect((err as Error).message).toMatch(/fp-test.*fp-new/);
    }
    // The routes say so.
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    const list = makeRes();
    await findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({}),
      list.res,
    );
    expect(
      (list._body as { collections: { status?: string }[] }).collections[0],
    ).toMatchObject({ status: 'incompatible' });
    const query = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/query',
      makeReq({
        method: 'POST',
        params: { id: meta.id },
        path: '/query',
        body: { text: 'kangaroo' },
      }),
    );
    expect(query._status).toBe(409);
    // Renaming and disabling keep the record's fingerprint: still incompatible.
    await reg.updateCollection(meta.id, { displayName: 'Renamed' });
    await reg.setEnabled('alice', meta.id, false);
    expect((await recordOf(meta.id))?.attributes).toMatchObject({
      displayName: 'Renamed',
      enabled: false,
      embedder: 'fp-test',
    });
    // It can still be deleted.
    expect(await reg.deleteCollection(meta.id)).toBe(true);
    expect(await recordOf(meta.id)).toBeUndefined();
  });

  it('one collection that cannot be opened is unavailable; the others work', async () => {
    const good = userMeta('good', 'alice');
    const bad = userMeta('bad', 'alice');
    await reg.createCollection(good);
    await reg.createCollection(bad);
    await reg.addDocument(good.id, { id: 'd1', text: 'fine', metadata: {} });
    await reg.addDocument(bad.id, { id: 'd1', text: 'lost', metadata: {} });

    await restartBackend();
    const open = provider.openCollection.bind(provider);
    provider.openCollection = async (rec) =>
      rec.storeName === storeNameFor(bad.id)
        ? { ok: false, error: new RagError('store is gone', 'RAG_OPEN_ERROR') }
        : open(rec);
    reg = newRegistry(provider);
    await reg.ready;

    expect((await reg.getDocument(good.id, 'd1'))?.text).toBe('fine');
    expect(await search(await reg.getRagStore(good.id), 'fine')).toEqual([
      'fine',
    ]);
    const meta = await reg.getCollection(bad.id);
    expect(meta).toMatchObject({ status: 'unavailable' });
    expect(meta?.statusError).toMatch(/store is gone/);
    for (const p of [
      reg.listDocuments(bad.id),
      reg.getDocument(bad.id, 'd1'),
      reg.getRagStore(bad.id),
      reg.addDocument(bad.id, { id: 'd2', text: 'x', metadata: {} }),
    ] as Promise<unknown>[]) {
      const err = await failureOf(p);
      expect(err).toBeInstanceOf(CollectionBackendError);
      expect((err as CollectionBackendError).httpStatus).toBe(503);
      expect((err as Error).message).toMatch(/store is gone/);
    }
    // The chat is refused, naming the collection and its cause: degradedOf
    // reports it, and getRagStores never drops it silently.
    const refusal = await reg.degradedOf([good.id, bad.id]);
    expect(refusal).toBeInstanceOf(CollectionBackendError);
    expect(refusal?.httpStatus).toBe(503);
    expect(refusal?.message).toMatch(new RegExp(`${bad.id}.*store is gone`));
    expect(await reg.degradedOf([good.id])).toBeUndefined();
    const stores = await failureOf(reg.getRagStores([good.id, bad.id]));
    expect((stores as CollectionBackendError).httpStatus).toBe(503);
  });

  it('an unreachable backend at boot: 503 and explicit errors, then the retry restores and health is 200', async () => {
    const meta = userMeta('durable', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'survives',
      metadata: {},
    });

    // The process starts while the database is down.
    await real.end();
    await pgl.suspend();
    real = await createPgClient({
      connectionString: pgl.url,
      credential: pgl.credential,
      collectionName: 'hub-collections',
      poolMax: 4,
    });
    provider = newProvider();
    reg = newRegistry(provider);
    expect(restoreHealth(reg.restoreStatus()).status).toBe(503);

    const delays: number[] = [];
    let next: (() => void) | undefined;
    const logged: string[] = [];
    const restored = retryRestore(() => reg.restore(), {
      schedule: (run, ms) => {
        delays.push(ms);
        next = run;
      },
      log: {
        info: (m: string) => logged.push(m),
        warn: (m: string) => logged.push(m),
      },
    });
    await expect(reg.ready).rejects.toThrow(/collections unavailable/);
    await flush(() => delays.length === 1);
    expect(delays).toEqual([30_000]);
    expect(reg.restoreStatus().state).toBe('failed');
    const h = restoreHealth(reg.restoreStatus());
    expect(h.status).toBe(503);
    expect(JSON.stringify(h.body)).toMatch(/ECONNREFUSED/);

    // Persistent operations are refused explicitly meanwhile: 503 with the
    // cause. The listing serves the presets (none here) and reports the
    // persistent collections unavailable.
    const { router, routes } = makeMockRouter();
    registerRagRoutes(router, reg);
    const list = makeRes();
    await findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({}),
      list.res,
    );
    expect(list._status).toBe(200);
    expect(list._body).toMatchObject({ collections: [] });
    expect(
      (list._body as { collectionsUnavailable?: string })
        .collectionsUnavailable,
    ).toMatch(/collections unavailable/);
    const create = makeRes();
    await findRoute(routes, 'POST', '/rag/collections').handler(
      makeReq({ body: { id: 'n2', displayName: 'n2' } }),
      create.res,
    );
    expect(create._status).toBe(503);
    const get = await runIdRoute(
      routes,
      'GET',
      '/rag/collections/:id',
      makeReq({ params: { id: meta.id } }),
    );
    expect(get._status).toBe(503);

    // A second failed attempt doubles the delay.
    next?.();
    await flush(() => delays.length === 2);
    expect(delays).toEqual([30_000, 60_000]);

    // The database comes back; the next attempt restores.
    await pgl.resume();
    next?.();
    await restored;
    expect(reg.restoreStatus().state).toBe('ready');
    expect(restoreHealth(reg.restoreStatus())).toMatchObject({ status: 200 });
    expect((await reg.getDocument(meta.id, 'd1'))?.text).toBe('survives');
    expect(
      logged.filter((m) => /attempt/i.test(m)).length,
    ).toBeGreaterThanOrEqual(3);
    const again = makeRes();
    await findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({}),
      again.res,
    );
    expect(again._status).toBe(200);
  });
});

describe('retryRestore backoff', () => {
  it('30 s, doubling, capped at 5 min; each attempt logged', async () => {
    const delays: number[] = [];
    let next: (() => void) | undefined;
    let fails = 6;
    const logged: string[] = [];
    const done = retryRestore(
      async () => {
        if (fails-- > 0) throw new Error('down');
      },
      {
        schedule: (run, ms) => {
          delays.push(ms);
          next = run;
        },
        log: {
          info: (m: string) => logged.push(m),
          warn: (m: string) => logged.push(m),
        },
      },
    );
    for (let i = 1; i <= 6; i++) {
      await flush(() => delays.length === i);
      next?.();
    }
    await done;
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    // Each attempt is logged when it starts, and again with its outcome.
    expect(
      logged.filter((m) => /^Collection restore attempt \d+$/.test(m)),
    ).toHaveLength(7);
    expect(
      logged.filter((m) => /failed; next attempt in/.test(m)),
    ).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Task 7, fix round 1
// ---------------------------------------------------------------------------

describe('Task 7 fix round 1', () => {
  beforeEach(() => {
    mockCdsContext.user = { id: 'alice', is: () => false };
  });

  const presetLoader = (pack: string) => [
    { id: `${pack}-doc`, text: `preset text for ${pack}` },
  ];

  describe.each([
    ['persistence off', () => new CollectionRegistry()],
    ['persistence on', () => reg],
  ])('get-or-create under concurrency (%s)', (_mode, make) => {
    it('two parallel rag_add on a new collection: both succeed, one collection', async () => {
      const r = make();
      const results = await Promise.all([
        dispatchRagTool(r, 'rag_add', {
          collection: 'par',
          id: 'a',
          text: 'one',
        }),
        dispatchRagTool(r, 'rag_add', {
          collection: 'par',
          id: 'b',
          text: 'two',
        }),
      ]);
      expect(results).toEqual([
        { ok: true, id: 'a' },
        { ok: true, id: 'b' },
      ]);
      const mine = (await r.listCollections('alice')).filter(
        (c) => c.logicalId === 'par',
      );
      expect(mine).toHaveLength(1);
      expect(mine[0].documentCount).toBe(2);
    });

    it('two parallel idempotent POST /rag/collections: 201 and 200, one collection', async () => {
      const r = make();
      const { router, routes } = makeMockRouter();
      registerRagRoutes(router, r);
      const post = findRoute(routes, 'POST', '/rag/collections');
      const a = makeRes();
      const b = makeRes();
      await Promise.all([
        post.handler(
          makeReq({ body: { id: 'twice', displayName: 'T' } }),
          a.res,
        ),
        post.handler(
          makeReq({ body: { id: 'twice', displayName: 'T' } }),
          b.res,
        ),
      ]);
      expect([a._status, b._status].sort()).toEqual([200, 201]);
      expect((a._body as { id: string }).id).toBe(
        (b._body as { id: string }).id,
      );
      expect(
        (await r.listCollections('alice')).filter(
          (c) => c.logicalId === 'twice',
        ),
      ).toHaveLength(1);
    });

    it('two parallel ensurePresets: both succeed, one collection per pack', async () => {
      const r = make();
      await Promise.all([
        ensurePresets(r, 'alice', presetLoader),
        ensurePresets(r, 'alice', presetLoader),
      ]);
      const presets = (await r.listCollections('alice')).filter(
        (c) => c.preset,
      );
      expect(presets.map((c) => c.logicalId).sort()).toEqual([
        'rap-context',
        'rap-skills',
      ]);
    });
  });

  it('with persistence on, parallel creates write one record', async () => {
    await Promise.all([
      reg.getOrCreateCollection(userMeta('one', 'alice')),
      reg.getOrCreateCollection(userMeta('one', 'alice')),
    ]);
    expect(
      (await records()).filter(
        (x) => x.storeName === storeNameFor(userMeta('one', 'alice').id),
      ),
    ).toHaveLength(1);
  });

  it('waiting on a restore is bounded: 503 "restore still in progress"', async () => {
    const r = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence: { restore: () => new Promise(() => {}) } as never,
      readyTimeoutMs: 20,
    });
    const err = await failureOf(r.listCollections('alice'));
    expect(err).toBeInstanceOf(CollectionBackendError);
    expect((err as CollectionBackendError).httpStatus).toBe(503);
    expect((err as Error).message).toBe(
      'collections unavailable: restore still in progress',
    );
  });

  it.each([
    [
      'failed',
      () => Promise.resolve({ ok: false, error: new RagError('down', 'X') }),
    ],
    ['pending', () => new Promise(() => {})],
  ])('presets never wait on a %s restore', async (_state, restore) => {
    const r = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence: { restore } as never,
      readyTimeoutMs: 60_000,
    });
    if (_state === 'failed') await failureOf(r.ready);
    await ensurePresets(r, 'alice', presetLoader);
    const id = presetCollectionId('rap-skills', 'alice');
    expect((await r.getCollection(id))?.preset).toBe(true);
    expect((await r.getDocument(id, 'rap-skills-doc'))?.text).toBe(
      'preset text for rap-skills',
    );
  });

  it('reserved payload keys: the hub values win; the document keeps its other metadata', async () => {
    const meta = userMeta('reserved', 'alice');
    await reg.createCollection(meta);
    await reg.addDocument(meta.id, {
      id: 'd1',
      text: 'kept text',
      metadata: {
        namespace: 'mine',
        id: 'evil',
        docId: 'evil',
        collectionId: 'evil',
        createdAt: 'evil',
        _createdAtMs: 1,
        keep: 'yes',
      },
    });
    // The backend holds the hub's values under the point id.
    const stored = await backendDoc(meta.id, 'd1');
    expect(stored?.metadata).toMatchObject({
      namespace: 'alice',
      docId: 'd1',
      collectionId: meta.id,
      keep: 'yes',
    });
    expect(stored?.metadata.createdAt).not.toBe('evil');
    expect(stored?.metadata._createdAtMs).not.toBe(1);
    // The document's own metadata: the reserved keys are not part of it.
    const before = JSON.stringify(await reg.getDocument(meta.id, 'd1'));
    expect(JSON.parse(before).metadata).toEqual({ keep: 'yes' });
    reg = await restarted();
    expect(JSON.stringify(await reg.getDocument(meta.id, 'd1'))).toBe(before);
  });

  it('bulk add is refused on incompatible (409) and unavailable (503) collections', async () => {
    const inc = userMeta('inc', 'alice');
    const una = userMeta('una', 'alice');
    await reg.createCollection(inc);
    await reg.createCollection(una);
    await restartBackend();
    const open = provider.openCollection.bind(provider);
    provider.openCollection = async (rec) =>
      rec.storeName === storeNameFor(una.id)
        ? { ok: false, error: new RagError('gone', 'RAG_OPEN_ERROR') }
        : open(rec);
    reg = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence: createCollectionPersistence(provider, 'fp-new'),
    });
    await reg.ready;
    const bulk = (id: string) =>
      reg.addDocumentsBulk(
        id,
        [{ id: 'b1', text: 'x', metadata: {} }],
        undefined,
        {
          sleep: async () => {},
        },
      );
    for (const [id, status] of [
      [inc.id, 409],
      [una.id, 503],
    ] as const) {
      const err = await failureOf(bulk(id));
      expect(err).toBeInstanceOf(CollectionBackendError);
      expect((err as CollectionBackendError).httpStatus).toBe(status);
    }
  });
});

describe('final review fixes', () => {
  const presetLoader = (pack: string) => [
    { id: `${pack}-doc`, text: `preset text for ${pack}` },
  ];

  /** A new process over the same database, NOT restored yet. */
  async function unrestored(): Promise<CollectionRegistry> {
    await restartBackend();
    return newRegistry(provider);
  }

  /** The record of `id` is gone from the catalog (a delete out in the background). */
  async function recordGone(id: string): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      if (!(await recordOf(id))) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  describe('F3: a write to a preset id during a pending restore', () => {
    it('waits for the restore and lands on the restored collection under that id', async () => {
      // Before the restart: alice's own persistent collection under the id a
      // preset would take.
      const id = presetCollectionId('rap-skills', 'alice');
      await reg.createCollection({
        id,
        logicalId: 'rap-skills',
        displayName: 'mine',
        description: '',
        scope: 'user',
        owner: 'alice',
      });
      const r = await unrestored();
      // The preset is seeded while nothing is restored (never waits).
      const release = holdBackend();
      await ensurePresets(r, 'alice', presetLoader);
      expect((await r.getCollection(id))?.preset).toBe(true);
      const restoring = r.ready;

      let settled = false;
      const write = r
        .addDocument(id, { id: 'w1', text: 'written meanwhile', metadata: {} })
        .finally(() => {
          settled = true;
        });
      await new Promise((res) => setImmediate(res));
      expect(settled).toBe(false); // waits: no 200 for the preset
      release();
      await restoring;
      await write;

      const held = await r.getCollection(id);
      expect(held?.preset).toBeUndefined();
      expect(held?.displayName).toBe('mine');
      expect((await r.getDocument(id, 'w1'))?.text).toBe('written meanwhile');
      // and it is in the backend: a restart still has it
      expect((await backendDoc(id, 'w1'))?.text).toBe('written meanwhile');
    });

    it('lands on the preset when the restore holds nothing under its id', async () => {
      const r = await unrestored();
      await ensurePresets(r, 'alice', presetLoader);
      const id = presetCollectionId('rap-skills', 'alice');
      await r.addDocument(id, { id: 'w1', text: 'preset note', metadata: {} });
      await r.setEnabled('alice', id, true);
      expect((await r.getCollection(id))?.preset).toBe(true);
      expect((await r.getDocument(id, 'w1'))?.text).toBe('preset note');
      expect(r.getEnabled('alice', id)).toBe(true);
      expect(await records()).toHaveLength(0);
    });

    it('is refused (503) while the restore has failed, never a 200', async () => {
      const r = await unrestored();
      await ensurePresets(r, 'alice', presetLoader);
      const id = presetCollectionId('rap-skills', 'alice');
      down = true;
      await failureOf(r.ready);
      for (const op of [
        () => r.addDocument(id, { id: 'w1', text: 'x', metadata: {} }),
        () => r.updateDocument(id, 'rap-skills-doc', { text: 'y' }),
        () => r.deleteDocument(id, 'rap-skills-doc'),
        () => r.setEnabled('alice', id, true),
        () => r.updateCollection(id, { displayName: 'renamed' }),
        () => r.deleteCollection(id),
      ]) {
        const err = await failureOf(op());
        expect(err).toBeInstanceOf(CollectionBackendError);
        expect((err as CollectionBackendError).httpStatus).toBe(503);
      }
      down = false;
      // nothing changed on the preset
      expect((await r.getDocument(id, 'rap-skills-doc'))?.text).toBe(
        'preset text for rap-skills',
      );
      expect((await r.getCollection(id))?.displayName).toBe('RAP Skills');
    });
  });

  describe('F4: removing a session while the restore is not ready', () => {
    const sessionMeta = (logical: string, sessionId: string) => ({
      id: `${logical}__alice__s_${sessionId}`,
      logicalId: logical,
      displayName: logical,
      description: '',
      scope: 'session' as const,
      owner: 'alice',
      sessionId,
      expiresAt: Date.now() + 60_000,
    });

    it('logout during a pending restore: after it the session collections are gone in memory and backend', async () => {
      const gone = sessionMeta('notes', 's1');
      const kept = sessionMeta('notes', 's2');
      await reg.createCollection(gone);
      await reg.createCollection(kept);
      await reg.addDocument(gone.id, { id: 'd1', text: 'x', metadata: {} });
      const r = await unrestored();
      const release = holdBackend();
      const restoring = r.ready;
      await r.deleteSessionCollections('alice', 's1');
      expect(r.hasSessionCollections('alice', 's1')).toBe(false);
      release();
      await restoring;

      expect(await r.getCollection(gone.id)).toBeNull();
      expect(r.hasSessionCollections('alice', 's1')).toBe(false);
      expect(await r.getCollection(kept.id)).not.toBeNull();
      expect(r.hasSessionCollections('alice', 's2')).toBe(true);
      expect(await recordGone(gone.id)).toBe(true);
      expect(await recordOf(kept.id)).toBeDefined();
      const rows = await real.query(
        `SELECT count(*)::int AS n FROM "${pgl.schema}"."rag_documents" WHERE "collection" = $1`,
        [storeNameFor(gone.id)],
      );
      expect(rows.rows[0].n).toBe(0);
    });

    it('logout during a failed restore: the next successful restore deletes them', async () => {
      const gone = sessionMeta('notes', 's1');
      await reg.createCollection(gone);
      const r = await unrestored();
      down = true;
      await failureOf(r.ready);
      await r.deleteSessionCollections('alice', 's1');
      expect(r.hasSessionCollections('alice', 's1')).toBe(false);
      down = false;
      await r.restore();
      expect(await r.getCollection(gone.id)).toBeNull();
      expect(await recordGone(gone.id)).toBe(true);
      // A restore after that brings nothing back.
      const again = await restarted();
      expect(await again.getCollection(gone.id)).toBeNull();
    });

    it('once restored, a removal is the ordinary one (no tombstone kept)', async () => {
      const s = sessionMeta('notes', 's1');
      await reg.ready;
      await reg.createCollection(s);
      await reg.deleteSessionCollections('alice', 's1');
      expect(await recordGone(s.id)).toBe(true);
      // the same session may hold collections again
      await reg.createCollection(s);
      expect(reg.hasSessionCollections('alice', 's1')).toBe(true);
    });
  });

  describe('M8: presets while the restore has failed', () => {
    it('listing serves the presets and reports the rest unavailable; a chat over presets works', async () => {
      const mine = userMeta('notes', 'alice');
      await reg.createCollection(mine);
      const r = await unrestored();
      await ensurePresets(r, 'alice', presetLoader);
      down = true;
      await failureOf(r.ready);

      const listed = await r.listCollectionsOrPresets('alice');
      expect(listed.collections.map((c) => c.id).sort()).toEqual(
        [
          presetCollectionId('rap-context', 'alice'),
          presetCollectionId('rap-skills', 'alice'),
        ].sort(),
      );
      expect(listed.unavailable).toMatch(/collections unavailable/);
      // listCollections itself still refuses: nothing silently left out
      expect(await failureOf(r.listCollections('alice'))).toBeInstanceOf(
        CollectionBackendError,
      );

      // What the chat does: each entry a held preset, then search.
      const ids = [
        'rap-skills',
        presetCollectionId('rap-context', 'alice'),
      ].map((e) => r.heldPresetFor(e, 'alice'));
      expect(ids).toEqual([
        presetCollectionId('rap-skills', 'alice'),
        presetCollectionId('rap-context', 'alice'),
      ]);
      expect(await r.degradedOf(ids as string[])).toBeUndefined();
      const stores = await r.getRagStores(ids as string[]);
      expect(Object.keys(stores)).toHaveLength(2);
      // a persistent name, another user's preset, or anonymous: not a held preset
      expect(r.heldPresetFor('notes', 'alice')).toBeUndefined();
      expect(r.heldPresetFor(mine.id, 'alice')).toBeUndefined();
      expect(r.heldPresetFor('rap-skills', 'bob')).toBeUndefined();
      expect(
        r.heldPresetFor(presetCollectionId('rap-skills', 'alice'), 'bob'),
      ).toBeUndefined();
      expect(r.heldPresetFor('rap-skills', 'anonymous')).toBeUndefined();
      down = false;
    });

    it('the list route answers 200 with the presets and collectionsUnavailable', async () => {
      mockCdsContext.user = { id: 'alice', is: () => false };
      const r = await unrestored();
      await ensurePresets(r, 'alice', presetLoader);
      down = true;
      await failureOf(r.ready);
      const { router, routes } = makeMockRouter();
      registerRagRoutes(router, r);
      const list = makeRes();
      await findRoute(routes, 'GET', '/rag/collections').handler(
        makeReq({}),
        list.res,
      );
      down = false;
      expect(list._status).toBe(200);
      const body = list._body as {
        collections: { preset?: boolean }[];
        collectionsUnavailable?: string;
      };
      expect(body.collections).toHaveLength(2);
      expect(body.collections.every((c) => c.preset)).toBe(true);
      expect(body.collectionsUnavailable).toMatch(/collections unavailable/);
    });
  });
});

test('record enabled metadata survives PGlite restart and excludes disabled records', async () => {
  const meta = userMeta('record-toggle', 'alice');
  await reg.createCollection(meta);
  await reg.addDocument(meta.id, { id: 'a', text: 'knowledge', metadata: {} });
  await reg.setDocumentEnabled(meta.id, 'a', false);
  expect((await backendDoc(meta.id, 'a'))?.metadata.enabled).toBe(false);
  const restored = await restarted();
  expect(await restored.getDocument(meta.id, 'a')).toMatchObject({
    enabled: false,
  });
  expect((await restored.listDocuments(meta.id))?.documents[0].enabled).toBe(
    false,
  );
  expect(
    await search(await restored.getRagStore(meta.id), 'knowledge'),
  ).toEqual([]);
  await restored.setDocumentEnabled(meta.id, 'a', true);
  expect(
    await search(await restored.getRagStore(meta.id), 'knowledge'),
  ).toEqual(['knowledge']);
});

test('partial agent updates preserve authoritative edits and toggle records created by another instance', async () => {
  await reg.seedAgentConfiguration('agents', 'planner');
  const other = newRegistry();
  await other.restore();
  await other.updateDocument('agents', 'executor', {
    text: 'narrowed executor',
    metadata: { tools: 'read-only', description: 'current description' },
  });
  await reg.setDocumentEnabled('agents', 'executor', false);
  expect(
    (await reg.readAgentCollection('agents'))?.documents.find(
      (doc) => doc.id === 'executor',
    ),
  ).toMatchObject({
    text: 'narrowed executor',
    metadata: {
      tools: 'read-only',
      description: 'current description',
      enabled: false,
    },
  });
  await other.updateDocument('agents', 'executor', { text: 'latest body' });
  await reg.updateDocument('agents', 'executor', {
    metadata: { description: 'partial edit' },
  });
  expect(
    (await reg.readAgentCollection('agents'))?.documents.find(
      (doc) => doc.id === 'executor',
    ),
  ).toMatchObject({
    text: 'latest body',
    metadata: {
      tools: 'read-only',
      enabled: false,
      description: 'partial edit',
    },
  });
  await other.addDocument('agents', {
    id: 'new-profile',
    text: 'new body',
    metadata: {
      canonicalKey: 'new-profile',
      name: 'new-profile',
      kind: 'profile',
      description: 'new',
      tools: 'read-only',
      result: 'report',
    },
  });
  expect(
    await reg.setDocumentEnabled('agents', 'new-profile', false),
  ).toMatchObject({ text: 'new body', enabled: false });
});

test('persistent agent startup upserts only missing complete records and preserves edited disabled records', async () => {
  await reg.seedAgentConfiguration('agents', 'planner');
  expect((await reg.readAgentCollection('agents'))?.documents).toHaveLength(5);
  await reg.updateDocument('agents', 'executor', {
    text: 'edited executor',
    metadata: { enabled: false },
  });
  await reg.deleteDocument('agents', 'analyst');
  const restarted = newRegistry();
  await restarted.restore();
  const add = jest.spyOn(restarted, 'addDocument');
  await restarted.seedAgentConfiguration('agents', 'planner');
  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith(
    'agents',
    expect.objectContaining({
      id: 'analyst',
      text: expect.any(String),
      metadata: expect.objectContaining({
        kind: 'profile',
        canonicalKey: 'analyst',
      }),
    }),
  );
  expect(
    (await restarted.readAgentCollection('agents'))?.documents.find(
      (record) => record.id === 'executor',
    ),
  ).toMatchObject({ text: 'edited executor', metadata: { enabled: false } });
  add.mockClear();
  await restarted.seedAgentConfiguration('agents', 'planner');
  expect(add).not.toHaveBeenCalled();
});

test('agent copies and unpublished-copy markers survive provider restoration', async () => {
  await reg.seedAgentConfiguration('agents', 'planner');
  await reg.setDocumentEnabled('agents', 'analyst', false);
  const meta = {
    ...userMeta('agents-copy', 'alice'),
    collectionKind: 'agents' as const,
  };
  await reg.copyAgentCollection('agents', meta);
  const restored = newRegistry(newProvider());
  await restored.ready;
  expect((await restored.getCollection(meta.id))?.collectionKind).toBe(
    'agents',
  );
  expect(
    (await restored.getDocument(meta.id, 'analyst'))?.metadata.enabled,
  ).toBe(false);
  await restored.updateDocument(meta.id, 'planner', { text: '' });
  expect(
    (await newRegistry(newProvider()).getDocument(meta.id, 'planner'))?.text,
  ).toBe('');
  const pendingMeta = {
    ...userMeta('incomplete-agents', 'alice'),
    collectionKind: 'agents' as const,
    agentsCopyPending: true,
  };
  await restored.createCollection(pendingMeta);
  const afterFailure = newRegistry(newProvider());
  await afterFailure.ready;
  expect(
    (await afterFailure.getCollection(pendingMeta.id))?.agentsCopyPending,
  ).toBe(true);
  expect(await afterFailure.listCollections('alice')).not.toContainEqual(
    expect.objectContaining({ id: pendingMeta.id }),
  );
});
