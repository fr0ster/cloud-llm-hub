import {
  CircuitBreaker,
  CircuitBreakerEmbedderBase,
  FallbackRag,
  InMemoryRag,
  type IRagBackendWriter,
  QueryEmbedding,
  RagError,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import type { RagConfig } from '../../srv/agent-config';
import { buildEmbedding, prefetchEmbedder } from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';
import { fingerprintHash } from '../../srv/lib/tool-corpus';
import {
  qdrantMultivectorConfig,
  qdrantQueryFetch,
} from './helpers/qdrant-fetch';

const inMem: RagConfig = {
  embedder: null,
  backends: {
    tools: 'in-memory',
    session: 'in-memory',
    persistent: 'in-memory',
  },
};
const emb = {
  kind: 'ollama' as const,
  model: 'bge-m3',
  url: 'http://localhost:11434',
};
const q: RagConfig = {
  embedder: emb,
  backends: { tools: 'qdrant', session: 'vector', persistent: 'vector' },
  qdrant: { url: 'http://localhost:6433', prefix: 'hub-test' },
};

describe('RagStoreFactory', () => {
  beforeAll(() => prefetchEmbedder(emb));
  afterEach(() => jest.restoreAllMocks());

  it('in-memory builds InMemoryRag', () => {
    expect(
      createRagStoreFactory(inMem, null).create('tools', 'x'),
    ).toBeInstanceOf(InMemoryRag);
  });

  it('vector/qdrant with no embedder built fails fast instead of silently downgrading', () => {
    const noEmbedder: RagConfig = {
      embedder: null,
      backends: { tools: 'qdrant', session: 'vector', persistent: 'in-memory' },
      qdrant: { url: 'http://localhost:6433', prefix: 'hub-test' },
    };
    const f = createRagStoreFactory(noEmbedder, null);
    expect(() => f.create('session', 'history')).toThrow(
      'RAG class session is vector but no embedder was built',
    );
    expect(() => f.create('tools', 'reader-a')).toThrow(
      'RAG class tools is qdrant but no embedder was built',
    );
    expect(f.create('persistent', 'x')).toBeInstanceOf(InMemoryRag);
  });

  it('session vector writes use a primary VectorRag; qdrant uses a bare QdrantRag', () => {
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    expect(f.create('session', 'history')).toBeInstanceOf(VectorRag);
    expect(f.create('session', 'history')).not.toBeInstanceOf(FallbackRag);
    const t = f.create('tools', 'tools-reader-a-b');
    expect(t).toBeInstanceOf(QdrantRag);
    expect(t).not.toBeInstanceOf(FallbackRag);
    expect(f.qdrantCollection('tools-reader-a-b')).toBe(
      'hub-test-tools-reader-a-b',
    );
  });

  it('stamps standalone Qdrant planner memory writes through every writer method', async () => {
    type Single = NonNullable<IRagBackendWriter['upsertPrecomputedRaw']>;
    type Many = NonNullable<IRagBackendWriter['upsertManyPrecomputedRaw']>;
    const success = { ok: true, value: undefined } as const;
    const upsertRaw = jest.fn(
      async (..._args: Parameters<IRagBackendWriter['upsertRaw']>) => success,
    );
    const upsertPrecomputedRaw = jest.fn(
      async (..._args: Parameters<Single>) => success,
    );
    const upsertManyPrecomputedRaw = jest.fn(
      async (..._args: Parameters<Many>) => success,
    );
    jest.spyOn(QdrantRag.prototype, 'writer').mockReturnValue({
      upsertRaw,
      upsertPrecomputedRaw,
      upsertManyPrecomputedRaw,
      deleteByIdRaw: async () => ({ ok: true, value: true }),
    });
    const embedding = buildEmbedding(emb);
    if (!embedding) throw new Error('Missing embedding');
    const factory = createRagStoreFactory(
      { ...q, backends: { ...q.backends, session: 'qdrant' } },
      embedding,
    );
    const writer = factory.create('session', 'planner-memory').writer?.();
    if (!writer?.upsertPrecomputedRaw || !writer.upsertManyPrecomputedRaw)
      throw new Error('Missing planner memory writer');
    const metadata = { embedder: 'old', namespace: 'owner' };
    const stamped = {
      ...metadata,
      embedder: fingerprintHash(embedding.fingerprint),
    };
    const vector = [1, 0];
    const options = { signal: new AbortController().signal };
    await writer.upsertRaw('a', 'first', metadata, options);
    await writer.upsertPrecomputedRaw('b', 'second', vector, metadata, options);
    await writer.upsertManyPrecomputedRaw(
      [{ id: 'c', text: 'third', vector, metadata }],
      options,
    );

    expect(upsertRaw).toHaveBeenCalledWith('a', 'first', stamped, options);
    expect(upsertPrecomputedRaw).toHaveBeenCalledWith(
      'b',
      'second',
      vector,
      stamped,
      options,
    );
    expect(upsertManyPrecomputedRaw).toHaveBeenCalledWith(
      [{ id: 'c', text: 'third', vector, metadata: stamped }],
      options,
    );
  });

  it('createLocal is process-local whatever the backend: never a QdrantRag', () => {
    const local = createRagStoreFactory(q, buildEmbedding(emb)).createLocal();
    expect(local).toBeInstanceOf(FallbackRag);
    expect(local).not.toBeInstanceOf(QdrantRag);
    expect(createRagStoreFactory(inMem, null).createLocal()).toBeInstanceOf(
      InMemoryRag,
    );
  });

  it('createLocalTools uses a primary local vector store, or in-memory without an embedder', () => {
    const local = createRagStoreFactory(
      q,
      buildEmbedding(emb),
    ).createLocalTools();
    expect(local).toBeInstanceOf(VectorRag);
    expect(local).not.toBeInstanceOf(FallbackRag);
    expect(
      createRagStoreFactory(inMem, null).createLocalTools(),
    ).toBeInstanceOf(InMemoryRag);
  });

  it('listStores / countPoints / deleteStore talk to Qdrant REST and map errors to RagError', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              collections: [
                { name: 'hub-test-tools-reader-1' },
                { name: 'other' },
              ],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { count: 42 } })),
      )
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    expect(await f.listStores('tools', 'tools-reader-')).toEqual({
      ok: true,
      value: ['tools-reader-1'],
    });
    expect(await f.countPoints('tools', 'tools-reader-1')).toEqual({
      ok: true,
      value: 42,
    });
    expect((await f.deleteStore('tools', 'tools-reader-1')).ok).toBe(true);
    const bad = await f.listStores('tools', 'x');
    expect(bad.ok).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:6433/collections/hub-test-tools-reader-1/points/count',
    );
  });

  it('awaitWrites sends a wait=true no-op delete on qdrant and maps failures to RagError', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { status: 'completed' } })),
      )
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const f = createRagStoreFactory(
      {
        ...q,
        qdrant: {
          url: 'http://localhost:6433',
          prefix: 'hub-test',
          apiKey: 'k',
        },
      },
      buildEmbedding(emb),
    );
    expect(await f.awaitWrites('tools', 'tools-reader-1')).toEqual({
      ok: true,
      value: undefined,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:6433/collections/hub-test-tools-reader-1/points/delete?wait=true',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ 'api-key': 'k' }));
    expect(JSON.parse(String(init.body))).toEqual({
      filter: { must: [{ has_id: [] }] },
    });
    for (const expected of [/HTTP 500 boom/, /ECONNREFUSED/]) {
      const r = await f.awaitWrites('tools', 'tools-reader-1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(RagError);
        expect(r.error.message).toMatch(expected);
      }
    }
  });

  it('an unreachable Qdrant or a non-JSON body is a RagError, never a throw', async () => {
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    const ops = [
      () => f.listStores('tools', 'tools-reader-'),
      () => f.countPoints('tools', 'tools-reader-1'),
      () => f.deleteStore('tools', 'tools-reader-1'),
    ];
    for (const op of ops) {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockResolvedValueOnce(new Response('<html>proxy error</html>'));
      for (const expected of [/ECONNREFUSED/, /JSON/]) {
        const r = await op();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toBeInstanceOf(RagError);
          expect(r.error.message).toMatch(expected);
        }
      }
      jest.restoreAllMocks();
    }
  });

  it('readToolCatalog: empty with no request off qdrant, RagError when Qdrant is down', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const off = await createRagStoreFactory(inMem, null).readToolCatalog();
    expect(off).toEqual({ ok: true, value: new Map() });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const down = await createRagStoreFactory(
      q,
      buildEmbedding(emb),
    ).readToolCatalog();
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.error).toBeInstanceOf(RagError);
      expect(down.error.message).toMatch(
        /Qdrant catalog unreachable at http:\/\/localhost:6433/,
      );
    }
  });

  it('awaitWrites resolves at once for in-memory and vector, with no request', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    expect(
      (await createRagStoreFactory(inMem, null).awaitWrites('tools', 'x')).ok,
    ).toBe(true);
    expect(
      (
        await createRagStoreFactory(q, buildEmbedding(emb)).awaitWrites(
          'session',
          'x',
        )
      ).ok,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('qdrant query surfaces an embedder failure as a RagError, never a network call', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const brokenEmbedder = {
      embed: async () => {
        throw new Error('embedder down');
      },
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 30,
      recoveryWindowMs: 60_000,
    });
    const embedder = new CircuitBreakerEmbedderBase(brokenEmbedder, breaker);
    const brokenEmbedding = {
      embedder,
      retrieval: symmetricEmbedder(embedder),
      breaker,
      fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
    };
    const f = createRagStoreFactory(q, brokenEmbedding);
    const store = f.create('tools', 'tools-reader-a');
    const result = await store.query(
      new QueryEmbedding('x', brokenEmbedding.retrieval),
      5,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(RagError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['vector', 'qdrant'] as const)(
    '%s non-tool stores retain the default query embedding fallback',
    async (backend) => {
      const multivector = qdrantQueryFetch(qdrantMultivectorConfig(2));
      const legacy = qdrantQueryFetch({
        dense: { size: 2, distance: 'Cosine' },
      });
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockImplementation((input, init) =>
          new URL(String(input)).pathname.startsWith(
            '/collections/hub-test-facts',
          )
            ? legacy(input, init)
            : multivector(input, init),
        );
      const raw = jest.fn(async () => ({ vector: [1, 0] }));
      const breaker = new CircuitBreaker({ failureThreshold: 30 });
      const embedder = new CircuitBreakerEmbedderBase({ embed: raw }, breaker);
      const embedding = {
        embedder,
        retrieval: symmetricEmbedder(embedder),
        breaker,
        fingerprint: { provider: 'test', embeddingModel: 'test' },
      };
      const factory = createRagStoreFactory(
        {
          ...q,
          backends: { tools: backend, session: backend, persistent: backend },
        },
        embedding,
      );
      for (const store of [
        factory.create('session', 'history'),
        factory.create('persistent', 'facts'),
        factory.createLocal(),
      ]) {
        raw.mockClear();
        raw.mockRejectedValueOnce(new Error('first embedding failed'));
        expect(
          (
            await store.query(
              new QueryEmbedding('read', embedding.retrieval),
              1,
            )
          ).ok,
        ).toBe(true);
        expect(raw).toHaveBeenCalledTimes(2);
      }
      const queries = fetchMock.mock.calls
        .filter(
          ([input, init]) =>
            init?.method === 'POST' && String(input).endsWith('/points/query'),
        )
        .map(([, init]): { query: number[] | number[][]; using?: string } =>
          JSON.parse(String(init?.body)),
        );
      expect(queries).toEqual(
        backend === 'qdrant'
          ? [
              expect.objectContaining({ query: [[1, 0]] }),
              expect.objectContaining({ query: [1, 0], using: 'dense' }),
            ]
          : [],
      );
    },
  );
});
