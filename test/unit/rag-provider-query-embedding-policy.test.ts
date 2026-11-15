import { HanaVectorRagProvider } from '@mcp-abap-adt/hana-vector-rag';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  type IRetrievalEmbedder,
  QueryEmbedding,
  staticLogin,
} from '@mcp-abap-adt/llm-agent';
import { PgVectorRagProvider } from '@mcp-abap-adt/pg-vector-rag';
import { parseRagConfig } from '../../srv/agent-config';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';

const backends = ['hana-vector', 'pg-vector'] as const;

function providerFor(
  backend: (typeof backends)[number],
  embedder: IRetrievalEmbedder,
  fallbackOnQueryEmbeddingError?: boolean,
) {
  const config = {
    name: 'collections',
    embedder,
    autoCreateSchema: false,
    defaultDimension: 2,
  };
  if (backend === 'hana-vector')
    return new HanaVectorRagProvider({
      ...config,
      connection: {
        host: 'hana.invalid',
        collectionName: 'collections',
        credential: staticLogin('user', 'password'),
        fallbackOnQueryEmbeddingError,
      },
      clientFactory: () => ({
        exec: async () => ({ rowCount: 0 }),
        query: async () => [],
        close: async () => {},
      }),
    });
  return new PgVectorRagProvider({
    ...config,
    connection: {
      connectionString: 'postgres://pg.invalid/db',
      collectionName: 'collections',
      fallbackOnQueryEmbeddingError,
    },
    clientFactory: () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      end: async () => {},
    }),
  });
}

describe.each(backends)('%s query embedding policy', (backend) => {
  test('the hub rejects tools on this backend before a provider can be used', () => {
    expect(() =>
      parseRagConfig(
        { LLM_AGENT_TOOLS_RAG_BACKEND: backend },
        { provider: 'sap-ai-sdk' },
      ),
    ).toThrow(`LLM_AGENT_TOOLS_RAG_BACKEND=${backend} is not supported yet`);
  });

  test('the store factory also refuses tools when config validation is bypassed', () => {
    const embed = async () => ({ vector: [1, 0] });
    const breaker = new CircuitBreaker();
    const factory = createRagStoreFactory(
      {
        embedder: null,
        backends: { tools: backend, session: backend, persistent: backend },
      },
      {
        embedder: new CircuitBreakerEmbedder({ embed }, breaker),
        retrieval: { embedDocument: embed, embedQuery: embed },
        breaker,
        fingerprint: { provider: 'test', embeddingModel: 'test' },
      },
    );
    expect(() => factory.create('tools', 'reader')).toThrow(
      'opened through the collection provider, never as bare stores',
    );
  });

  test.each([undefined, false])(
    'connection fallback=%s applies to every opened collection regardless of its source',
    async (policy) => {
      const embedQuery = jest.fn(async () => ({ vector: [1, 0] }));
      const embedder: IRetrievalEmbedder = {
        embedDocument: async () => ({ vector: [1, 0] }),
        embedQuery,
      };
      const provider = providerFor(backend, embedder, policy);
      try {
        for (const source of [
          'tools-reader',
          'tools-writer',
          'history',
          'documents',
        ]) {
          embedQuery.mockClear();
          embedQuery.mockRejectedValueOnce(
            new Error('caller embedding failed'),
          );
          const opened = await provider.openCollection({
            storeName: source.replaceAll('-', '_'),
            name: source,
            scope: 'global',
            attributes: { source },
          });
          if (!opened.ok) throw opened.error;
          const result = await opened.value.rag.query(
            new QueryEmbedding('read', embedder),
            1,
          );
          expect(result.ok).toBe(policy !== false);
          expect(embedQuery).toHaveBeenCalledTimes(policy === false ? 1 : 2);
          if (!result.ok)
            expect(result.error.message).toContain('caller embedding failed');
        }
      } finally {
        provider.close();
      }
    },
  );
});
