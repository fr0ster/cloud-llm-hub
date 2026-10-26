jest.mock('@sap/hana-client', (): object => ({
  createConnection: (): {
    connect: (
      _options: object,
      callback: (error: Error | null) => void,
    ) => void;
    exec: () => void;
    abort: () => void;
    disconnect: (callback: (error: Error | null) => void) => void;
  } => ({
    connect: (
      _options: object,
      callback: (error: Error | null) => void,
    ): void => callback(null),
    exec: (): void => {},
    abort: (): void => mockHanaAbort(),
    disconnect: (callback: (error: Error | null) => void): void => {
      mockHanaDisconnect();
      callback(null);
    },
  }),
}));
const mockHanaAbort = jest.fn<void, []>();
const mockHanaDisconnect = jest.fn<void, []>();

jest.mock('@sap/cds', (): object => ({
  __esModule: true,
  default: {
    log: (): { info(): void; warn(): void; error(): void; debug(): void } => ({
      info(): void {},
      warn(): void {},
      error(): void {},
      debug(): void {},
    }),
  },
}));

import type { HanaVectorRagConfig } from '@mcp-abap-adt/hana-vector-rag';
import {
  createPgClient,
  type PgVectorRagConfig,
} from '@mcp-abap-adt/pg-vector-rag';
import type { RagConfig } from '../../srv/agent-config';
import {
  createDialogueStoreBackend,
  type HubDialogueState,
} from '../../srv/lib/dialogue-store';
import {
  loadSessionConfig,
  type SessionStoreKind,
} from '../../srv/lib/session-config';
import { readUsageConfig } from '../../srv/lib/usage/config';
import { initUsage, type UsageRuntime } from '../../srv/lib/usage/runtime';
import {
  type AggregateQuery,
  COLLECTION_BATCH_LIMIT,
  collectionAggregateQuery,
  createCollectionAggregateReader,
  historyAggregateQuery,
} from '../../srv/lib/usage/storage-aggregates';
import { startPglite } from './helpers/pglite';

jest.setTimeout(120000);
const rag: RagConfig = {
  embedder: null,
  pg: { url: 'postgresql://localhost/usage-test' },
  backends: {
    tools: 'in-memory',
    session: 'in-memory',
    persistent: 'in-memory',
  },
};
let runtime: UsageRuntime | undefined;
afterEach(async (): Promise<void> => {
  await runtime?.close(1000);
});

test.each<SessionStoreKind>(['none', 'sqlite'])(
  '%s dialogue backend exposes exact counters without loading content',
  async (backend: SessionStoreKind): Promise<void> => {
    runtime = await initUsage(
      readUsageConfig({
        LLM_AGENT_USAGE: 'on',
        LLM_AGENT_USAGE_SINKS: 'memory',
      }),
    );
    const store = createDialogueStoreBackend(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: backend }),
    );
    const saved: HubDialogueState = {
      conversation: [],
      tasks: [],
      pending: [],
      savedAt: Date.now(),
      outbox: [
        {
          id: 'reply',
          text: '\u{1f600}',
          createdAt: Date.now(),
          trigger: 'user',
        },
      ],
    };
    await store.save('alice', 'session', saved);
    const { outbox, ...state } = saved;
    const load = jest.spyOn(store, 'load');
    expect(store.storageBytes?.('alice', 'session')).toEqual({
      stateBytes: Buffer.byteLength(JSON.stringify(state)),
      outboxBytes: Buffer.byteLength(JSON.stringify(outbox)),
    });
    expect(load).not.toHaveBeenCalled();
    await store.delete('alice', 'session');
    expect(store.storageBytes?.('alice', 'session')).toEqual({
      stateBytes: 0,
      outboxBytes: 0,
    });
  },
);

