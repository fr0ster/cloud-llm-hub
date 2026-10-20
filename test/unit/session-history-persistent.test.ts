/**
 * Persistent session history over a real PgVectorRagProvider (shared layout)
 * on PGlite: the `h_history` catalog record, recall across a restart, forget
 * by owner, the per-owner cap, the turn metadata, and that restore and the
 * catalog sweep leave the history record alone.
 */
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
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
}));

import {
  DuplicateCollectionError,
  type IRag,
  type IRagProvider,
  OrphanStoreError,
  type RagCollectionRecord,
  RagError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  createCollectionPersistence,
  ensureHistoryStore,
  HISTORY_OPEN_COOL_DOWN_MS,
  HISTORY_STORE,
  PersistentHistoryStore,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
import {
  SessionHistoryRag,
  turnOwner,
} from '../../srv/lib/session-history-rag';
import { CollectionRegistry } from '../../srv/rag-collections';
import { type PgliteHandle, startPglite } from './helpers/pglite';

jest.setTimeout(120_000);

const DIM = 8;

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
  embed: async (text: string) => ({ vector: vectorOf(text) }),
});

type PgClient = Awaited<ReturnType<typeof createPgClient>>;
let pgl: PgliteHandle;
let real: PgClient;
/** While true every statement fails, as against an unreachable database. */
let down = false;
const client: PgClient = {
  query: async (sql, params) => {
    if (down) throw new Error('connect ECONNREFUSED (backend down)');
    return real.query(sql, params);
  },
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

async function records(p: PgVectorRagProvider): Promise<RagCollectionRecord[]> {
  const d = await p.describeCollections();
  if (!d.ok) throw d.error;
  return [...d.value.records];
}

/** Rows of the history store, read straight from the documents table. */
async function historyRows(): Promise<
  { id: string; metadata: Record<string, unknown> }[]
> {
  const { rows } = await real.query(
    `SELECT "id", "metadata" FROM "${pgl.schema}"."rag_documents" WHERE "collection" = $1 ORDER BY "id"`,
    [HISTORY_STORE],
  );
  return rows.map((r) => ({
    id: String(r.id),
    metadata:
      typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

const ALICE = turnOwner('alice@example.com', 's-1');
const BOB = turnOwner('bob@example.com', 's-2');

/** A clock that advances one second per call, so createdAt orders turns. */
function steppingClock(start = Date.parse('2026-10-20T10:00:00.000Z')) {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t);
  };
}

function history(
  owner: () => string | undefined,
  opts: {
    cap?: number;
    warnings?: unknown[];
    provider?: PgVectorRagProvider;
    clock?: () => number;
  } = {},
): SessionHistoryRag {
  const log = {
    warn: (m: string, d?: unknown) => opts.warnings?.push({ m, d }),
  };
  return new SessionHistoryRag(
    new PersistentHistoryStore(
      opts.provider ?? newProvider(),
      log,
      opts.clock ? { now: opts.clock } : {},
    ),
    owner,
    opts.cap,
    { log, now: steppingClock() },
  );
}

async function recall(rag: SessionHistoryRag, text: string): Promise<string[]> {
  const r = await rag.query(new TextOnlyEmbedding(text), 10);
  if (!r.ok) throw r.error;
  return r.value.map((x) => x.text);
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
  await real.query(
    `TRUNCATE "${pgl.schema}"."rag_documents", "${pgl.schema}"."rag_collections"`,
  );
});

describe('the h_history catalog record', () => {
  it('is created on first use: global scope, writtenBy marker; never an orphan', async () => {
    const rag = history(() => ALICE);
    expect(
      await rag.recordTurn({
        owner: ALICE,
        userText: 'make a domain',
        assistantText: 'created ZDEMO_KANGAROO',
      }),
    ).toBe(true);
    const recs = (await records(newProvider())).filter(
      (r) => r.storeName === HISTORY_STORE,
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].scope).toBe('global');
    expect(recs[0].attributes).toMatchObject({ writtenBy: WRITTEN_BY });
  });

  it('a second process opens the existing record (Duplicate → open), and rows written before a record are adopted', async () => {
    await history(() => ALICE).recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a ZDEMO_ONE',
    });
    // A second process: the record exists, so its create is a duplicate and
    // the store is opened; still one record.
    const again = history(() => ALICE);
    expect(await recall(again, 'ZDEMO_ONE')).toHaveLength(1);
    expect(
      (await records(newProvider())).filter(
        (r) => r.storeName === HISTORY_STORE,
      ),
    ).toHaveLength(1);

    // Rows without a record (the record was lost): adopted, not refused.
    await real.query(
      `DELETE FROM "${pgl.schema}"."rag_collections" WHERE "store_name" = $1`,
      [HISTORY_STORE],
    );
    const adopted = history(() => ALICE);
    expect(await recall(adopted, 'ZDEMO_ONE')).toHaveLength(1);
    expect(
      (await records(newProvider())).filter(
        (r) => r.storeName === HISTORY_STORE,
      ),
    ).toHaveLength(1);
  });

  it('a backend that is down: the turn fails quietly; after the cool-down the next use opens the store', async () => {
    const warnings: unknown[] = [];
    let now = 1_000_000;
    const rag = history(() => ALICE, { warnings, clock: () => now });
    down = true;
    expect(
      await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' }),
    ).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    down = false;
    now += HISTORY_OPEN_COOL_DOWN_MS;
    expect(
      await rag.recordTurn({
        owner: ALICE,
        userText: 'q',
        assistantText: 'a ZDEMO_LATER',
      }),
    ).toBe(true);
    expect(await recall(rag, 'ZDEMO_LATER')).toHaveLength(1);
  });
});

