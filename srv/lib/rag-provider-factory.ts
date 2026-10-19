import {
  HanaVectorRag,
  HanaVectorRagProvider,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  type IRagProvider,
  type IRetrievalEmbedder,
  staticLogin,
} from '@mcp-abap-adt/llm-agent';
import { PgVectorRag, PgVectorRagProvider } from '@mcp-abap-adt/pg-vector-rag';
import { QdrantRagProvider } from '@mcp-abap-adt/qdrant-rag';
import type { RagConfig } from '../agent-config';
import { readHanaBinding } from './hana-binding';
import { apiKeyCredential } from './llm-factory';
import type { Embedding } from './providers';

type Env = Record<string, string | undefined>;

// biome-ignore lint/suspicious/noExplicitAny: constructors are only passed through
type CtorArgs = any;

/** The library constructors, injectable so tests need no network. */
export interface RagCtors {
  HanaVectorRagProvider: new (cfg: CtorArgs) => IRagProvider;
  PgVectorRagProvider: new (cfg: CtorArgs) => IRagProvider;
  QdrantRagProvider: new (cfg: CtorArgs) => IRagProvider;
  HanaVectorRag: new (cfg: CtorArgs) => unknown;
  PgVectorRag: new (cfg: CtorArgs) => unknown;
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

/** Postgres connection (address, schema, optional login) from LLM_AGENT_PG_*. */
export function pgConnection(rag: RagConfig) {
  const pg = rag.pg;
  if (!pg) throw new Error('pg-vector is configured but rag.pg is missing');
  return {
    connectionString: pg.url,
    ...(pg.schema ? { schema: pg.schema } : {}),
    ...(pg.user ? { credential: staticLogin(pg.user, pg.password ?? '') } : {}),
  };
}

/**
 * The provider behind the persistent collections, or null when the
 * `persistent` class is not a persistent kind. `env` carries VCAP_SERVICES.
 */
export function createCollectionProvider(
  rag: RagConfig,
  embedding: Embedding,
  env: Env = process.env,
  ctors: RagCtors = defaultCtors,
): IRagProvider | null {
  const embedder: IRetrievalEmbedder = embedding.retrieval;
  switch (rag.backends.persistent) {
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
