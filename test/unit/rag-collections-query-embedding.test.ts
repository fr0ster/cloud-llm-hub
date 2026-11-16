jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import {
  CircuitBreaker,
  QueryEmbedding,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { CollectionRegistry } from '../../srv/rag-collections';

test.each(['user', 'session', 'global'] as const)(
  'built-in vector document collections retain query embedding fallback (%s)',
  async (scope) => {
    const embedQuery = jest.fn(async () => ({ vector: [1, 0] }));
    embedQuery.mockRejectedValueOnce(new Error('first embedding failed'));
    const embedder = {
      embedDocument: async () => ({ vector: [1, 0] }),
      embedQuery,
    };
    const registry = new CollectionRegistry({ embedder });
    await registry.createCollection({
      id: 'documents',
      logicalId: 'documents',
      displayName: 'Documents',
      description: '',
      scope,
      owner: 'alice',
      ...(scope === 'session' ? { sessionId: 'session' } : {}),
    });
    const store = await registry.getRagStore('documents');
    if (!store) throw new Error('Missing document store');
    expect(await store.query(new QueryEmbedding('read', embedder), 1)).toEqual({
      ok: true,
      value: [],
    });
    expect(embedQuery).toHaveBeenCalledTimes(2);
  },
);

test('built-in vector document collections retain keyword fallback with an open breaker', async () => {
  const embedQuery = jest.fn(async () => ({ vector: [1, 0] }));
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const registry = new CollectionRegistry({
    embedder: { embedDocument: embedQuery, embedQuery },
    breaker,
  });
  await registry.createCollection({
    id: 'documents',
    logicalId: 'documents',
    displayName: 'Documents',
    description: '',
    scope: 'user',
    owner: 'alice',
  });
  const store = await registry.getRagStore('documents');
  if (!store) throw new Error('Missing document store');
  breaker.recordFailure();
  expect(await store.query(new TextOnlyEmbedding('read'), 1)).toEqual({
    ok: true,
    value: [],
  });
  expect(embedQuery).not.toHaveBeenCalled();
});