describe('a failed open is kept for a cool-down', () => {
  it('N calls in the window: one open attempt, one warning; after it, a new attempt', async () => {
    const warnings: unknown[] = [];
    let now = 5_000_000;
    const provider = newProvider();
    let attempts = 0;
    const create = provider.createCollection.bind(provider);
    provider.createCollection = async (name, opts) => {
      attempts++;
      return create(name, opts);
    };
    const rag = history(() => ALICE, {
      warnings,
      provider,
      clock: () => now,
    });
    down = true;
    for (let i = 0; i < 5; i++) {
      expect(
        await rag.recordTurn({
          owner: ALICE,
          userText: 'q',
          assistantText: 'a',
        }),
      ).toBe(false);
      expect((await rag.query(new TextOnlyEmbedding('q'), 5)).ok).toBe(false);
      now += 1000;
    }
    expect(attempts).toBe(1);
    expect(warnings).toHaveLength(1);

    // Still down after the window: one new attempt, one new warning.
    now += HISTORY_OPEN_COOL_DOWN_MS;
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(2);

    // Back up, after the next window: the store opens and the turn is kept.
    down = false;
    now += HISTORY_OPEN_COOL_DOWN_MS;
    expect(
      await rag.recordTurn({
        owner: ALICE,
        userText: 'q',
        assistantText: 'a ZDEMO_BACK',
      }),
    ).toBe(true);
    expect(attempts).toBe(3);
    expect(await recall(rag, 'ZDEMO_BACK')).toHaveLength(1);
  });
});

