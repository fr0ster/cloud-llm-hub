import { CircuitBreakerEmbedder } from '@mcp-abap-adt/llm-agent';
import {
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
