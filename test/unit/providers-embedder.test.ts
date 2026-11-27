import {
  CircuitBreaker,
  CircuitBreakerEmbedderBase,
  isBatchEmbedder,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { z } from 'zod';
import {
  agentQueryEmbedder,
  buildEmbedding,
  embedderFingerprint,
  prefetchEmbedder,
} from '../../srv/lib/providers';

describe('embedder from configuration', () => {
  it('null config → no embedding', () => {
    expect(buildEmbedding(null)).toBeNull();
  });

  it('AI Core fingerprint keeps the committed bundle header shape', () => {
    expect(
      embedderFingerprint({
        kind: 'sap-ai-core',
        model: 'text-embedding-3-small',
        resourceGroup: 'default',
      }),
    ).toEqual({
      provider: 'sap-ai-sdk',
      embeddingModel: 'text-embedding-3-small',
      resourceGroup: 'default',
    });
  });

  it('openai and ollama fingerprints carry their URL', () => {
    expect(
      embedderFingerprint({
        kind: 'openai',
        model: 'm',
        url: 'http://e.example.com/v1',
        apiKey: 'k',
      }),
    ).toEqual({
      provider: 'openai',
      embeddingModel: 'm',
      baseURL: 'http://e.example.com/v1',
    });
    expect(
      embedderFingerprint({
        kind: 'ollama',
        model: 'bge-m3',
        url: 'http://localhost:11434',
      }),
    ).toEqual({
      provider: 'ollama',
      embeddingModel: 'bge-m3',
      baseURL: 'http://localhost:11434',
    });
  });

  it.each([
    [
      {
        kind: 'ollama' as const,
        model: 'bge-m3',
        url: 'http://localhost:11434',
      },
    ],
    [
      {
        kind: 'openai' as const,
        model: 'm',
        url: 'http://e.example.com/v1',
        apiKey: 'k',
      },
    ],
    [
      {
        kind: 'sap-ai-core' as const,
        model: 'text-embedding-3-small',
        resourceGroup: 'default',
      },
    ],
  ])('builds a breaker-wrapped embedder for %j', async (cfg) => {
    await prefetchEmbedder(cfg);
    const e = buildEmbedding(cfg);
    expect(e?.embedder).toBeInstanceOf(CircuitBreakerEmbedderBase);
    expect(e?.fingerprint).toEqual(embedderFingerprint(cfg));
  });

  it('preserves batch capability for both breaker-wrapped embedders', async () => {
    const aiCore = buildEmbedding({
      kind: 'sap-ai-core',
      model: 'text-embedding-3-small',
      resourceGroup: 'default',
    });
    if (!aiCore?.toolSearchEmbedder)
      throw new Error('Expected AI Core embedders');
    expect(isBatchEmbedder(aiCore.embedder)).toBe(false);
    expect(isBatchEmbedder(aiCore.toolSearchEmbedder)).toBe(false);

    const cfg = {
      kind: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'k',
    } as const;
    await prefetchEmbedder(cfg);
    const openai = buildEmbedding(cfg);
    if (!openai?.toolSearchEmbedder)
      throw new Error('Expected OpenAI embedders');
    expect(isBatchEmbedder(openai.embedder)).toBe(true);
    expect(isBatchEmbedder(openai.toolSearchEmbedder)).toBe(true);
  });
});

// llm-agent 30 split the embedder into roles and stopped metering embedding
// usage inside the builder; these hold the hub's side of that contract.
describe('embedder roles (llm-agent 30)', () => {
  const stub = () => {
    const embed = jest.fn(async () => ({
      vector: [1, 2],
      usage: { promptTokens: 3, totalTokens: 3 },
    }));
    const breaker = new CircuitBreaker({
      failureThreshold: 30,
      recoveryWindowMs: 60_000,
    });
    const embedder = new CircuitBreakerEmbedderBase({ embed }, breaker);
    return {
      embed,
      embedding: {
        embedder,
        retrieval: symmetricEmbedder(embedder),
        breaker,
        fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
      },
    };
  };

  it('gives the built embedder both retrieval roles over the same provider', async () => {
    await prefetchEmbedder({
      kind: 'ollama',
      model: 'bge-m3',
      url: 'http://localhost:11434',
    });
    const e = buildEmbedding({
      kind: 'ollama',
      model: 'bge-m3',
      url: 'http://localhost:11434',
    });
    expect(typeof e?.retrieval.embedDocument).toBe('function');
    expect(typeof e?.retrieval.embedQuery).toBe('function');
  });

  it('stores a full record using fragments within the Ollama model capacity', async () => {
    const cfg = { kind: 'ollama', model: 'small' } as const;
    await prefetchEmbedder(cfg);
    const embedding = buildEmbedding(cfg);
    if (!embedding) throw new Error('Expected embedder');
    const embedded: string[][] = [];
    const signal = new AbortController().signal;
    const request = z.object({
      input: z.array(z.string().max(4)),
      truncate: z.literal(false),
    });
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, options) => {
        expect(options?.signal).toBe(signal);
        const url = input.toString();
        if (url.endsWith('/api/show'))
          return Response.json({ model_info: { 'small.context_length': 18 } });
        if (!url.endsWith('/api/embed') || typeof options?.body !== 'string')
          throw new Error(`Unexpected Ollama request: ${url}`);
        const { input: fragments } = request.parse(JSON.parse(options.body));
        embedded.push(fragments);
        return Response.json({ embeddings: fragments.map(() => [1, 2]) });
      });
    try {
      const store = new VectorRag(embedding.retrieval);
      const text = 'abcdefghij';
      const written = await store.upsert(text, {}, { signal });
      if (!written.ok) throw written.error;
      expect(embedded).toEqual([['abcd', 'efgh', 'ij']]);
      const result = await store.scan({});
      if (!result.ok) throw result.error;
      expect(result.value.records).toMatchObject([{ text }]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("meters the agent's query embeddings in the request log", async () => {
    const { embed, embedding } = stub();
    const requestLogger = new NoopRequestLogger();
    const logLlmCall = jest.spyOn(requestLogger, 'logLlmCall');
    const r = await agentQueryEmbedder(embedding).embedQuery('find a class', {
      requestLogger,
    });
    expect(r.vector).toEqual([1, 2]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(logLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'embedding', totalTokens: 3 }),
    );
  });
});
