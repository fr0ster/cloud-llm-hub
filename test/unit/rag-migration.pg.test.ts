import {
  checkRagAccess,
  isRagScanner,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  createPgVectorRagAccessStores,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import { hubAccessDecision } from '../../srv/lib/rag-access';
import { migrateRagData } from '../../srv/lib/rag-migration';
import { PROVIDER_DEFAULT_DIMENSION } from '../../srv/lib/rag-provider-factory';
import { type PgliteHandle, startPglite } from './helpers/pglite';

const dimension = PROVIDER_DEFAULT_DIMENSION;
let pgl: PgliteHandle;
let client: Awaited<ReturnType<typeof createPgClient>>;
beforeAll(async () => {
  pgl = await startPglite({ dimension });
  client = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'migration-test',
    poolMax: 1,
  });
});
afterAll(async () => {
  await client?.end();
  await pgl?.stop();
});

test('user collection documents without userId keep their owner after migration', async () => {
  const provider = new PgVectorRagProvider({
    name: 'migration-test',
    embedder: symmetricEmbedder({
      embed: async () => ({ vector: new Array<number>(dimension).fill(1) }),
    }),
    connection: {
      collectionName: 'migration-test',
      dimension,
      schema: pgl.schema,
      layout: 'shared',
    },
    layout: 'shared',
    clientFactory: () => ({
      query: (sql, params) => client.query(sql, params),
      end: async () => {},
    }),
  });
  const created = await provider.createCollection('notes', {
    scope: 'user',
    userId: 'u1',
  });
  if (!created.ok) throw created.error;
  await client.query(
    `INSERT INTO "${pgl.schema}"."rag_documents" (collection, id, text, vector, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
    [
      'notes',
      'legacy',
      'private knowledge',
      JSON.stringify(new Array<number>(dimension).fill(1)),
      JSON.stringify({ custom: 'kept' }),
    ],
  );
  const log = jest.fn();
  expect(await migrateRagData(provider, 'pg-vector', log)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await migrateRagData(provider, 'pg-vector', log)).toEqual({
    ok: true,
    value: undefined,
  });
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  const record = catalog.value.records.find((row) => row.storeName === 'notes');
  expect(record).toMatchObject({ scope: 'user', userId: 'u1' });
  if (!record) throw new Error('Missing notes');
  const opened = await provider.openCollection(record);
  if (!opened.ok) throw opened.error;
  if (!isRagScanner(opened.value.rag)) throw new Error('Missing scanner');
  const rows = await opened.value.rag.scan({});
  if (!rows.ok) throw rows.error;
  expect(rows.value.records).toHaveLength(1);
  expect(rows.value.records[0]).toMatchObject({
    id: 'legacy',
    metadata: { ownerScope: 'user', userId: 'u1', custom: 'kept' },
  });
  const stores = createPgVectorRagAccessStores(provider);
  for (const [userId, isAdmin, allowed] of [
    ['u1', false, true],
    ['u2', false, false],
    ['admin', true, false],
  ] as const) {
    const caller = { sessionId: `s-${userId}`, userId, isAdmin };
    expect((await stores.bindings.bind(caller.sessionId, userId)).ok).toBe(
      true,
    );
    const result = await checkRagAccess(
      caller,
      { name: 'notes', owner: { scope: 'user', userId: 'u1' } },
      'read',
      { ...stores, decision: hubAccessDecision() },
    );
    expect(result.ok).toBe(allowed);
  }
});
