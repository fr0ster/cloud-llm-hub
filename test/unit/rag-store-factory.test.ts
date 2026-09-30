import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  FallbackRag,
  InMemoryRag,
  QueryEmbedding,
  RagError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import type { RagConfig } from '../../srv/agent-config';
import { buildEmbedding, prefetchEmbedder } from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';

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

  it('vector builds FallbackRag, qdrant builds a bare QdrantRag (no keyword fallback)', () => {
    const f = createRagStoreFactory(q, buildEmbedding(emb));
    expect(f.create('session', 'history')).toBeInstanceOf(FallbackRag);
    const t = f.create('tools', 'tools-reader-a-b');
    expect(t).toBeInstanceOf(QdrantRag);
    expect(t).not.toBeInstanceOf(FallbackRag);
    expect(f.qdrantCollection('tools-reader-a-b')).toBe(
      'hub-test-tools-reader-a-b',
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
    const embedder = new CircuitBreakerEmbedder(brokenEmbedder, breaker);
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
});
