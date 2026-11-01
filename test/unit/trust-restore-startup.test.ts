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

import { InMemoryRag, type IRagBackendWriter } from '@mcp-abap-adt/llm-agent';
import {
  getTrustStore,
  initProviders,
  startCollectionRestore,
} from '../../srv/agent-manager';
import { HISTORY_OPEN_COOL_DOWN_MS } from '../../srv/lib/collection-persistence';

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
    .fn()
    .mockRejectedValueOnce(new Error('temporary embedder outage'))
    .mockResolvedValue({ vector: [1, 2, 3] });
  initProviders({
    embedding: {
      retrieval: { embedDocument },
      breaker: null,
      fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
    },
    stores: { backendOf: () => 'qdrant' },
    collections: {
      openCollection: async () => ({ ok: true, value: { rag, editor: {} } }),
      describeCollections: async () => ({
        ok: true,
        value: { records: [], rejected: [] },
      }),
      createCollection: async () => ({ ok: true, value: { rag, editor: {} } }),
    },
    destinations: {
      metadata: async () => undefined,
      list: async () => [],
      clearCache: () => {},
      refuse: () => null,
    },
  } as never);
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
