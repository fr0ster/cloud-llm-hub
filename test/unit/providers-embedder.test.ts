import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
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
    expect(e?.embedder).toBeInstanceOf(CircuitBreakerEmbedder);
    expect(e?.fingerprint).toEqual(embedderFingerprint(cfg));
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
    const embedder = new CircuitBreakerEmbedder({ embed }, breaker);
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

  it("meters the agent's query embeddings in the request log", async () => {
    const { embed, embedding } = stub();
    const logLlmCall = jest.fn();
    const r = await agentQueryEmbedder(embedding).embedQuery('find a class', {
      requestLogger: { logLlmCall } as never,
    });
    expect(r.vector).toEqual([1, 2]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(logLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'embedding', totalTokens: 3 }),
    );
  });
});
