/**
 * Startup wiring of the collection restore (agent-manager): the retry loop is
 * started on the shared registry, and /health's status follows it.
 */
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

import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  InMemoryRag,
  type IRagBackendWriter,
  type IRagEditor,
  type IRetrievalEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  getTrustStore,
  initProviders,
  startCollectionRestore,
} from '../../srv/agent-manager';
import { HISTORY_OPEN_COOL_DOWN_MS } from '../../srv/lib/collection-persistence';
import type { Providers } from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';
import { IN_MEMORY_RAG } from './helpers/providers';

test('Qdrant trust dimension discovery is lazy and retries after a transient embedding failure', async () => {
  const rag = new InMemoryRag();
  const writer = rag.writer();
  const write = jest.fn<
    ReturnType<NonNullable<IRagBackendWriter['upsertPrecomputedRaw']>>,
    Parameters<NonNullable<IRagBackendWriter['upsertPrecomputedRaw']>>
  >(async (id, text, _vector, metadata, options) =>
    writer.upsertRaw(id, text, metadata, options),
  );
  writer.upsertPrecomputedRaw = write;
  jest.spyOn(rag, 'writer').mockReturnValue(writer);
  const embedDocument = jest
    .fn<
      ReturnType<IRetrievalEmbedder['embedDocument']>,
      Parameters<IRetrievalEmbedder['embedDocument']>
    >()
    .mockRejectedValueOnce(new Error('temporary embedder outage'))
    .mockResolvedValue({ vector: [1, 2, 3] });
  const editor: IRagEditor = {
    upsert: async (text, metadata, options) => {
      const { id, ...attributes } = metadata;
      if (typeof id !== 'string') throw new Error('Missing id');
      const result = await writer.upsertRaw(id, text, attributes, options);
      return result.ok ? { ok: true, value: { id } } : result;
    },
    deleteById: (id, options) => writer.deleteByIdRaw(id, options),
  };
  const breaker = new CircuitBreaker();
  const providers = {
    embedding: {
      embedder: new CircuitBreakerEmbedder({ embed: embedDocument }, breaker),
      retrieval: { embedDocument, embedQuery: embedDocument },
      breaker,
      fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
    },
    stores: {
      ...createRagStoreFactory(IN_MEMORY_RAG, null),
      backendOf: () => 'qdrant',
    },
    collections: {
      name: 'test',
      kind: 'vector',
      editable: true,
      supportedScopes: ['user'],
      deleteCollection: async () => ({ ok: true, value: undefined }),
      openCollection: async () => ({ ok: true, value: { rag, editor } }),
      describeCollections: async () => ({
        ok: true,
        value: { records: [], rejected: [] },
      }),
      createCollection: async () => ({ ok: true, value: { rag, editor } }),
    },
    destinations: {
      metadata: async () => undefined,
      list: async () => [],
      clearCache: () => {},
      refuse: () => null,
    },
  } satisfies Providers;
  initProviders(providers);
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  await expect(startCollectionRestore()).resolves.toBeUndefined();
  expect(embedDocument).not.toHaveBeenCalled();
  const store = getTrustStore();
  if (!store) throw new Error('Missing trust store');
  try {
    await expect(store.setSource('skills', 4, 'admin')).rejects.toThrow(
      'temporary embedder outage',
    );
    await expect(store.getSource('skills')).rejects.toThrow(
      'temporary embedder outage',
    );
    expect(embedDocument).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1000 + HISTORY_OPEN_COOL_DOWN_MS);
    await store.setSource('skills', 4, 'admin');
    expect(await store.getSource('skills')).toBe(4);
    expect(embedDocument).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[2]).toEqual([0, 0, 0]);
  } finally {
    jest.restoreAllMocks();
  }
});