test('PostgreSQL aggregates run on PGlite, isolate collections, and count actual vector dimensions and UTF-8 bytes', async (): Promise<void> => {
  const pgl = await startPglite({ dimension: 8 });
  const client = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'test',
  });
  try {
    await client.query(
      `INSERT INTO "${pgl.schema}"."rag_documents" ("collection", "id", "text", "vector") VALUES ($1, $2, $3, $4::vector), ($5, $6, $7, NULL), ($8, $9, $10, $11::vector)`,
      [
        'owned',
        'one',
        '\u{1f600}',
        '[1,0,0,0,0,0,0,0]',
        'owned',
        'two',
        '\u00e9',
        'other-user',
        'three',
        'secret',
        '[1,0,0,0,0,0,0,0]',
      ],
    );
    const reader = createCollectionAggregateReader(
      { ...rag, pg: { url: pgl.url, schema: pgl.schema } },
      {
        pg: async (
          _cfg: PgVectorRagConfig,
        ): ReturnType<typeof createPgClient> =>
          createPgClient({
            connectionString: pgl.url,
            credential: pgl.credential,
            collectionName: 'usage',
          }),
      },
    );
    expect(await reader.measure('pg-vector', ['owned'])).toEqual({
      documents: 2,
      textBytes: 6,
      vectorBytes: 32,
    });
    expect(await reader.measure('pg-vector', ['absent'])).toEqual({
      documents: 0,
      textBytes: 0,
      vectorBytes: 0,
    });
    const query = collectionAggregateQuery(
      'pg-vector',
      ["name' OR TRUE --"],
      'schema"name',
    );
    expect(query.sql).toContain('"schema""name"."rag_documents"');
    expect(query.sql).not.toContain("name' OR TRUE");
    expect(query.params).toEqual(["name' OR TRUE --"]);
  } finally {
    await client.end();
    await pgl.stop();
  }
});

