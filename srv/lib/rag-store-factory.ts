import {
  FallbackRag,
  type IDocumentEnricher,
  type IEmbedder,
  InMemoryRag,
  type IQueryPreprocessor,
  type IRag,
  NoopDocumentEnricher,
  RagError,
  type Result,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag, QdrantRagProvider } from '@mcp-abap-adt/qdrant-rag';
import type {
  QdrantConfig,
  RagBackendKind,
  RagConfig,
  RagStoreClass,
} from '../agent-config';
import { apiKeyCredential } from './llm-factory';
import type { Embedding } from './providers';

export interface VectorStoreOptions {
  queryPreprocessors?: IQueryPreprocessor[];
  documentEnrichers?: IDocumentEnricher[];
}

export interface RagStoreFactory {
  backendOf(cls: RagStoreClass): RagBackendKind;
  create(cls: RagStoreClass, name: string, opts?: VectorStoreOptions): IRag;
  /**
   * A store held in this process only, whatever `cls`'s backend is: the
   * `vector` construction when an embedder exists, else in-memory. For
   * runtime writes that a shared, build-owned store must never receive.
   */
  createLocal(opts?: VectorStoreOptions): IRag;
  listStores(
    cls: RagStoreClass,
    prefix: string,
  ): Promise<Result<string[], RagError>>;
  countPoints(
    cls: RagStoreClass,
    name: string,
  ): Promise<Result<number, RagError>>;
  deleteStore(
    cls: RagStoreClass,
    name: string,
  ): Promise<Result<void, RagError>>;
  /**
   * Resolves once every write already acknowledged for store `name` is
   * visible to reads such as `countPoints`. Only `qdrant` has anything to
   * wait for; the other backends resolve at once.
   */
  awaitWrites(
    cls: RagStoreClass,
    name: string,
  ): Promise<Result<void, RagError>>;
  qdrantCollection(name: string): string;
  /**
   * The tool corpus's completion records in the Qdrant catalog, by collection
   * name. Empty when the tools are not on `qdrant`.
   */
  readToolCatalog(): Promise<Result<Map<string, unknown>, RagError>>;
}

/**
 * The Qdrant provider that holds the tool corpus's completion records, in the
 * catalog collection `<prefix>-catalog`. One helper, so the build step and the
 * startup check cannot disagree about where the records live.
 */
export function toolCatalogProvider(
  q: QdrantConfig,
  embedder: IEmbedder,
): QdrantRagProvider {
  return new QdrantRagProvider({
    name: 'hub-tools',
    url: q.url,
    embedder,
    ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
    catalogCollection: `${q.prefix}-catalog`,
  });
}

const err = (msg: string, code: string): { ok: false; error: RagError } => ({
  ok: false,
  error: new RagError(msg, code),
});