describe('ensureHistoryStore: create, then adopt, then open', () => {
  const rag = { tag: 'store' } as unknown as IRag;
  type Call = { adopt: boolean };
  type Created = Awaited<ReturnType<IRagProvider['createCollection']>>;

  /** A provider double: `create` decides each createCollection outcome. */
  function fakeProvider(
    create: (adopt: boolean) => Created,
    extra: Partial<IRagProvider> = {},
  ): { provider: IRagProvider; calls: Call[] } {
    const calls: Call[] = [];
    const provider: IRagProvider = {
      name: 'fake',
      kind: 'fake',
      editable: true,
      supportedScopes: ['global'],
      createCollection: async (_name, opts) => {
        const adopt = opts.adoptExisting === true;
        calls.push({ adopt });
        return create(adopt);
      },
      ...extra,
    };
    return { provider, calls };
  }
  const handles: Created = {
    ok: true,
    value: { rag, editor: {} as never },
  };

  it('Qdrant-like (adopt of a missing collection would fail): a plain create, adopt never asked', async () => {
    const { provider, calls } = fakeProvider((adopt) =>
      adopt
        ? {
            ok: false,
            error: new RagError(
              "Qdrant collection 'h_history' does not exist; adoptExisting takes over an existing store and creates nothing",
              'RAG_CREATE_ERROR',
            ),
          }
        : handles,
    );
    const r = await ensureHistoryStore(provider);
    expect(r.ok && r.value).toBe(rag);
    expect(calls).toEqual([{ adopt: false }]);
  });

  it('a store without a record (OrphanStoreError): adopted', async () => {
    const { provider, calls } = fakeProvider((adopt) =>
      adopt
        ? handles
        : { ok: false, error: new OrphanStoreError(HISTORY_STORE, 'orphan') },
    );
    const r = await ensureHistoryStore(provider);
    expect(r.ok && r.value).toBe(rag);
    expect(calls).toEqual([{ adopt: false }, { adopt: true }]);
  });

  it('any other failure: one attempt, the error returned', async () => {
    const { provider, calls } = fakeProvider(() => ({
      ok: false,
      error: new RagError('connect ECONNREFUSED', 'RAG_CREATE_ERROR'),
    }));
    const r = await ensureHistoryStore(provider);
    expect(!r.ok && r.error.message).toBe('connect ECONNREFUSED');
    expect(calls).toEqual([{ adopt: false }]);
  });

  it('a record already there (Duplicate): the existing record is opened', async () => {
    const record: RagCollectionRecord = {
      storeName: HISTORY_STORE,
      name: HISTORY_STORE,
      scope: 'global',
      attributes: { writtenBy: WRITTEN_BY },
    };
    const opened: string[] = [];
    const { provider, calls } = fakeProvider(
      () => ({
        ok: false,
        error: new DuplicateCollectionError(HISTORY_STORE, 'taken'),
      }),
      {
        describeCollections: async () => ({
          ok: true,
          value: { records: [record], rejected: [] },
        }),
        openCollection: async (rec) => {
          opened.push(rec.storeName);
          return handles;
        },
      },
    );
    const r = await ensureHistoryStore(provider);
    expect(r.ok && r.value).toBe(rag);
    expect(calls).toEqual([{ adopt: false }]);
    expect(opened).toEqual([HISTORY_STORE]);
  });

  it('pg shared layout: rows without a record are an orphan, then adopted', async () => {
    await history(() => ALICE).recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
    });
    await real.query(
      `DELETE FROM "${pgl.schema}"."rag_collections" WHERE "store_name" = $1`,
      [HISTORY_STORE],
    );
    const p = newProvider();
    const outcomes: string[] = [];
    const create = p.createCollection.bind(p);
    p.createCollection = async (name, opts) => {
      const r = await create(name, opts);
      outcomes.push(
        `${opts.adoptExisting ? 'adopt' : 'create'}:${r.ok ? 'ok' : r.error.constructor.name}`,
      );
      return r;
    };
    expect((await ensureHistoryStore(p)).ok).toBe(true);
    expect(outcomes).toEqual(['create:OrphanStoreError', 'adopt:ok']);
  });
});

