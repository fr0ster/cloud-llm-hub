import {
  HanaVectorRagProvider,
  type HanaVectorRagProviderConfig,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  type CallOptions,
  type IRagProvider,
  type IRetrievalEmbedder,
  staticLogin,
} from '@mcp-abap-adt/llm-agent';
import {
  PgVectorRagProvider,
  type PgVectorRagProviderConfig,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  QdrantRagProvider,
  type QdrantRagProviderConfig,
} from '@mcp-abap-adt/qdrant-rag';
import { z } from 'zod';
import type { RagBackendKind, RagConfig } from '../agent-config';
import { readHanaBinding } from './hana-binding';
import { apiKeyCredential } from './llm-factory';
import { type Embedding, embedderFingerprint } from './providers';
import { fingerprintHash } from './tool-corpus';

type Env = Record<string, string | undefined>;

/** The library constructors, injectable so tests need no network. */
export interface RagCtors {
  HanaVectorRagProvider: new (cfg: HanaVectorRagProviderConfig) => IRagProvider;
  PgVectorRagProvider: new (cfg: PgVectorRagProviderConfig) => IRagProvider;
  QdrantRagProvider: new (cfg: QdrantRagProviderConfig) => IRagProvider;
}

export const defaultCtors: RagCtors = {
  HanaVectorRagProvider,
  PgVectorRagProvider,
  QdrantRagProvider,
};

type VectorDimension = (
  storeName: string,
  options?: CallOptions,
) => Promise<number>;
const providerDimensions = new WeakMap<IRagProvider, VectorDimension>();
const embedderProbes = new WeakMap<IRetrievalEmbedder, Promise<number>>();

/** Resolve dimensions from the same configuration that creates physical stores. */
export function providerVectorDimension(
  provider: IRagProvider,
): VectorDimension {
  return async (storeName, options) => {
    const resolve = providerDimensions.get(provider);
    if (!resolve)
      throw new Error('Collection provider has no dimension resolver');
    return resolve(storeName, options);
  };
}

function withDimension(
  provider: IRagProvider,
  resolve: VectorDimension,
): IRagProvider {
  providerDimensions.set(provider, resolve);
  return provider;
}

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
 * `session` class's). Only the embedding's `retrieval` embedder is used.
 */
export function createCollectionProvider(
  rag: RagConfig,
  embedding: Pick<Embedding, 'retrieval'>,
  env: Env = process.env,
  ctors: RagCtors = defaultCtors,
  kind: RagBackendKind = rag.backends.persistent,
): IRagProvider | null {
  const embedder: IRetrievalEmbedder = embedding.retrieval;
  switch (kind) {
    case 'hana-vector':
      return withDimension(
        new ctors.HanaVectorRagProvider({
          defaultDimension: PROVIDER_DEFAULT_DIMENSION,
          name: 'hub-collections',
          embedder,
          connection: {
            ...hanaConnection(rag, env),
            layout: 'shared',
            collectionName: 'hub-collections',
          },
          layout: 'shared',
        }),
        async () => PROVIDER_DEFAULT_DIMENSION,
      );
    case 'pg-vector':
      return withDimension(
        new ctors.PgVectorRagProvider({
          defaultDimension: PROVIDER_DEFAULT_DIMENSION,
          name: 'hub-collections',
          embedder,
          connection: {
            ...pgConnection(rag),
            layout: 'shared',
            collectionName: 'hub-collections',
          },
          layout: 'shared',
        }),
        async () => PROVIDER_DEFAULT_DIMENSION,
      );
    case 'qdrant': {
      const q = rag.qdrant;
      if (!q) throw new Error('qdrant is configured but rag.qdrant is missing');
      const provider = new ctors.QdrantRagProvider({
        name: 'hub-collections',
        url: q.url,
        embedder,
        ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
        catalogCollection: `${q.prefix}-collections-catalog`,
      });
      // Only missing collections share the dimension for new stores.
      let dimension: Promise<number> | undefined;
      const positiveDimension = z.number().int().positive().safe();
      const request = async (path: string, options?: CallOptions) => {
        const response = await fetch(`${q.url.replace(/\/+$/, '')}${path}`, {
          headers: q.apiKey ? { 'api-key': q.apiKey } : {},
          signal: options?.signal,
        });
        if (response.status === 404) return undefined;
        if (!response.ok)
          throw new Error(
            `Qdrant dimension lookup failed: HTTP ${response.status}`,
          );
        return response.json();
      };
      const size = async (name: string, options?: CallOptions) => {
        const json: unknown = await request(
          `/collections/${encodeURIComponent(name)}`,
          options,
        );
        if (json === undefined) return undefined;
        return z
          .object({
            result: z.object({
              config: z.object({
                params: z.object({
                  vectors: z.object({ size: positiveDimension }),
                }),
              }),
            }),
          })
          .parse(json).result.config.params.vectors.size;
      };
      const resolve = async (options?: CallOptions): Promise<number> => {
        if (rag.embeddingDimension !== undefined)
          return positiveDimension.parse(rag.embeddingDimension);
        const listed: unknown = await request('/collections', options);
        const names = new Set(
          z
            .object({
              result: z.object({
                collections: z.array(z.object({ name: z.string() })),
              }),
            })
            .parse(listed)
            .result.collections.map((c) => c.name),
        );
        if (!provider.describeCollections)
          throw new Error('Qdrant provider cannot read its catalog');
        const catalog = await provider.describeCollections();
        if (!catalog.ok) throw catalog.error;
        const fp = rag.embedder
          ? fingerprintHash(embedderFingerprint(rag.embedder))
          : undefined;
        const attributes = z.object({
          writtenBy: z.literal('cloud-llm-hub'),
          embedder: z.string(),
        });
        let found: number | undefined;
        for (const record of catalog.value.records) {
          const attrs = attributes.safeParse(record.attributes);
          if (
            !fp ||
            !attrs.success ||
            attrs.data.embedder !== fp ||
            !names.has(record.storeName)
          )
            continue;
          const candidate = await size(record.storeName, options);
          if (candidate === undefined) continue;
          if (found !== undefined && found !== candidate)
            throw new Error(
              `Qdrant collections for the same embedder have inconsistent vector dimensions: ${found} and ${candidate}`,
            );
          found = candidate;
        }
        if (found !== undefined) return found;
        let probe = embedderProbes.get(embedder);
        if (!probe) {
          probe = embedder
            .embedDocument('dimension probe', options)
            .then((result) => positiveDimension.parse(result.vector.length))
            .catch((error: unknown) => {
              embedderProbes.delete(embedder);
              throw error;
            });
          embedderProbes.set(embedder, probe);
        }
        return probe;
      };
      return withDimension(provider, async (storeName, options) => {
        try {
          const target = await size(storeName, options);
          if (target !== undefined) return target;
          // Assign before awaiting so concurrent first creations share one value.
          dimension ??= resolve(options).catch((error: unknown) => {
            dimension = undefined;
            throw error;
          });
          return await dimension;
        } catch (error: unknown) {
          throw new Error(
            `Qdrant storage cannot resolve vector dimension: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
    default:
      return null;
  }
}