export function createRagStoreFactory(
  rag: RagConfig,
  embedding: Embedding | null,
): RagStoreFactory {
  const qdrant = rag.qdrant;
  const qName = (name: string) =>
    `${qdrant?.prefix ?? 'cloud-llm-hub'}-${name}`;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(qdrant?.apiKey ? { 'api-key': qdrant.apiKey } : {}),
  });
  // Programmer-misuse assertion (throws): a caller asked for a class whose
  // configured backend does not match what it's calling — a wiring bug to
  // fix, not a runtime outage. Backend outages (Qdrant unreachable, HTTP
  // error, a body that is not JSON) are reported as `Result` errors instead,
  // never thrown: every REST call goes through `call` below.
  const needQdrant = (cls: RagStoreClass) => {
    if (rag.backends[cls] !== 'qdrant' || !qdrant)
      throw new Error(`RAG class ${cls} is not on qdrant`);
    return qdrant;
  };
  const call = async <T>(
    what: string,
    code: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Result<T, RagError>> => {
    try {
      const res = await fetch(url, { ...init, headers: headers() });
      if (!res.ok)
        return err(
          `Qdrant ${what}: HTTP ${res.status} ${await res.text()}`,
          code,
        );
      return { ok: true, value: (await res.json()) as T };
    } catch (e) {
      return err(`Qdrant ${what}: ${String(e)}`, code);
    }
  };

  const vectorStore = (e: Embedding, opts?: VectorStoreOptions): IRag =>
    new FallbackRag(
      new VectorRag(e.embedder, {
        vectorWeight: 0.7,
        keywordWeight: 0.3,
        queryPreprocessors: opts?.queryPreprocessors,
        documentEnrichers: opts?.documentEnrichers ?? [
          new NoopDocumentEnricher(),
        ],
      }),
      new InMemoryRag(),
      e.breaker,
    );

  return {
    backendOf: (cls) => rag.backends[cls],
    createLocal: (opts) =>
      embedding ? vectorStore(embedding, opts) : new InMemoryRag(),
    qdrantCollection: qName,
    create(cls, name, opts) {
      const backend = rag.backends[cls];
      if (backend === 'in-memory') return new InMemoryRag();
      if (!embedding)
        throw new Error(
          `RAG class ${cls} is ${backend} but no embedder was built`,
        );
      if (backend === 'vector') return vectorStore(embedding, opts);
      // No query preprocessors on `qdrant`: `opts.queryPreprocessors` (the
      // vector backend's TranslatePreprocessor) is not applied, so queries are
      // embedded as asked. Retrieval across languages relies on a multilingual
      // embedder (spec §4.7); there is deliberately no hub-side translation.
      const q = needQdrant(cls);
      return new QdrantRag({
        url: q.url,
        collectionName: qName(name),
        embedder: embedding.embedder,
        ...(q.apiKey ? { credential: apiKeyCredential(q.apiKey) } : {}),
      });
    },
    async listStores(cls, prefix) {
      const q = needQdrant(cls);
      const r = await call<{ result: { collections: { name: string }[] } }>(
        'list collections',
        'RAG_LIST_ERROR',
        `${q.url}/collections`,
      );
      if (!r.ok) return r;
      const full = qName(prefix);
      const own = `${q.prefix}-`;
      return {
        ok: true,
        value: r.value.result.collections
          .map((c) => c.name)
          .filter((n) => n.startsWith(full))
          .map((n) => n.slice(own.length)),
      };
    },
    async countPoints(cls, name) {
      const q = needQdrant(cls);
      const r = await call<{ result: { count: number } }>(
        `count ${qName(name)}`,
        'RAG_COUNT_ERROR',
        `${q.url}/collections/${qName(name)}/points/count`,
        { method: 'POST', body: JSON.stringify({ exact: true }) },
      );
      return r.ok ? { ok: true, value: r.value.result.count } : r;
    },
    // Temporary: @mcp-abap-adt/qdrant-rag 29 writes points without
    // `wait=true`, so Qdrant acknowledges a point before applying it and a
    // count right after the last write can miss it (seen: 65 of 66). An update
    // that deletes nothing, sent with `wait=true`, is queued behind those
    // writes and returns once they are applied. Remove once the upstream write
    // takes `wait`.
    async awaitWrites(cls, name) {
      if (rag.backends[cls] !== 'qdrant') return { ok: true, value: undefined };
      const q = needQdrant(cls);
      const r = await call<unknown>(
        `await writes ${qName(name)}`,
        'RAG_WAIT_ERROR',
        `${q.url}/collections/${qName(name)}/points/delete?wait=true`,
        {
          method: 'POST',
          body: JSON.stringify({ filter: { must: [{ has_id: [] }] } }),
        },
      );
      return r.ok ? { ok: true, value: undefined } : r;
    },
    async deleteStore(cls, name) {
      const q = needQdrant(cls);
      const r = await call<unknown>(
        `delete ${qName(name)}`,
        'RAG_DELETE_ERROR',
        `${q.url}/collections/${qName(name)}`,
        { method: 'DELETE' },
      );
      return r.ok ? { ok: true, value: undefined } : r;
    },
    async readToolCatalog() {
      if (rag.backends.tools !== 'qdrant' || !qdrant || !embedding)
        return { ok: true, value: new Map() };
      const r = await toolCatalogProvider(
        qdrant,
        embedding.embedder,
      ).describeCollections();
      if (!r.ok)
        return err(
          `Qdrant catalog unreachable at ${qdrant.url}: ${r.error.message}`,
          'RAG_CATALOG_ERROR',
        );
      return {
        ok: true,
        value: new Map(r.value.records.map((x) => [x.storeName, x.attributes])),
      };
    },
  };
}
