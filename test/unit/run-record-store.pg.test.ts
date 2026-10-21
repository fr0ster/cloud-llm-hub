import { runRecordId } from '../../srv/lib/run-record-store';
import { scopedStore } from './helpers/scoped-run-store';

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
import { ProviderRunRecordStore } from '../../srv/lib/run-record-store';
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

function newStore() {
  return scopedStore(
    new ProviderRunRecordStore(newProvider(), { dimension: DIM }),
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
  runId: 'r',
  request: 'hello',
  plan: {
    steps: [{ id: 'a', kind: 'answer' as const, text: 'hello' }],
    createdAt: 1,
  },
  steps: [
    {
      stepId: 'a',
      kind: 'answer' as const,
      run: 1,
      status: 'done' as const,
      output: 'x'.repeat(5000),
      durationMs: 1,
    },
  ],
  outcome: 'answered' as const,
  finishedAt: 2,
};
it('provider store round-trips a record on PGlite and keeps only the last run', async () => {
  await newStore().save('session', record);
  expect(await newStore().load('session')).toEqual({
    ...record,
    steps: [{ ...record.steps[0], output: 'x'.repeat(4000) }],
  });
  await newStore().save('session', { ...record, runId: 'last' });
  expect((await newStore().load('session'))?.runId).toBe('last');
  const d = await newProvider().describeCollections();
  if (!d.ok) throw d.error;
  expect(d.value.records.find((r) => r.storeName === 'h_runs')).toMatchObject({
    scope: 'global',
    attributes: { writtenBy: WRITTEN_BY, source: 'runs' },
  });
  await newStore().delete('session');
  expect(await newStore().load('session')).toBeUndefined();
});
it('provider load of an unknown session returns undefined', async () => {
  expect(await newStore().load('unknown')).toBeUndefined();
});
it.each([
  '{bad',
  '{}',
  JSON.stringify({
    ...record,
    steps: [{ ...record.steps[0], durationMs: 'bad' }],
  }),
  JSON.stringify({
    ...record,
    plan: { steps: [{ id: 'bad', kind: 'work' }], createdAt: 1 },
  }),
])('malformed row is ignored with a warning: %s', async (text) => {
  const p = newProvider();
  const store = scopedStore(
    new ProviderRunRecordStore(p, {
      dimension: DIM,
      log: { warn },
    }),
  );
  await store.save('bad', record);
  const catalog = await p.describeCollections();
  if (!catalog.ok) throw catalog.error;
  const catalogRecord = catalog.value.records.find(
    (r) => r.storeName === 'h_runs',
  );
  if (!catalogRecord) throw new Error('missing catalog record');
  const opened = await p.openCollection(catalogRecord);
  if (!opened.ok) throw opened.error;
  const writer = opened.value.rag.writer?.();
  if (!writer?.upsertPrecomputedRaw) throw new Error('missing writer');
  const w = await writer.upsertPrecomputedRaw(
    runRecordId('alice', 'bad'),
    text,
    Array(DIM).fill(0),
    { userId: 'alice', sessionId: 'bad', savedAt: Date.now() },
  );
  if (!w.ok) throw w.error;
  expect(await store.load('bad')).toBeUndefined();
  expect(warn).toHaveBeenCalledWith('Skipped a malformed run record', {
    id: runRecordId('alice', 'bad'),
  });
});
const warn = jest.fn();
it('collection restore and expiry leave h_runs alone', async () => {
  await newStore().save('session', record);
  const persistence = createCollectionPersistence(newProvider(), 'test');
  const restored = await persistence.restore();
  if (!restored.ok) throw restored.error;
  expect(restored.value.collections).toEqual([]);
  expect(restored.value.foreign).toEqual([]);
  const expired = await persistence.expiredSessions(Date.now());
  if (!expired.ok) throw expired.error;
  expect(expired.value).toEqual([]);
  expect((await newStore().load('session'))?.runId).toBe('r');
});
