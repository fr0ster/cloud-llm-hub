import type { ConnectionOptions } from 'node:tls';
import { createHanaClient } from '@mcp-abap-adt/hana-vector-rag';
import { createPgClient } from '@mcp-abap-adt/pg-vector-rag';
import type { Connection } from '@sap/hana-client';
import { z } from 'zod';
import type { RagConfig } from '../../agent-config';
import {
  hanaConnection,
  PROVIDER_DEFAULT_DIMENSION,
  pgConnection,
} from '../rag-provider-factory';

export const COLLECTION_BATCH_LIMIT = 256;

export interface CollectionAggregate {
  documents: number;
  textBytes?: number;
  vectorBytes: number;
}
export interface AggregateQuery {
  sql: string;
  params: string[];
}
const quote = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;
const row = z.object({
  documents: z.coerce.number().finite().nonnegative(),
  textBytes: z.coerce.number().finite().nonnegative().optional(),
  vectorBytes: z.coerce.number().finite().nonnegative(),
});

/** Only scalar aggregates cross the client boundary; collection names are parameters. */
export function collectionAggregateQuery(
  backend: 'pg-vector' | 'hana-vector',
  stores: string[],
  schema?: string,
): AggregateQuery {
  if (stores.length > COLLECTION_BATCH_LIMIT)
    throw new Error('Collection batch limit exceeded');
  if (!stores.length) throw new Error('No collections to aggregate');
  const table = backend === 'pg-vector' ? 'rag_documents' : 'RAG_DOCUMENTS';
  const qualified = `${schema ? `${quote(schema)}.` : ''}${quote(table)}`;
  if (backend === 'pg-vector')
    return {
      sql: `SELECT COUNT(*)::float8 AS "documents", COALESCE(SUM(octet_length("text")), 0)::float8 AS "textBytes", COALESCE(SUM(CASE WHEN "vector" IS NULL THEN 0 ELSE vector_dims("vector") * 4 END), 0)::float8 AS "vectorBytes" FROM ${qualified} WHERE "collection" IN (${stores.map((_store: string, index: number): string => `$${index + 1}`).join(', ')})`,
      params: stores,
    };
  // HANA's NCLOB length is in characters, not UTF-8 bytes. Use the exact write
  // counter for text; count vectors using the shared layout's fixed dimension.
  return {
    sql: `SELECT COUNT(*) AS "documents", COALESCE(SUM(CASE WHEN "VECTOR" IS NULL THEN 0 ELSE ${PROVIDER_DEFAULT_DIMENSION * 4} END), 0) AS "vectorBytes" FROM ${qualified} WHERE "COLLECTION" IN (${stores.map((_store: string): string => '?').join(', ')})`,
    params: stores,
  };
}

export interface HistoryAggregateScope {
  owner: string;
  userId: string;
  sessionId: string;
}

export function historyAggregateQuery(
  backend: 'pg-vector' | 'hana-vector',
  scope: HistoryAggregateScope,
  schema?: string,
): AggregateQuery {
  const query = collectionAggregateQuery(backend, ['h_history'], schema);
  const fields = ['owner', 'userId', 'sessionId'];
  const predicates = fields.map((field: string, index: number): string =>
    backend === 'pg-vector'
      ? `"metadata"->>'${field}' = $${index + 2}`
      : `JSON_VALUE("METADATA", '$.${field}') = ?`,
  );
  return {
    sql: `${query.sql} AND ${predicates.join(' AND ')}`,
    params: [...query.params, scope.owner, scope.userId, scope.sessionId],
  };
}

export interface CollectionAggregateReader {
  measure(
    backend: string,
    stores: string[],
    signal?: AbortSignal,
    history?: HistoryAggregateScope,
  ): Promise<CollectionAggregate | undefined>;
}

