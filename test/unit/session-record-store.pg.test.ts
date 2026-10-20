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
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
}));

import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  createCollectionPersistence,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
import {
  isSessionRecordStore,
  ProviderSessionRecordStore,
  SESSION_RECORD_STORE_NAME,
} from '../../srv/lib/session-record-store';
import { CollectionRegistry } from '../../srv/rag-collections';
import { type PgliteHandle, startPglite } from './helpers/pglite';
import {
  record,
  sessionRecordStoreContract,
} from './helpers/session-record-store-contract';

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

function newStore(): ProviderSessionRecordStore {
  return new ProviderSessionRecordStore(newProvider(), { dimension: DIM });
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

describe('ProviderSessionRecordStore on PG', () => {
  sessionRecordStoreContract(async () => newStore());

  it('a second store (a restarted hub) reads what the first wrote', async () => {
    const r = record({ destination: 'S4H' });
    await newStore().put(r);
    expect(await newStore().get(r.userId, r.key)).toEqual(r);
  });

  it('catalogs h_sessions as a global hub record; rows carry the owner, no secrets', async () => {
    const r = record();
    await newStore().put(r);
    const d = await newProvider().describeCollections();
    if (!d.ok) throw d.error;
    const rec = d.value.records.find(
      (x) => x.storeName === SESSION_RECORD_STORE_NAME,
    );
    expect(rec).toMatchObject({
      scope: 'global',
      attributes: { writtenBy: WRITTEN_BY, source: 'sessions' },
    });
    expect(rec && isSessionRecordStore(rec)).toBe(true);
    const { rows } = await real.query(
      `SELECT "id", "text", "metadata" FROM "${pgl.schema}"."rag_documents" WHERE "collection" = $1`,
      [SESSION_RECORD_STORE_NAME],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`session:${r.key}`);
    expect(JSON.parse(String(rows[0].text))).toEqual(r);
    const meta =
      typeof rows[0].metadata === 'string'
        ? JSON.parse(rows[0].metadata)
        : rows[0].metadata;
    expect(meta).toMatchObject({ userId: r.userId, sessionId: r.key });
  });
});

describe('restore ignores the record store', () => {
  beforeEach(async () => {
    await newStore().put(record());
  });

  it('restore: neither a collection nor a foreign record', async () => {
    const r = await createCollectionPersistence(
      newProvider(),
      'fp-test',
    ).restore();
    if (!r.ok) throw r.error;
    expect(r.value.collections).toEqual([]);
    expect(r.value.foreign).toHaveLength(0);

    const reg = new CollectionRegistry({
      embedder,
      defaultBackend: 'pg-vector',
      persistence: createCollectionPersistence(newProvider(), 'fp-test'),
    });
    await reg.ready;
    expect(reg.restoreStatus().state).toBe('ready');
    expect(await reg.listCollections('alice@example.com')).toEqual([]);
  });

  it('the sweep: not an expired session, the record stays', async () => {
    const persistence = createCollectionPersistence(newProvider(), 'fp-test');
    const expired = await persistence.expiredSessions(Date.now() + 1e12);
    if (!expired.ok) throw expired.error;
    expect(expired.value).toEqual([]);
    expect(await newStore().get(record().userId, record().key)).toEqual(
      record(),
    );
  });
});
