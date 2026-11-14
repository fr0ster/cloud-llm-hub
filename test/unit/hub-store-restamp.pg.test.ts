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

import {
  isRagFilteredDeleter,
  isRagScanner,
  symmetricEmbedder,
  validateRagMetadata,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgClient,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import { restampHubStores } from '../../srv/lib/hub-store-restamp';
import {
  forgetScopedPlannerMemory,
  scopedPlannerMemory,
} from '../../srv/lib/planner-memory-scope';
import { PROVIDER_DEFAULT_DIMENSION } from '../../srv/lib/rag-provider-factory';
import { type PgliteHandle, startPglite } from './helpers/pglite';

jest.setTimeout(120_000);

const DIM = PROVIDER_DEFAULT_DIMENSION;

/** Writes never embed; the registry below needs an embedder for its own use. */
const embed = jest.fn(async (_text: string) => ({
  vector: new Array<number>(DIM).fill(1),
}));
const embedder = symmetricEmbedder({ embed });

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

beforeEach(async () => {
  await real.query(
    `TRUNCATE "${pgl.schema}"."rag_documents", "${pgl.schema}"."rag_collections"`,
  );
});

const names = ['h_dialogue', 'h_runs', 'h_sessions', 'h_planner_memory'];

it('restamps legacy rows once, preserving ids, text, other metadata and zero vectors', async () => {
  const provider = newProvider();
  const zero = new Array<number>(DIM).fill(0);
  for (const name of names) {
    const created = await provider.createCollection(name, { scope: 'global' });
    if (!created.ok) throw created.error;
    // SQL seeds pre-v32 metadata, which the current writer correctly rejects.
    await real.query(
      `INSERT INTO "${pgl.schema}"."rag_documents" (collection, id, text, vector, metadata)
       VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
      [
        name,
        'legacy',
        `text:${name}`,
        JSON.stringify(zero),
        JSON.stringify({
          sessionId: name === 'h_planner_memory' ? '["alice","s1"]' : 's1',
          userId: 'alice',
          savedAt: 123,
          custom: 'kept',
        }),
      ],
    );
    const writer = created.value.rag.writer?.();
    if (!writer?.upsertPrecomputedRaw) throw new Error('Missing writer');
    const current = await writer.upsertPrecomputedRaw(
      'current',
      'already stamped',
      zero,
      {
        hubSessionId: 's2',
        authorUserId: 'bob',
      },
    );
    if (!current.ok) throw current.error;
  }
  embed.mockClear();
  expect(await restampHubStores(provider)).toEqual({
    ok: true,
    value: { rewritten: 5 },
  });
  // Both legacy planner-memory shapes are re-embedded.
  expect(embed).toHaveBeenCalledTimes(2);
  expect(embed.mock.calls.map(([text]) => text).sort()).toEqual([
    'already stamped',
    'text:h_planner_memory',
  ]);
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  for (const record of catalog.value.records) {
    const opened = await provider.openCollection(record);
    if (!opened.ok) throw opened.error;
    const rag = opened.value.rag;
    if (!isRagScanner(rag)) throw new Error('Missing scanner');
    const rows = await rag.scan();
    if (!rows.ok) throw rows.error;
    expect(rows.value.records).toHaveLength(2);
    const row = rows.value.records.find((r) => r.id === 'legacy');
    expect(row).toEqual({
      id: 'legacy',
      text: `text:${record.storeName}`,
      metadata: expect.objectContaining({
        ...(record.storeName === 'h_planner_memory'
          ? { namespace: '["alice","s1"]' }
          : { hubSessionId: 's1' }),
        authorUserId: 'alice',
        savedAt: 123,
        custom: 'kept',
      }),
    });
    if (record.storeName === 'h_planner_memory') {
      expect(row?.metadata).not.toHaveProperty('hubSessionId');
      const current = rows.value.records.find((r) => r.id === 'current');
      expect(current?.metadata.namespace).toBe('s2');
      expect(current?.metadata).not.toHaveProperty('sessionId');
      expect(current?.metadata).not.toHaveProperty('hubSessionId');
    }
    expect(row?.metadata).not.toHaveProperty('sessionId');
    expect(row?.metadata).not.toHaveProperty('userId');
    expect(() => validateRagMetadata(row?.metadata ?? {})).not.toThrow();
  }
  const vectors = await real.query(
    `SELECT collection, vector::text AS vector FROM "${pgl.schema}"."rag_documents" WHERE id = $1`,
    ['legacy'],
  );
  for (const row of vectors.rows) {
    if (typeof row.vector !== 'string') throw new Error('Invalid vector');
    expect(JSON.parse(row.vector)).toEqual(
      row.collection === 'h_planner_memory'
        ? new Array<number>(DIM).fill(1)
        : zero,
    );
  }
  expect(await restampHubStores(provider)).toEqual({
    ok: true,
    value: { rewritten: 0 },
  });
  expect(embed).toHaveBeenCalledTimes(2);
});

it('reports conflicting keys without changing owners and still rewrites clean rows', async () => {
  const provider = newProvider();
  const fixtures = [
    {
      store: 'h_planner_memory',
      id: 'planner-conflict',
      metadata: { namespace: 'alice-owner', hubSessionId: 'bob-owner' },
      keys: ['hubSessionId', 'namespace'],
    },
    {
      store: 'h_planner_memory',
      id: 'legacy-conflict',
      metadata: { sessionId: 'alice-owner', hubSessionId: 'bob-owner' },
      keys: ['hubSessionId', 'sessionId'],
    },
    {
      store: 'h_dialogue',
      id: 'dialogue-conflict',
      metadata: { authorUserId: 'alice-owner', userId: 'bob-owner' },
      keys: ['authorUserId', 'userId'],
    },
    {
      store: 'h_dialogue',
      id: 'session-conflict',
      metadata: { sessionId: 'alice-session', hubSessionId: 'bob-session' },
      keys: ['hubSessionId', 'sessionId'],
    },
  ];
  const zero = new Array<number>(DIM).fill(0);
  for (const store of ['h_planner_memory', 'h_dialogue']) {
    const created = await provider.createCollection(store, { scope: 'global' });
    if (!created.ok) throw created.error;
    for (const fixture of fixtures.filter((row) => row.store === store)) {
      await real.query(
        `INSERT INTO "${pgl.schema}"."rag_documents" (collection, id, text, vector, metadata)
         VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
        [
          store,
          fixture.id,
          fixture.id,
          JSON.stringify(zero),
          JSON.stringify(fixture.metadata),
        ],
      );
    }
    await real.query(
      `INSERT INTO "${pgl.schema}"."rag_documents" (collection, id, text, vector, metadata)
       VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
      [
        store,
        'clean',
        'clean',
        JSON.stringify(zero),
        JSON.stringify({
          sessionId: 'clean-owner',
          userId: 'clean-user',
          authorUserId: 'clean-user',
          ...(store === 'h_planner_memory'
            ? { namespace: 'clean-owner', hubSessionId: 'clean-owner' }
            : { hubSessionId: 'clean-owner' }),
        }),
      ],
    );
  }
  const before = await real.query(
    `SELECT collection, id, text, vector::text AS vector, metadata FROM "${pgl.schema}"."rag_documents" WHERE id <> 'clean' ORDER BY collection, id`,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await restampHubStores(provider);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected restamp conflict');
    expect(result.error.code).toBe('HUB_RESTAMP_CONFLICT');
    const expected = fixtures.map(({ store, id, keys }) => ({
      storeName: store,
      rowId: id,
      keys,
    }));
    expect(
      JSON.parse(result.error.message.replace('Hub restamp conflicts: ', '')),
    ).toEqual(expect.arrayContaining(expected));
    expect(
      JSON.parse(result.error.message.replace('Hub restamp conflicts: ', '')),
    ).toHaveLength(fixtures.length);
    expect(result.error.message).not.toMatch(
      /alice-owner|bob-owner|alice-session|bob-session/,
    );
    const after = await real.query(
      `SELECT collection, id, text, vector::text AS vector, metadata FROM "${pgl.schema}"."rag_documents" WHERE id <> 'clean' ORDER BY collection, id`,
    );
    expect(after.rows).toEqual(before.rows);
  }
  const clean = await real.query(
    `SELECT collection, metadata FROM "${pgl.schema}"."rag_documents" WHERE id = 'clean' ORDER BY collection`,
  );
  expect(clean.rows).toEqual([
    {
      collection: 'h_dialogue',
      metadata: {
        hubSessionId: 'clean-owner',
        authorUserId: 'clean-user',
        ownerScope: 'global',
      },
    },
    {
      collection: 'h_planner_memory',
      metadata: {
        namespace: 'clean-owner',
        authorUserId: 'clean-user',
        ownerScope: 'global',
      },
    },
  ]);
});

it('filters before top-k and scopes PG scans and deletion to the planner owner', async () => {
  const created = await newProvider().createCollection('h_planner_memory', {
    scope: 'global',
  });
  if (!created.ok) throw created.error;
  const rag = created.value.rag;
  if (!isRagScanner(rag) || !isRagFilteredDeleter(rag))
    throw new Error('Missing capabilities');
  const alice = scopedPlannerMemory(rag, 'alice-owner', 'same-session');
  const bob = scopedPlannerMemory(rag, 'bob-owner', 'same-session');
  const queryVector = new Array<number>(DIM).fill(0);
  queryVector[0] = 1;
  const ownVector = [...queryVector];
  ownVector[1] = 1;
  for (const [store, vector] of [
    [alice, ownVector],
    [bob, queryVector],
  ] as const) {
    const writer = store.writer?.();
    if (!writer?.upsertPrecomputedRaw) throw new Error('Missing writer');
    for (const id of ['one', 'two', 'three']) {
      const saved = await writer.upsertPrecomputedRaw(id, id, [...vector], {
        sessionId: 'same-session',
      });
      if (!saved.ok) throw saved.error;
    }
  }
  const unfiltered = await rag.query(
    { text: 'recall', toVector: async () => queryVector },
    2,
  );
  expect(
    unfiltered.ok && unfiltered.value.map((row) => row.metadata.namespace),
  ).toEqual(['bob-owner', 'bob-owner']);
  const query = jest.spyOn(rag, 'query');
  const scan = jest.spyOn(rag, 'scan');
  const recalled = await alice.query(
    { text: 'recall', toVector: async () => queryVector },
    2,
  );
  expect(recalled.ok && recalled.value).toHaveLength(2);
  expect(
    recalled.ok &&
      recalled.value.every((row) => row.metadata.sessionId === 'same-session'),
  ).toBe(true);
  expect(query.mock.calls[0]?.[1]).toBe(2);
  expect(scan).not.toHaveBeenCalled();
  // Exercise the scanner fallback with a real PG store that exposes no filtered deleter.
  const scannerOnly = {
    query: rag.query.bind(rag),
    getById: rag.getById.bind(rag),
    healthCheck: rag.healthCheck.bind(rag),
    writer: rag.writer?.bind(rag),
    scan: rag.scan.bind(rag),
  };
  expect(await forgetScopedPlannerMemory(scannerOnly, 'alice-owner')).toBe(
    true,
  );
  expect(scan).toHaveBeenCalledWith({ filter: { namespace: 'alice-owner' } });
  const remaining = await rag.scan();
  expect(remaining.ok && remaining.value.records).toHaveLength(3);
  expect(
    remaining.ok &&
      remaining.value.records.every(
        (row) => row.metadata.namespace === 'bob-owner',
      ),
  ).toBe(true);
  const remove = jest.spyOn(rag, 'deleteWhere');
  expect(await forgetScopedPlannerMemory(rag, 'alice-owner')).toBe(true);
  expect(remove).toHaveBeenCalledWith({ namespace: 'alice-owner' });
  const bobRows = await rag.scan({ filter: { namespace: 'bob-owner' } });
  expect(bobRows.ok && bobRows.value.records).toHaveLength(3);
  expect(await forgetScopedPlannerMemory(rag, 'bob-owner')).toBe(true);
  const empty = await rag.scan();
  expect(empty.ok && empty.value.records).toHaveLength(0);
});

it('restamps prefixed physical stores using their logical catalog name', async () => {
  const provider = newProvider();
  for (const name of ['h_dialogue', 'h_planner_memory']) {
    const storeName = `cloud_llm_hub_${name}`;
    const created = await provider.createCollection(storeName, {
      scope: 'global',
      collectionName: name,
    });
    if (!created.ok) throw created.error;
    await real.query(
      `INSERT INTO "${pgl.schema}"."rag_documents" (collection, id, text, vector, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
      [
        storeName,
        'legacy',
        'legacy text',
        JSON.stringify(new Array<number>(DIM).fill(0)),
        JSON.stringify({ sessionId: 's1', userId: 'alice' }),
      ],
    );
  }
  expect(await restampHubStores(provider)).toEqual({
    ok: true,
    value: { rewritten: 2 },
  });
  const rows = await real.query(
    `SELECT collection, metadata FROM "${pgl.schema}"."rag_documents" ORDER BY collection`,
  );
  expect(rows.rows).toEqual([
    {
      collection: 'cloud_llm_hub_h_dialogue',
      metadata: {
        ownerScope: 'global',
        hubSessionId: 's1',
        authorUserId: 'alice',
      },
    },
    {
      collection: 'cloud_llm_hub_h_planner_memory',
      metadata: {
        ownerScope: 'global',
        namespace: 's1',
        authorUserId: 'alice',
      },
    },
  ]);
});