/** Connections are opened only for a measurement, and always closed afterwards. */
export interface AggregateClients {
  pg?: typeof createPgClient;
  hana?: typeof createHanaClient;
  env?: NodeJS.ProcessEnv;
}
export function createCollectionAggregateReader(
  rag: RagConfig,
  clients: AggregateClients = {},
): CollectionAggregateReader {
  return {
    async measure(
      backend: string,
      stores: string[],
      signal?: AbortSignal,
      history?: HistoryAggregateScope,
    ): Promise<CollectionAggregate | undefined> {
      if (backend !== 'pg-vector' && backend !== 'hana-vector')
        return undefined;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 5000);
      timer.unref();
      let close: (() => Promise<void>) | undefined;
      let closed = false;
      let cancel: (() => void) | undefined;
      const cleanup = (): void => {
        if (!close || closed) return;
        closed = true;
        if (controller.signal.aborted) cancel?.();
        void close().catch((): void => {});
      };
      controller.signal.addEventListener('abort', cleanup, { once: true });
      const work = async (): Promise<CollectionAggregate> => {
        if (controller.signal.aborted) throw new Error('Measurement aborted');
        const connection =
          backend === 'pg-vector'
            ? pgConnection(rag)
            : hanaConnection(rag, clients.env);
        const client =
          backend === 'pg-vector'
            ? await (clients.pg ?? createPgClient)({
                ...pgConnection(rag),
                collectionName: 'hub-usage-storage',
                poolMax: 1,
                connectTimeout: 5000,
              })
            : await (
                clients.hana ??
                ((
                  cfg: Parameters<typeof createHanaClient>[0],
                ): ReturnType<typeof createHanaClient> =>
                  createHanaClient(
                    cfg,
                    async (): Promise<{
                      createConnection: () => ReturnType<
                        (options?: ConnectionOptions) => Connection
                      >;
                    }> => {
                      const hana = await import('@sap/hana-client');
                      return {
                        createConnection: (): ReturnType<
                          typeof hana.createConnection
                        > => {
                          const connection = hana.createConnection();
                          close = (): Promise<void> =>
                            new Promise<void>(
                              (
                                resolve: () => void,
                                reject: (reason: Error) => void,
                              ): void => {
                                connection.disconnect((error: Error): void =>
                                  error ? reject(error) : resolve(),
                                );
                              },
                            );
                          cancel = (): void => connection.abort((): void => {});
                          if (controller.signal.aborted) {
                            cleanup();
                            throw new Error('Measurement aborted');
                          }
                          return connection;
                        },
                      };
                    },
                  ))
              )({
                ...hanaConnection(rag, clients.env),
                collectionName: 'hub-usage-storage',
                connectTimeout: 5000,
              });
        close =
          'end' in client
            ? (): Promise<void> => client.end()
            : (): Promise<void> => client.close();
        if (controller.signal.aborted) {
          cleanup();
          throw new Error('Measurement aborted');
        }
        // This dedicated single-connection pool is used only for measurement.
        if ('end' in client) {
          await client.query('SET statement_timeout = 5000');
          const identity = await client.query('SELECT pg_backend_pid() AS pid');
          const pid = z
            .object({ pid: z.number().int().positive() })
            .parse(identity.rows[0]).pid;
          // Cancellation uses another measurement-only connection: the occupied
          // connection cannot execute a cancel request while its query is blocked.
          cancel = (): void => {
            void (async (): Promise<void> => {
              const control = await (clients.pg ?? createPgClient)({
                ...pgConnection(rag),
                collectionName: 'hub-usage-cancel',
                poolMax: 1,
                connectTimeout: 1000,
              });
              let ended = false;
              const end = (): void => {
                if (ended) return;
                ended = true;
                void control.end().catch((): void => {});
              };
              const cleanupTimer = setTimeout(end, 1000);
              cleanupTimer.unref();
              try {
                await control.query('SELECT pg_cancel_backend($1)', [pid]);
              } finally {
                clearTimeout(cleanupTimer);
                end();
              }
            })().catch((): void => {});
          };
        }
        const total: CollectionAggregate = {
          documents: 0,
          vectorBytes: 0,
          ...(backend === 'pg-vector' ? { textBytes: 0 } : {}),
        };
        for (
          let offset = 0;
          offset < stores.length;
          offset += COLLECTION_BATCH_LIMIT
        ) {
          if (controller.signal.aborted) throw new Error('Measurement aborted');
          const query = history
            ? historyAggregateQuery(backend, history, connection.schema)
            : collectionAggregateQuery(
                backend,
                stores.slice(offset, offset + COLLECTION_BATCH_LIMIT),
                connection.schema,
              );
          const result = await client.query(query.sql, query.params);
          const measured = row.parse(
            'rows' in result ? result.rows[0] : result[0],
          );
          total.documents += measured.documents;
          total.vectorBytes += measured.vectorBytes;
          if (total.textBytes !== undefined && measured.textBytes !== undefined)
            total.textBytes += measured.textBytes;
        }
        return total;
      };
      let rejectAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          new Promise<never>(
            (
              _resolve: (value: never) => void,
              reject: (reason: Error) => void,
            ): void => {
              rejectAbort = (): void =>
                reject(new Error('Measurement aborted'));
              controller.signal.addEventListener('abort', rejectAbort, {
                once: true,
              });
              if (controller.signal.aborted) rejectAbort();
            },
          ),
          work(),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (rejectAbort)
          controller.signal.removeEventListener('abort', rejectAbort);
        cleanup();
      }
    },
  };
}

let reader: CollectionAggregateReader | undefined;
export function configureStorageAggregates(rag?: RagConfig): void {
  reader = rag ? createCollectionAggregateReader(rag) : undefined;
}
export function storageAggregates(): CollectionAggregateReader | undefined {
  return reader;
}
