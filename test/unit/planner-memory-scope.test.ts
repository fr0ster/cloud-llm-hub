import { HanaVectorRag } from '@mcp-abap-adt/hana-vector-rag';
import {
  InMemoryRag,
  type IRag,
  isRagFilteredDeleter,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { PgVectorRag } from '@mcp-abap-adt/pg-vector-rag';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import { plannerMemoryStore } from '../../srv/lib/planner-context';
import {
  forgetScopedPlannerMemory,
  scopedPlannerMemory,
} from '../../srv/lib/planner-memory-scope';
import { turnOwner } from '../../srv/lib/session-history-rag';

const queryEmbedding = { text: 'memory', toVector: async () => [1, 0] };
const embedding = symmetricEmbedder({
  embed: async () => ({ vector: [1, 0] }),
});

it.each([
  ['vector', VectorRag.prototype],
  ['qdrant', QdrantRag.prototype],
  ['hana-vector', HanaVectorRag.prototype],
  ['pg-vector', PgVectorRag.prototype],
])(
  '%s supports filtered cleanup in the installed library',
  (_kind, prototype) => {
    expect(isRagFilteredDeleter(prototype)).toBe(true);
  },
);

it('in-memory sessions have no planner records to clean', () => {
  const create = jest.fn();
  expect(
    plannerMemoryStore({ kind: 'in-memory', create, persistent: create }),
  ).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
});

it.each(['raw', 'precomputed', 'batch'] as const)(
  'isolates users with identical session and record ids through %s writes',
  async (mode) => {
    const rag = new VectorRag(embedding);
    const backend = rag.writer();
    backend.upsertManyPrecomputedRaw = async (items) => {
      for (const item of items) {
        const result = await backend.upsertPrecomputedRaw?.(
          item.id,
          item.text,
          item.vector,
          item.metadata,
        );
        if (result && !result.ok) return result;
      }
      return { ok: true, value: undefined };
    };
    jest.spyOn(rag, 'writer').mockReturnValue(backend);
    const aliceOwner = turnOwner('alice', 'fixed');
    const bobOwner = turnOwner('bob', 'fixed');
    const alice = scopedPlannerMemory(rag, aliceOwner, 'fixed');
    const bob = scopedPlannerMemory(rag, bobOwner, 'fixed');
    const id = `planner:fixed:message:${'x'.repeat(300)}:0`;
    for (const [store, text] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
    ] as const) {
      const writer = store.writer?.();
      if (!writer) throw new Error('Missing writer');
      const meta = { sessionId: 'fixed', kind: 'message' };
      const result =
        mode === 'raw'
          ? await writer.upsertRaw(id, text, meta)
          : mode === 'precomputed'
            ? await writer.upsertPrecomputedRaw?.(id, text, [1, 0], meta)
            : await writer.upsertManyPrecomputedRaw?.([
                { id, text, vector: [1, 0], metadata: meta },
              ]);
      expect(result?.ok).toBe(true);
    }
    const rows = await rag.scan();
    expect(rows.ok && rows.value.records).toHaveLength(2);
    if (rows.ok) {
      expect(new Set(rows.value.records.map((r) => r.id)).size).toBe(2);
      expect(rows.value.records.every((r) => r.id.length <= 255)).toBe(true);
    }
    for (const [store, text] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
    ] as const) {
      const result = await store.query(queryEmbedding, 1, {
        ragFilter: { sessionId: 'forged' },
      });
      expect(result.ok && result.value).toEqual([
        expect.objectContaining({
          text,
          metadata: { id, sessionId: 'fixed', kind: 'message' },
        }),
      ]);
      const found = await store.getById(id);
      expect(found.ok && found.value?.text).toBe(text);
    }
    expect(await forgetScopedPlannerMemory(rag, aliceOwner)).toBe(true);
    expect(await alice.getById(id)).toEqual({ ok: true, value: null });
    const found = await bob.getById(id);
    expect(found.ok && found.value?.text).toBe('Bob');
  },
);

it('keeps query filters and scopes cleanup independently of the supplied filter', async () => {
  const rag = new InMemoryRag();
  const query = jest.spyOn(rag, 'query');
  const store = scopedPlannerMemory(rag, 'owner', 'key');
  await store.query(queryEmbedding, 2, {
    ragFilter: { sessionId: 'key', namespace: 'n', userId: 'u' },
  });
  expect(query).toHaveBeenCalledWith(queryEmbedding, 2, {
    ragFilter: { sessionId: 'owner', namespace: 'n', userId: 'u' },
  });
  const remove = jest.spyOn(rag, 'deleteWhere');
  await forgetScopedPlannerMemory(rag, 'owner');
  expect(remove).toHaveBeenCalledWith({ sessionId: 'owner' });
});

it('deletes tracked ids without filtered delete, preserving other owners', async () => {
  const inner = new InMemoryRag();
  const rag: IRag = {
    query: inner.query.bind(inner),
    getById: inner.getById.bind(inner),
    healthCheck: inner.healthCheck.bind(inner),
    writer: inner.writer.bind(inner),
  };
  for (const owner of ['alice', 'bob']) {
    await scopedPlannerMemory(rag, owner, 'fixed')
      .writer?.()
      ?.upsertRaw('same', owner, {});
  }
  expect(await forgetScopedPlannerMemory(rag, 'alice')).toBe(true);
  expect(
    await scopedPlannerMemory(rag, 'alice', 'fixed').getById('same'),
  ).toEqual({ ok: true, value: null });
  const bob = await scopedPlannerMemory(rag, 'bob', 'fixed').getById('same');
  expect(bob.ok && bob.value?.text).toBe('bob');
  expect(await forgetScopedPlannerMemory(rag, 'unknown')).toBe(true);
});
