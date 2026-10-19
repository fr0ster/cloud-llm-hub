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
  type RagCollectionRecord,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  createCollectionPersistence,
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
  opts: { cap?: number; warnings?: unknown[] } = {},
): SessionHistoryRag {
  const log = {
    warn: (m: string, d?: unknown) => opts.warnings?.push({ m, d }),
  };
  return new SessionHistoryRag(
    new PersistentHistoryStore(newProvider(), log),
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

  it('a backend that is down: the turn fails quietly, and the next use opens the store', async () => {
    const warnings: unknown[] = [];
    const rag = history(() => ALICE, { warnings });
    down = true;
    expect(
      await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' }),
    ).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    down = false;
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

describe('persistent recall', () => {
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
    await expect(rag.forgetOwner(ALICE)).resolves.toBeUndefined();
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
