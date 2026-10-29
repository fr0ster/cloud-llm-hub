import { dialogueId } from '../../srv/lib/dialogue-store';

/**
 * The long-session record store over a real PgVectorRagProvider (shared
 * layout) on PGlite: the shared contract, the `h_sessions` catalog record and
 * its rows, and that restore and the expiry sweep leave that record alone.
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

import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  createCollectionPersistence,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
import { ProviderDialogueStore } from '../../srv/lib/dialogue-store';
import { type PgliteHandle, startPglite } from './helpers/pglite';

jest.setTimeout(120_000);

const DIM = 8;

/** Writes never embed; the registry below needs an embedder for its own use. */
const embedder = symmetricEmbedder({
  embed: async () => {
    throw new Error('not embedded in these tests');
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

function scopedStore(store: ProviderDialogueStore) {
  return {
    save: (id: string, state: typeof record) => store.save('alice', id, state),
    load: (id: string) => store.load('alice', id),
    delete: (id: string) => store.delete('alice', id),
  };
}
function newStore() {
  return scopedStore(
    new ProviderDialogueStore(newProvider(), { dimension: DIM }),
  );
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
  await real.query(
    `TRUNCATE "${pgl.schema}"."rag_documents", "${pgl.schema}"."rag_collections"`,
  );
});

const record = {
  conversation: [{ role: 'user' as const, content: 'hello' }],
  plan: 'r',
  tasks: [],
  pending: [],
  savedAt: 1,
};
it('provider store round-trips a record on PGlite and keeps only the last run', async () => {
  await newStore().save('session', record);
  expect(await newStore().load('session')).toEqual(record);
  await newStore().save('session', { ...record, plan: 'last' });
  expect((await newStore().load('session'))?.plan).toBe('last');
  const d = await newProvider().describeCollections();
  if (!d.ok) throw d.error;
  expect(
    d.value.records.find((r) => r.storeName === 'h_dialogue'),
  ).toMatchObject({
    scope: 'global',
    attributes: { writtenBy: WRITTEN_BY, source: 'dialogue' },
  });
  await newStore().delete('session');
  expect(await newStore().load('session')).toBeUndefined();
});
it('provider load of an unknown session returns undefined', async () => {
  expect(await newStore().load('unknown')).toBeUndefined();
});
it('round trips a multibyte archive larger than the former 2 MiB limit', async () => {
  const store = new ProviderDialogueStore(newProvider(), { dimension: DIM });
  const value = {
    ...record,
    requestSeq: 1,
    taskRequests: { task: 'r1' },
    requests: [
      {
        id: 'r1',
        openedAt: 1,
        text: 'hello',
        replies: ['m1'],
        transcript: record.conversation,
      },
    ],
    messages: [
      {
        id: 'm1',
        text: 'я'.repeat(2_000_000),
        createdAt: 1,
        trigger: 'user' as const,
      },
    ],
  };
  await store.save('alice', 'large', value);
  expect(await store.load('alice', 'large')).toEqual(value);
});

it.each([
  '{bad',
  '{}',
  JSON.stringify({
    ...record,
    conversation: [{ role: 'user', content: 'x'.repeat(20001) }],
  }),
  JSON.stringify({
    ...record,
    conversation: Array(201).fill({ role: 'user', content: 'x' }),
  }),
  JSON.stringify({ ...record, tasks: Array(51).fill({}) }),
])('malformed or oversized row is ignored with a warning: %#', async (text) => {
  const p = newProvider();
  const store = scopedStore(
    new ProviderDialogueStore(p, {
      dimension: DIM,
      log: { warn },
    }),
  );
  await store.save('bad', record);
  const catalog = await p.describeCollections();
  if (!catalog.ok) throw catalog.error;
  const catalogRecord = catalog.value.records.find(
    (r) => r.storeName === 'h_dialogue',
  );
  if (!catalogRecord) throw new Error('missing catalog record');
  const opened = await p.openCollection(catalogRecord);
  if (!opened.ok) throw opened.error;
  const writer = opened.value.rag.writer?.();
  if (!writer?.upsertPrecomputedRaw) throw new Error('missing writer');
  const w = await writer.upsertPrecomputedRaw(
    dialogueId('alice', 'bad'),
    text,
    Array(DIM).fill(0),
    { userId: 'alice', sessionId: 'bad', savedAt: Date.now() },
  );
  if (!w.ok) throw w.error;
  expect(await store.load('bad')).toBeUndefined();
  expect(warn).toHaveBeenCalledWith('Skipped a malformed dialogue state', {
    id: dialogueId('alice', 'bad'),
  });
});
const warn = jest.fn();
it('collection restore and expiry leave h_dialogue alone', async () => {
  await newStore().save('session', record);
  const persistence = createCollectionPersistence(newProvider(), 'test');
  const restored = await persistence.restore();
  if (!restored.ok) throw restored.error;
  expect(restored.value.collections).toEqual([]);
  expect(restored.value.foreign).toEqual([]);
  const expired = await persistence.expiredSessions(Date.now());
  if (!expired.ok) throw expired.error;
  expect(expired.value).toEqual([]);
  expect((await newStore().load('session'))?.plan).toBe('r');
});

it('provider index tracks save, load, delete and TTL without refreshing savedAt', async () => {
  const store = new ProviderDialogueStore(newProvider(), {
    dimension: DIM,
    ttlMs: 100,
  });
  const scoped = scopedStore(store);
  const start = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(start);
  try {
    await scoped.save('indexed', record);
    expect(store.hasDialogueState('alice', 'indexed')).toBe(true);
    expect(store.hasDialogueState('bob', 'indexed')).toBe(false);
    const restored = new ProviderDialogueStore(newProvider(), {
      dimension: DIM,
      ttlMs: 100,
    });
    expect(restored.hasDialogueState('alice', 'indexed')).toBe(false);
    expect(await scopedStore(restored).load('indexed')).toBeDefined();
    expect(restored.hasDialogueState('alice', 'indexed')).toBe(true);
    await restored.delete('alice', 'indexed');
    expect(restored.hasDialogueState('alice', 'indexed')).toBe(false);
    await scoped.save('indexed', record);
    now.mockReturnValue(start + 101);
    expect(store.hasDialogueState('alice', 'indexed')).toBe(false);
    expect(await scoped.load('indexed')).toBeUndefined();
    expect(
      await scopedStore(
        new ProviderDialogueStore(newProvider(), { dimension: DIM }),
      ).load('indexed'),
    ).toBeUndefined();
  } finally {
    now.mockRestore();
  }
});

it('sweeps expired previous-process records without loading sessions and keeps fresh and malformed rows', async () => {
  const start = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(start);
  try {
    await newStore().save('expired', record);
    now.mockReturnValue(start + 101);
    await newStore().save('fresh', record);
    const provider = newProvider();
    const catalog = await provider.describeCollections();
    if (!catalog.ok) throw catalog.error;
    const entry = catalog.value.records.find(
      (r) => r.storeName === 'h_dialogue',
    );
    if (!entry) throw new Error('missing h_dialogue');
    const opened = await provider.openCollection(entry);
    if (!opened.ok) throw opened.error;
    const writer = opened.value.rag.writer?.();
    if (!writer?.upsertPrecomputedRaw) throw new Error('missing writer');
    await writer.upsertPrecomputedRaw('malformed', '{bad', Array(DIM).fill(0), {
      savedAt: start,
    });
    const warn = jest.fn();
    const restarted = new ProviderDialogueStore(newProvider(), {
      dimension: DIM,
      ttlMs: 100,
      log: { warn },
    });
    await restarted.sweepExpired(start + 101);
    const rows = await real.query(
      `SELECT id FROM "${pgl.schema}"."rag_documents"`,
    );
    expect(rows.rows.map((r) => r.id).sort()).toEqual(
      ['malformed', dialogueId('alice', 'fresh')].sort(),
    );
    expect(warn).toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it('equal session keys remain isolated across owners after restart', async () => {
  const store = new ProviderDialogueStore(newProvider(), { dimension: DIM });
  await store.save('alice', 'same', record);
  await store.save('bob', 'same', { ...record, plan: 'bob' });
  const restored = new ProviderDialogueStore(newProvider(), { dimension: DIM });
  expect(await restored.load('alice', 'same')).toEqual(record);
  expect((await restored.load('bob', 'same'))?.plan).toBe('bob');
  await restored.delete('alice', 'same');
  expect(await restored.load('alice', 'same')).toBeUndefined();
  expect((await restored.load('bob', 'same'))?.plan).toBe('bob');
});

it('persists hub outbox with state and restores it through a new provider', async () => {
  const outbox = [
    {
      id: 'stable',
      text: 'delivered later',
      createdAt: 123,
      trigger: 'event' as const,
    },
  ];
  await new ProviderDialogueStore(newProvider(), { dimension: DIM }).save(
    'alice',
    'replay',
    { ...record, outbox },
  );
  const restored = await new ProviderDialogueStore(newProvider(), {
    dimension: DIM,
  }).load('alice', 'replay');
  expect(restored).toEqual({ ...record, outbox });
});
