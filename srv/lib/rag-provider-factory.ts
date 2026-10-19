import {
  HanaVectorRag,
  type HanaVectorRagConfig,
  HanaVectorRagProvider,
  type HanaVectorRagProviderConfig,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  type IRagProvider,
  type IRetrievalEmbedder,
  staticLogin,
} from '@mcp-abap-adt/llm-agent';
import {
  PgVectorRag,
  type PgVectorRagConfig,
  PgVectorRagProvider,
  type PgVectorRagProviderConfig,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  QdrantRagProvider,
  type QdrantRagProviderConfig,
} from '@mcp-abap-adt/qdrant-rag';
import type { RagBackendKind, RagConfig } from '../agent-config';
import { readHanaBinding } from './hana-binding';
import { apiKeyCredential } from './llm-factory';
import type { Embedding } from './providers';

type Env = Record<string, string | undefined>;

/** The library constructors, injectable so tests need no network. */
export interface RagCtors {
  HanaVectorRagProvider: new (cfg: HanaVectorRagProviderConfig) => IRagProvider;
  PgVectorRagProvider: new (cfg: PgVectorRagProviderConfig) => IRagProvider;
  QdrantRagProvider: new (cfg: QdrantRagProviderConfig) => IRagProvider;
  HanaVectorRag: new (
    cfg: HanaVectorRagConfig & { embedder: IRetrievalEmbedder },
  ) => unknown;
  PgVectorRag: new (
    cfg: PgVectorRagConfig & { embedder: IRetrievalEmbedder },
  ) => unknown;
}

export const defaultCtors: RagCtors = {
  HanaVectorRagProvider,
  PgVectorRagProvider,
  QdrantRagProvider,
  HanaVectorRag,
  PgVectorRag,
};

/** HANA connection of the `shared` layout, from the bound HDI container. */
export function hanaConnection(rag: RagConfig, env: Env = process.env) {
  const b = readHanaBinding(env, rag.hana?.serviceName);
  return {
    host: b.host,
    port: b.port,
    schema: b.schema,
    credential: staticLogin(b.user, b.password),
  };
}

/**
 * Postgres connection (address, schema, optional login) from LLM_AGENT_PG_*.
 * The library takes the credential as optional; without a password none is
 * sent (no empty-string secret).
 */
export function pgConnection(rag: RagConfig) {
  const pg = rag.pg;
  if (!pg) throw new Error('pg-vector is configured but rag.pg is missing');
  return {
    connectionString: pg.url,
    ...(pg.schema ? { schema: pg.schema } : {}),
    ...(pg.user && pg.password
      ? { credential: staticLogin(pg.user, pg.password) }
      : {}),
  };
}

/** Whether collections of this kind persist through a provider. */
export function isPersistentKind(kind: RagBackendKind): boolean {
  return kind === 'hana-vector' || kind === 'pg-vector' || kind === 'qdrant';
}

/**
 * The vector dimension persistent collections are written with. HANA and PG
 * use the provider default (no dimension is configured), which the deployed
 * `vector(n)` / `REAL_VECTOR(n)` column must equal; Qdrant sizes each
 * collection from the embedder.
 */
export function collectionDimension(
  kind: RagBackendKind,
): number | 'from the embedder' | undefined {
  if (kind === 'hana-vector' || kind === 'pg-vector')
    return PROVIDER_DEFAULT_DIMENSION;
  if (kind === 'qdrant') return 'from the embedder';
  return undefined;
}

/** The `defaultDimension` of HanaVectorRagProvider and PgVectorRagProvider. */
export const PROVIDER_DEFAULT_DIMENSION = 1536;

/**
 * The provider behind the persistent collections, or null when the
 * `persistent` class is not a persistent kind. `env` carries VCAP_SERVICES.
 * `kind` selects another class's backend (the session history uses the
 * `session` class's).
 */
export function createCollectionProvider(
  rag: RagConfig,
  embedding: Embedding,
  env: Env = process.env,
  ctors: RagCtors = defaultCtors,
  kind: RagBackendKind = rag.backends.persistent,
): IRagProvider | null {
  const embedder: IRetrievalEmbedder = embedding.retrieval;
  switch (kind) {
    case 'hana-vector':
      return new ctors.HanaVectorRagProvider({
        name: 'hub-collections',
        embedder,
        connection: {
          ...hanaConnection(rag, env),
          layout: 'shared',
          collectionName: 'hub-collections',
        },
        layout: 'shared',
      });
    case 'pg-vector':
      return new ctors.PgVectorRagProvider({
        name: 'hub-collections',
        embedder,
        connection: {
          ...pgConnection(rag),
          layout: 'shared',
          collectionName: 'hub-collections',
        },
        layout: 'shared',
      });
    case 'qdrant': {
      const q = rag.qdrant;
      if (!q) throw new Error('qdrant is configured but rag.qdrant is missing');
      return new ctors.QdrantRagProvider({
        name: 'hub-collections',
        url: q.url,
        embedder,
        ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
        catalogCollection: `${q.prefix}-collections-catalog`,
      });
    }
    default:
      return null;
  }
}
