/**
 * Providers for unit tests that exercise the real agent-manager: the default
 * configuration (in-memory everywhere, no embedder). No network is contacted.
 *
 * Synchronous on purpose, so a test can call it at module level before it
 * takes the registry. With no embedder, `startProviders` prefetches nothing and
 * builds these same store instances (see providers-wiring.test.ts). The
 * destination source is an empty stub: these tests reach destinations through
 * their own mocks, and `startProviders` would also install it globally.
 */
import type { RagConfig } from '../../../srv/agent-config';
import { initProviders } from '../../../srv/agent-manager';
import { createRagStoreFactory } from '../../../srv/lib/rag-store-factory';

export const IN_MEMORY_RAG: RagConfig = {
  embedder: null,
  backends: {
    tools: 'in-memory',
    session: 'in-memory',
    persistent: 'in-memory',
  },
};

export function initInMemoryProviders(): void {
  initProviders({
    embedding: null,
    stores: createRagStoreFactory(IN_MEMORY_RAG, null),
    destinations: { list: async () => [], clearCache: () => {} },
  });
}