describe('a foreign h_history record', () => {
  it.each([
    ['another writtenBy', { writtenBy: 'another-tool' }],
    ['no writtenBy', { note: 'x' }],
  ])('(%s) is refused and left untouched', async (_label, attributes) => {
    const p = newProvider();
    const made = await p.createCollection(HISTORY_STORE, {
      scope: 'global',
      collectionName: 'theirs',
      attributes,
    });
    expect(made.ok).toBe(true);
    const before = await records(p);

    const warnings: unknown[] = [];
    const rag = history(() => ALICE, { warnings });
    expect(
      await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' }),
    ).toBe(false);
    expect(JSON.stringify(warnings)).toContain('was not written by');
    expect(await records(newProvider())).toEqual(before);
    expect(await historyRows()).toEqual([]);
  });
});

describe('persistent recall', () => {
  it('with the production option shape { ragFilter: { sessionId } }', async () => {
    const aliceOther = turnOwner('alice@example.com', 's-other');
    const writer = history(() => ALICE);
    await writer.recordTurn({
      owner: ALICE,
      userText: 'kangaroo fence',
      assistantText: 'ZDEMO_THIS_SESSION',
    });
    await writer.recordTurn({
      owner: aliceOther,
      userText: 'kangaroo fence',
      assistantText: 'ZDEMO_OTHER_SESSION',
    });
    const r = await history(() => ALICE).query(
      new TextOnlyEmbedding('kangaroo fence'),
      10,
      { ragFilter: { sessionId: 's-1' } },
    );
    if (!r.ok) throw r.error;
    const texts = r.value.map((x) => x.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('ZDEMO_THIS_SESSION');
  });

  // The options openai-handler builds, after the pipeline's `history` stage
  // merges `sessionId` into them: a namespace no turn carries, an exposition,
  // and the session.
  const productionOptions = (userId: string, sessionId: string) => ({
    sessionId,
    ragFilter: {
      namespace: `${userId}:DEST`,
      exposition: ['readonly'],
      sessionId,
    },
  });

  it('with the full production options (namespace + exposition + sessionId) the turns are recalled', async () => {
    await history(() => ALICE).recordTurn({
      owner: ALICE,
      userText: 'kangaroo fence',
      assistantText: 'ZDEMO_RECALLED',
    });
    const r = await history(() => ALICE).query(
      new TextOnlyEmbedding('kangaroo fence'),
      10,
      productionOptions('alice@example.com', 's-1'),
    );
    if (!r.ok) throw r.error;
    const texts = r.value.map((x) => x.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('ZDEMO_RECALLED');
  });

  it('with the full production options another owner never sees the turns', async () => {
    await history(() => ALICE).recordTurn({
      owner: ALICE,
      userText: 'kangaroo fence',
      assistantText: 'ZDEMO_ALICE',
    });
    // Bob asks with Alice's session id in the filter: the owner decides.
    const r = await history(() => BOB).query(
      new TextOnlyEmbedding('kangaroo fence'),
      10,
      productionOptions('bob@example.com', 's-1'),
    );
    if (!r.ok) throw r.error;
    expect(r.value).toEqual([]);
    // No owner at all: nothing, whatever the filter says.
    const none = await history(() => undefined).query(
      new TextOnlyEmbedding('kangaroo fence'),
      10,
      productionOptions('alice@example.com', 's-1'),
    );
    if (!none.ok) throw none.error;
    expect(none.value).toEqual([]);
  });

  it('two turns of one owner in the same millisecond are both stored', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const rag = history(() => ALICE);
      for (const n of ['ZDEMO_FIRST', 'ZDEMO_SECOND'])
        expect(
          await rag.recordTurn({
            owner: ALICE,
            userText: 'q',
            assistantText: n,
          }),
        ).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const rows = await historyRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.id.startsWith(`turn:${ALICE}:1700000000000:`)).toBe(true);
      expect(r.id).toMatch(/:[0-9a-f]{8}$/);
    }
  });

  it('works across a restart: a new SessionHistoryRag over a new provider', async () => {
    const before = history(() => ALICE);
    await before.recordTurn({
      owner: ALICE,
      userText: 'create a domain for kangaroo fences',
      assistantText: 'Created ZDEMO_KANGAROO_FENCE',
    });
    await pgl.restart();
    const after = history(() => ALICE);
    const texts = await recall(after, 'kangaroo fence domain');
    expect(texts.some((t) => t.includes('ZDEMO_KANGAROO_FENCE'))).toBe(true);
    // Still scoped: Bob's conversation sees nothing of Alice's.
    expect(
      await recall(
        history(() => BOB),
        'kangaroo fence domain',
      ),
    ).toEqual([]);
  });

  it('a turn carries userId, sessionId and createdAt (ISO); owner stays', async () => {
    const rag = history(() => ALICE);
    await rag.recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
      id: 'turn:meta',
    });
    const [row] = await historyRows();
    expect(row.id).toBe('turn:meta');
    expect(row.metadata).toMatchObject({
      owner: ALICE,
      userId: 'alice@example.com',
      sessionId: 's-1',
    });
    const createdAt = row.metadata.createdAt as string;
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });
});

