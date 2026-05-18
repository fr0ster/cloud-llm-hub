jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      })),
    },
  }),
  // jest.config.ts maps @sap/cds to a types-only package. Keep this mock
  // virtual so Jest does not try to resolve that package at runtime.
  { virtual: true },
);

import cds from '@sap/cds';
import { CollectionRegistry } from '../../srv/rag-collections';

type WriterScript = Array<{ ok: true } | { ok: false; error: Error }>;

/**
 * Build a CollectionRegistry whose RAG backend is a tiny scripted stub.
 * Each call to upsertRaw consumes the next entry from `script` (last entry
 * is reused if exhausted). Counters of upsertRaw calls are exposed for
 * assertions.
 */
async function makeRegistry(
  script: WriterScript,
  byId?: Map<string, WriterScript>,
) {
  const callsById = new Map<string, number>();
  const writer = {
    upsertRaw: async (id: string, _text: string, _meta: unknown) => {
      callsById.set(id, (callsById.get(id) ?? 0) + 1);
      // Per-id script wins over global script
      const perId = byId?.get(id);
      const s = perId ?? script;
      const idx = Math.min((callsById.get(id) ?? 1) - 1, s.length - 1);
      const next = s[idx];
      if (next.ok) return { ok: true as const, value: undefined };
      return { ok: false as const, error: next.error };
    },
    deleteByIdRaw: async () => ({ ok: true as const, value: true }),
  };
  const ragStub = {
    writer: () => writer,
    upsert: async (text: string, metadata: any) => {
      const { id, ...rest } = metadata;
      const r = await writer.upsertRaw(id, text, rest);
      return r.ok ? { ok: true as const, value: { id } } : r;
    },
    query: async () => ({ ok: true as const, value: [] }),
    getById: async () => ({ ok: true as const, value: null }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
    deleteById: async () => ({ ok: true as const, value: true }),
  };
  const registry = new CollectionRegistry(undefined as any);
  (registry as any).createRagStore = () => ragStub;
  registry.createCollection({
    id: 'test',
    displayName: 'Test',
    description: 'Test collection',
    scope: 'user',
    backend: 'mem',
  } as any);
  return { registry, callsById };
}

describe('addDocument (Result-aware)', () => {
  it('persists the document when upsert succeeds', async () => {
    const { registry } = await makeRegistry([{ ok: true }]);
    const doc = await (registry as any).addDocument('test', {
      id: 'a-0',
      text: 'hello',
      metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
    });
    expect(doc.id).toBe('a-0');
    expect(doc.createdAt).toBeDefined();
  });

  it('throws when upsert returns Result.ok=false', async () => {
    const { registry } = await makeRegistry([
      {
        ok: false,
        error: new Error('Qdrant upsert failed: 503 Service Unavailable'),
      },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow(/503/);
  });

  it('does NOT persist the document when upsert fails', async () => {
    const { registry } = await makeRegistry([
      { ok: false, error: new Error('Qdrant upsert failed: 401') },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow();
    // The stored.documents map must not contain a-0
    const stored = (registry as any).collections.get('test');
    expect(stored.documents.has('a-0')).toBe(false);
  });
});
