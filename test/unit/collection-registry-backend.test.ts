jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {},
    },
  }),
  { virtual: true },
);

import type { RagConfig } from '../../srv/agent-config';
import { getCollectionRegistry, initProviders } from '../../srv/agent-manager';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';

// An embedder exists (tools are on vector), but LLM_AGENT_RAG_BACKEND asked for
// in-memory persistent collections: the registry must follow the configured
// class, not infer `vector` from the embedder's presence.
const rag: RagConfig = {
  embedder: { kind: 'ollama', model: 'bge-m3', url: 'http://localhost:11434' },
  backends: { tools: 'vector', session: 'vector', persistent: 'in-memory' },
};
const embedding = {
  embedder: { embed: async () => ({ vector: [0] }) },
  breaker: null,
  fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
} as never;

it('persistent collections use the configured persistent backend', () => {
  initProviders({
    embedding,
    stores: createRagStoreFactory(rag, embedding),
    destinations: { list: async () => [], clearCache: () => {} },
  });
  const meta = getCollectionRegistry().createCollection({
    id: 'notes',
    logicalId: 'notes',
    displayName: 'notes',
    description: '',
    scope: 'user',
    owner: 'alice',
  });
  expect(meta.backend).toBe('in-memory');
});