describe('listTurns', () => {
  it("listTurns returns an owner's turns oldest first and parses User/Assistant text", async () => {
    const rag = history(() => ALICE);
    const long = `created ZDEMO_LONG ${'x'.repeat(1300)}`;
    await rag.recordTurn({
      owner: ALICE,
      userText: 'make a domain\nnamed kangaroo',
      assistantText: 'created ZDEMO_KANGAROO',
    });
    await rag.recordTurn({ owner: BOB, userText: 'bob', assistantText: 'b' });
    await rag.recordTurn({
      owner: ALICE,
      userText: 'and a long one',
      assistantText: long,
    });
    await rag.recordTurn({
      owner: ALICE,
      userText: 'thanks',
      assistantText: 'you are welcome',
    });

    // A new process: nothing cached, everything from the store.
    const turns = await history(() => undefined).listTurns(ALICE);
    expect(turns.map((t) => t.userText)).toEqual([
      'make a domain\nnamed kangaroo',
      'and a long one',
      'thanks',
    ]);
    expect(turns[0].assistantText).toBe('created ZDEMO_KANGAROO');
    // The stored answer is clipped; the names line is not part of it.
    expect(turns[1].assistantText.startsWith('created ZDEMO_LONG')).toBe(true);
    expect(turns[1].assistantText).not.toContain('Objects:');
    expect(turns[2].assistantText).toBe('you are welcome');
    for (const t of turns) {
      expect(typeof t.id).toBe('string');
      expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt);
    }
    const order = turns.map((t) => t.createdAt);
    expect(order).toEqual([...order].sort());
  });

  it('is empty for an owner with no turns', async () => {
    await expect(history(() => ALICE).listTurns(ALICE)).resolves.toEqual([]);
  });
});