test('HANA aggregate uses a fake client, scalar results, bound collection names and closes its connection', async (): Promise<void> => {
  const calls: string[] = [];
  const close = jest.fn<Promise<void>, []>(async (): Promise<void> => {});
  const reader = createCollectionAggregateReader(rag, {
    env: {
      VCAP_SERVICES: JSON.stringify({
        hana: [
          {
            credentials: {
              host: 'host',
              port: 30015,
              schema: 'HDI',
              user: 'user',
              password: 'password',
            },
          },
        ],
      }),
    },
    hana: async (
      _cfg: HanaVectorRagConfig,
    ): Promise<{
      query: (
        sql: string,
      ) => Promise<{ documents: number; vectorBytes: number }[]>;
      exec: () => Promise<{ rowCount: number }>;
      close: jest.Mock<Promise<void>, [], void>;
    }> => ({
      query: async (
        sql: string,
      ): Promise<{ documents: number; vectorBytes: number }[]> => {
        calls.push(sql);
        return [{ documents: 2, vectorBytes: 6144 }];
      },
      exec: async (): Promise<{ rowCount: number }> => ({ rowCount: 0 }),
      close,
    }),
  });
  expect(
    await reader.measure('hana-vector', ['h_history'], undefined, {
      owner: '["alice","session"]',
      userId: 'alice',
      sessionId: 'session',
    }),
  ).toEqual({
    documents: 2,
    vectorBytes: 6144,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('COUNT(*) AS "documents"');
  expect(calls[0]).toContain('CASE WHEN "VECTOR" IS NULL THEN 0 ELSE 6144 END');
  expect(calls[0]).toContain(
    'FROM "HDI"."RAG_DOCUMENTS" WHERE "COLLECTION" IN (?)',
  );
  expect(calls[0]).toContain(`JSON_VALUE("METADATA", '$.owner') = ?`);
  expect(calls[0]).toContain(`JSON_VALUE("METADATA", '$.userId') = ?`);
  expect(calls[0]).toContain(`JSON_VALUE("METADATA", '$.sessionId') = ?`);
  expect(calls[0]).not.toMatch(/SELECT "TEXT"|SELECT "VECTOR"/);
  expect(close).toHaveBeenCalledTimes(1);
  expect(collectionAggregateQuery('hana-vector', ['private']).params).toEqual([
    'private',
  ]);
});

test.each<'pg-vector' | 'hana-vector'>(['pg-vector', 'hana-vector'])(
  '%s aggregate IN lists enforce the batch boundary and sum multiple batches',
  async (backend: 'pg-vector' | 'hana-vector'): Promise<void> => {
    const stores = Array.from(
      { length: COLLECTION_BATCH_LIMIT },
      (_value: undefined, index: number): string => `store-${index}`,
    );
    expect(collectionAggregateQuery(backend, stores).params).toHaveLength(
      COLLECTION_BATCH_LIMIT,
    );
    expect(
      (): AggregateQuery =>
        collectionAggregateQuery(backend, [...stores, 'extra']),
    ).toThrow('batch limit');
    const sizes: number[] = [];
    const reader = createCollectionAggregateReader(rag, {
      env: {
        VCAP_SERVICES: JSON.stringify({
          hana: [
            {
              credentials: {
                host: 'host',
                port: 30015,
                schema: 'HDI',
                user: 'user',
                password: 'password',
              },
            },
          ],
        }),
      },
      pg: async (
        _cfg: PgVectorRagConfig,
      ): Promise<{
        query: (
          _sql: string,
          params?: Parameters<
            Awaited<ReturnType<typeof createPgClient>>['query']
          >[1],
        ) => Promise<{
          rows: {
            pid: number;
            documents: number;
            textBytes: number;
            vectorBytes: number;
          }[];
          rowCount: number;
        }>;
        end: () => Promise<void>;
      }> => ({
        query: async (
          _sql: string,
          params?: Parameters<
            Awaited<ReturnType<typeof createPgClient>>['query']
          >[1],
        ): Promise<{
          rows: {
            pid: number;
            documents: number;
            textBytes: number;
            vectorBytes: number;
          }[];
          rowCount: number;
        }> => {
          if (params) sizes.push(params.length);
          return {
            rows: [
              {
                pid: 123,
                documents: params?.length ?? 0,
                textBytes: params?.length ?? 0,
                vectorBytes: params?.length ?? 0,
              },
            ],
            rowCount: 1,
          };
        },
        end: async (): Promise<void> => {},
      }),
      hana: async (
        _cfg: HanaVectorRagConfig,
      ): Promise<{
        query: (
          _sql: string,
          params?: Parameters<
            Awaited<ReturnType<typeof createPgClient>>['query']
          >[1],
        ) => Promise<{ documents: number; vectorBytes: number }[]>;
        exec: () => Promise<{ rowCount: number }>;
        close: () => Promise<void>;
      }> => ({
        query: async (
          _sql: string,
          params?: Parameters<
            Awaited<ReturnType<typeof createPgClient>>['query']
          >[1],
        ): Promise<{ documents: number; vectorBytes: number }[]> => {
          sizes.push(params?.length ?? 0);
          return [
            {
              documents: params?.length ?? 0,
              vectorBytes: params?.length ?? 0,
            },
          ];
        },
        exec: async (): Promise<{ rowCount: number }> => ({ rowCount: 0 }),
        close: async (): Promise<void> => {},
      }),
    });
    expect(await reader.measure(backend, [...stores, 'extra'])).toMatchObject({
      documents: COLLECTION_BATCH_LIMIT + 1,
      vectorBytes: COLLECTION_BATCH_LIMIT + 1,
    });
    expect(sizes).toEqual([COLLECTION_BATCH_LIMIT, 1]);
  },
);

test.each<'pg-vector' | 'hana-vector'>(['pg-vector', 'hana-vector'])(
  '%s stalled query is cancelled and cleaned up within budget, followed by a successful measurement',
  async (backend: 'pg-vector' | 'hana-vector'): Promise<void> => {
    jest.useFakeTimers();
    let stalled = true;
    const sqls: string[] = [];
    const close = jest.fn<Promise<void>, []>(
      (): Promise<void> => new Promise<void>((): void => {}),
    );
    const reader = createCollectionAggregateReader(rag, {
      env: {
        VCAP_SERVICES: JSON.stringify({
          hana: [
            {
              credentials: {
                host: 'host',
                port: 30015,
                schema: 'HDI',
                user: 'user',
                password: 'password',
              },
            },
          ],
        }),
      },
      pg: async (
        _cfg: PgVectorRagConfig,
      ): Promise<{
        query: (sql: string) => Promise<{
          rows: {
            pid: number;
            documents: number;
            textBytes: number;
            vectorBytes: number;
          }[];
          rowCount: number;
        }>;
        end: jest.Mock<Promise<void>, [], void>;
      }> => ({
        query: async (
          sql: string,
        ): Promise<{
          rows: {
            pid: number;
            documents: number;
            textBytes: number;
            vectorBytes: number;
          }[];
          rowCount: number;
        }> => {
          sqls.push(sql);
          if (stalled && sql.startsWith('SELECT COUNT'))
            return new Promise<never>((): void => {});
          return {
            rows: [{ pid: 123, documents: 1, textBytes: 2, vectorBytes: 4 }],
            rowCount: 1,
          };
        },
        end: close,
      }),
      hana: async (
        _cfg: HanaVectorRagConfig,
      ): Promise<{
        query: (
          sql: string,
        ) => Promise<{ documents: number; vectorBytes: number }[]>;
        exec: () => Promise<{ rowCount: number }>;
        close: jest.Mock<Promise<void>, [], void>;
      }> => ({
        query: async (
          sql: string,
        ): Promise<{ documents: number; vectorBytes: number }[]> => {
          sqls.push(sql);
          if (stalled) return new Promise<never>((): void => {});
          return [{ documents: 1, vectorBytes: 4 }];
        },
        exec: async (): Promise<{ rowCount: number }> => ({ rowCount: 0 }),
        close,
      }),
    });
    try {
      const first = expect(reader.measure(backend, ['owned'])).rejects.toThrow(
        'aborted',
      );
      await jest.advanceTimersByTimeAsync(5000);
      await first;
      expect(close).toHaveBeenCalledTimes(backend === 'pg-vector' ? 2 : 1);
      if (backend === 'pg-vector')
        expect(sqls[0]).toBe('SET statement_timeout = 5000');
      stalled = false;
      expect(await reader.measure(backend, ['owned'])).toMatchObject({
        documents: 1,
        vectorBytes: 4,
      });
      expect(close).toHaveBeenCalledTimes(backend === 'pg-vector' ? 3 : 2);
      if (backend === 'pg-vector')
        expect(sqls).toContain('SELECT pg_cancel_backend($1)');
    } finally {
      jest.useRealTimers();
    }
  },
);

test('native HANA cancellation aborts the running statement before disconnect on shutdown', async (): Promise<void> => {
  mockHanaAbort.mockClear();
  mockHanaDisconnect.mockClear();
  const controller = new AbortController();
  const reader = createCollectionAggregateReader(rag, {
    env: {
      VCAP_SERVICES: JSON.stringify({
        hana: [
          {
            credentials: {
              host: 'host',
              port: 30015,
              schema: 'HDI',
              user: 'user',
              password: 'password',
            },
          },
        ],
      }),
    },
  });
  const pending = expect(
    reader.measure('hana-vector', ['owned'], controller.signal),
  ).rejects.toThrow('aborted');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  controller.abort();
  await pending;
  expect(mockHanaAbort).toHaveBeenCalledTimes(1);
  expect(mockHanaDisconnect).toHaveBeenCalledTimes(1);
  expect(mockHanaAbort.mock.invocationCallOrder[0]).toBeLessThan(
    mockHanaDisconnect.mock.invocationCallOrder[0] ?? 0,
  );
});

test('history aggregate isolates persisted sessions beyond the recent window and follows deletion', async (): Promise<void> => {
  const pgl = await startPglite({ dimension: 8 });
  const client = await createPgClient({
    connectionString: pgl.url,
    credential: pgl.credential,
    collectionName: 'history',
  });
  try {
    for (const sessionId of ['one', 'two']) {
      for (let index = 0; index < 15; index++) {
        await client.query(
          `INSERT INTO "${pgl.schema}"."rag_documents" ("collection", "id", "text", "metadata") VALUES ($1, $2, $3, $4::jsonb)`,
          [
            'h_history',
            `${sessionId}-${index}`,
            '\u00e9\u{1f600}',
            JSON.stringify({
              owner: JSON.stringify(['alice', sessionId]),
              userId: 'alice',
              sessionId,
              createdAt: new Date().toISOString(),
            }),
          ],
        );
      }
    }
    const scope = {
      owner: JSON.stringify(['alice', 'one']),
      userId: 'alice',
      sessionId: 'one',
    };
    const query = historyAggregateQuery('pg-vector', scope, pgl.schema);
    const measure = async (): Promise<number> => {
      const result = await client.query(query.sql, query.params);
      return Number(result.rows[0].textBytes);
    };
    expect(await measure()).toBe(90);
    await client.query(
      `DELETE FROM "${pgl.schema}"."rag_documents" WHERE "id" = $1`,
      ['one-0'],
    );
    expect(await measure()).toBe(84);
    await client.query(
      `DELETE FROM "${pgl.schema}"."rag_documents" WHERE "metadata"->>'sessionId' = $1`,
      ['one'],
    );
    expect(await measure()).toBe(0);
    const other = historyAggregateQuery(
      'pg-vector',
      { ...scope, owner: JSON.stringify(['alice', 'two']), sessionId: 'two' },
      pgl.schema,
    );
    expect(
      Number((await client.query(other.sql, other.params)).rows[0].textBytes),
    ).toBe(90);
  } finally {
    await client.end();
    await pgl.stop();
  }
});