describe('forget', () => {
  it('removes only that owner, also after a restart (no in-process ids)', async () => {
    const writer = history(() => ALICE);
    for (const owner of [ALICE, ALICE, BOB])
      await writer.recordTurn({ owner, userText: 'q', assistantText: 'a' });
    expect(await historyRows()).toHaveLength(3);

    // A fresh instance holds no ids: forget must not rely on them.
    const fresh = history(() => ALICE);
    expect(fresh.turnCount(ALICE)).toBe(0);
    await fresh.forgetOwner(ALICE);
    const left = await historyRows();
    expect(left.map((r) => r.metadata.owner)).toEqual([BOB]);
  });

  it('a failing deleteWhere is logged and does not throw', async () => {
    const warnings: unknown[] = [];
    const rag = history(() => ALICE, { warnings });
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    down = true;
    await expect(rag.forgetOwner(ALICE)).resolves.toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('the cap', () => {
  it('keeps the newest turns of the owner, by createdAt, from the store', async () => {
    const rag = history(() => ALICE, { cap: 3 });
    // Ids that sort opposite to time: the cap must order by createdAt.
    for (let i = 0; i < 5; i++)
      await rag.recordTurn({
        owner: ALICE,
        userText: `q${i}`,
        assistantText: `a${i}`,
        id: `turn:${9 - i}`,
      });
    await rag.recordTurn({ owner: BOB, userText: 'q', assistantText: 'a' });
    const rows = await historyRows();
    const alice = rows.filter((r) => r.metadata.owner === ALICE);
    expect(alice.map((r) => r.id).sort()).toEqual([
      'turn:5',
      'turn:6',
      'turn:7',
    ]);
    expect(rows.filter((r) => r.metadata.owner === BOB)).toHaveLength(1);
    expect(rag.turnCount(ALICE)).toBe(3);
  });

  it('applies across a restart: turns written by an earlier process count', async () => {
    const first = history(() => ALICE, { cap: 2 });
    for (let i = 0; i < 2; i++)
      await first.recordTurn({
        owner: ALICE,
        userText: `q${i}`,
        assistantText: `a${i}`,
        id: `turn:old${i}`,
      });
    const second = new SessionHistoryRag(
      new PersistentHistoryStore(newProvider()),
      () => ALICE,
      2,
      { now: () => new Date('2027-01-01T00:00:00.000Z') },
    );
    await second.recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
      id: 'turn:new',
    });
    expect((await historyRows()).map((r) => r.id)).toEqual([
      'turn:new',
      'turn:old1',
    ]);
  });

  it('a failing delete is logged and does not break the turn', async () => {
    const warnings: unknown[] = [];
    const log = { warn: (m: string, d?: unknown) => warnings.push({ m, d }) };
    const store = new PersistentHistoryStore(newProvider(), log);
    const realWriter = store.writer.bind(store);
    store.writer = () => ({
      ...realWriter(),
      deleteByIdRaw: async () => {
        throw new Error('delete refused');
      },
    });
    const rag = new SessionHistoryRag(store, () => ALICE, 1, {
      log,
      now: steppingClock(),
    });
    for (let i = 0; i < 2; i++)
      expect(
        await rag.recordTurn({
          owner: ALICE,
          userText: `q${i}`,
          assistantText: `a${i}`,
        }),
      ).toBe(true);
    expect(JSON.stringify(warnings)).toContain('delete failed');
    // The delete never happened: both turns are still there.
    expect(await historyRows()).toHaveLength(2);
  });

  it('defaults to 200', () => {
    const rag = new SessionHistoryRag(
      new PersistentHistoryStore(newProvider()),
      () => ALICE,
    );
    expect(rag.maxTurns).toBe(200);
  });
});

describe('restore and the catalog sweep leave the history record alone', () => {
  beforeEach(async () => {
    await history(() => ALICE).recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
    });
  });

  it('restore: neither a collection nor a foreign record', async () => {
    const p = newProvider();
    const opened: string[] = [];
    const open = p.openCollection.bind(p);
    p.openCollection = async (rec) => {
      opened.push(rec.storeName);
      return open(rec);
    };
    const r = await createCollectionPersistence(p, 'fp-test').restore();
    if (!r.ok) throw r.error;
    expect(r.value.collections).toEqual([]);
    expect(r.value.foreign).toEqual([]);
    expect(opened).toEqual([]);

    const reg = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence: createCollectionPersistence(newProvider(), 'fp-test'),
    });
    await reg.ready;
    expect(reg.restoreStatus().state).toBe('ready');
    expect(await reg.listCollections('alice@example.com')).toEqual([]);
  });

  it('the sweep: not an expired session, the record and its rows stay', async () => {
    const persistence = createCollectionPersistence(newProvider(), 'fp-test');
    const expired = await persistence.expiredSessions(Date.now() + 1e12);
    if (!expired.ok) throw expired.error;
    expect(expired.value).toEqual([]);

    const reg = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence,
    });
    await reg.ready;
    await reg.sweepExpiredSessions(() => true);
    expect(
      (await records(newProvider())).some((r) => r.storeName === HISTORY_STORE),
    ).toBe(true);
    expect(await historyRows()).toHaveLength(1);
  });
});
