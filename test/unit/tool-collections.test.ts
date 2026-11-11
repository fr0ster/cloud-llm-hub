import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import {
  collectionFor,
  ExpositionFilteringRag,
  getSharedCorpusDocs,
  runWithRequestConnection,
} from '../../srv/agent-manager';
import { resolveExposition } from '../../srv/lib/exposition';

type Row = { score: number; metadata: Record<string, unknown> };

/** A store that records what was written to it and answers queries from that. */
function fakeStore() {
  const rows: Row[] = [];
  // Counts queries, so a test can assert the writer collection was never even
  // ASKED — not merely that its results were filtered out afterwards, which is
  // the whole difference this split makes.
  const stats = { queries: 0 };
  const deleted: string[] = [];
  return {
    rows,
    stats,
    deleted,
    query: async () => {
      stats.queries++;
      return {
        ok: true as const,
        value: rows.map((row) => ({ text: '', ...row })),
      };
    },
    getById: async () => ({ ok: true as const, value: null }),
    writer: () => ({
      upsertRaw: async (id: string, _t: string, m: Record<string, unknown>) => {
        rows.push({ score: 0.9, metadata: { id, ...m } });
        return { ok: true as const, value: undefined };
      },
      // Honours the real contract: Result<boolean>, true only when this store
      // actually held the id. A fake returning undefined made the aggregation
      // bug invisible.
      deleteByIdRaw: async (id: string) => {
        deleted.push(id);
        const i = rows.findIndex((r) => r.metadata.id === id);
        if (i >= 0) rows.splice(i, 1);
        return { ok: true as const, value: i >= 0 };
      },
    }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
  };
}

// The point of splitting is that a tool a role cannot run is not in the
// collection that role searches — so it cannot reach the model's context at
// all, rather than being removed afterwards by a filter that might not run.
describe('role-scoped tool collections', () => {
  it('offers each corpus tool once when a caller searches both role collections', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(
      reader,
      writer,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      1000,
      1000,
    );
    const backend = rag.writer();
    if (!backend) throw new Error('no writer');
    const docs = getSharedCorpusDocs();
    for (const doc of docs) {
      const result = await backend.upsertRaw(doc.id, doc.text, {
        name: doc.name,
        exposition: doc.exposition,
      });
      expect(result.ok).toBe(true);
    }
    expect(reader.rows.length).toBeGreaterThan(0);
    expect(writer.rows.length).toBeGreaterThan(0);
    const result = await rag.query(
      new TextOnlyEmbedding('tools'),
      docs.length,
      {
        ragFilter: {
          exposition: resolveExposition(['MCP_Reader', 'MCP_Developer']),
        },
      },
    );
    if (!result.ok) throw new Error('query failed');
    const names = result.value.map((row) => row.metadata.name);
    expect(reader.stats.queries).toBe(1);
    expect(writer.stats.queries).toBe(1);
    expect(names).toHaveLength(docs.length);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(docs.map((doc) => doc.name).sort());
  });

  it('routes by the ROLE boundary, not by whether a tool modifies', () => {
    // `high` holds ~70 read tools (GetPackage, GetTable…). Routing by semantics
    // would put those in the reader collection and drift from the boundary the
    // execution check enforces.
    expect(collectionFor('readonly')).toBe('reader');
    expect(collectionFor('search')).toBe('reader');
    expect(collectionFor('system')).toBe('reader');
    expect(collectionFor('high')).toBe('writer');
    // An unclassified tool must not land in the reader collection by accident…
    // it lands there, but the post-filter still drops it for lacking a tag.
    expect(collectionFor(undefined)).toBe('reader');
  });

  it('writes each tool into the collection its exposition belongs to', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');

    await w.upsertRaw('tool:GetTable', 'text', { exposition: 'readonly' });
    await w.upsertRaw('tool:CreateDomain', 'text', { exposition: 'high' });

    expect(reader.rows.map((r) => r.metadata.id)).toEqual(['tool:GetTable']);
    expect(writer.rows.map((r) => r.metadata.id)).toEqual([
      'tool:CreateDomain',
    ]);
  });

  it('a reader-level query never reaches the writer collection', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:GetTable', 't', { exposition: 'readonly' });
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });

    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'search', 'system'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);

    expect(ids).toContain('tool:GetTable');
    expect(ids).not.toContain('tool:CreateDomain');
    // The point of the split: the writer collection was never QUERIED.
    expect(writer.stats.queries).toBe(0);
    expect(reader.stats.queries).toBe(1);
    // Guard against a vacuous pass — the writer store really did hold the tool.
    expect(writer.rows.map((r) => r.metadata.id)).toEqual([
      'tool:CreateDomain',
    ]);
  });

  it('a developer-level query searches both', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:GetTable', 't', { exposition: 'readonly' });
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });

    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'search', 'system', 'high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('tool:GetTable');
    expect(ids).toContain('tool:CreateDomain');
    expect(writer.stats.queries).toBe(1);
  });

  it('gives each collection its own k: writer hits never crowd out reader tools', async () => {
    // Each collection is added to the context separately. A write tool that
    // outscores every read tool (the \$TMP case: Delete* descriptions mention
    // \$TMP) must not take the read tools' places.
    const reader = fakeStore();
    const writer = fakeStore();
    for (const id of ['GetPackageContents', 'GetPackageTree', 'GetClass']) {
      reader.rows.push({
        score: 0.4,
        metadata: { id: `tool:${id}`, exposition: 'readonly' },
      });
    }
    for (const id of ['DeleteClass', 'DeleteTable', 'DeleteDomain']) {
      writer.rows.push({
        score: 0.9,
        metadata: { id: `tool:${id}`, exposition: 'high' },
      });
    }
    const rag = new ExpositionFilteringRag(
      reader,
      writer,
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      2,
      2,
    );

    const res = await rag.query({} as never, 2, {
      ragFilter: { exposition: ['readonly', 'search', 'system', 'high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids.slice(0, 4)).toEqual([
      'tool:DeleteClass',
      'tool:DeleteTable',
      'tool:GetPackageContents',
      'tool:GetPackageTree',
    ]);
    expect(ids).toContain('tool:ActivateClass');
    expect(ids).not.toContain('tool:DeleteDomain');
  });

  it('with no role at all, only the reader collection is searched', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:GetTable', 't', { exposition: 'readonly' });
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });

    const res = await rag.query({} as never, 10, {});
    if (!res.ok) throw new Error('query failed');
    expect(res.value.map((r) => r.metadata.id)).not.toContain(
      'tool:CreateDomain',
    );
    expect(writer.stats.queries).toBe(0);
  });

  // Measured on prod: the pipeline runs tool selection twice, and the second
  // run — the one whose result reaches the model — rebuilds its own options and
  // arrives with no ragFilter. Falling back to Reader there hid every write tool
  // from every role, so a caller holding MCP_Developer was told no tool creates a
  // domain. The request store carries the same value the execution check
  // enforces on, so it answers when the options do not.
  it('falls back to the request store when the options lose the filter', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:GetTable', 't', { exposition: 'readonly' });
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });

    const res = await runWithRequestConnection(
      {} as never,
      // No ragFilter at all — exactly what the second selection passes.
      () => rag.query({} as never, 10, {}),
      undefined,
      ['readonly', 'search', 'system', 'high'],
    );
    if (!res.ok) throw new Error('query failed');
    expect(writer.stats.queries).toBe(1);
    expect(res.value.map((r) => r.metadata.id)).toContain('tool:CreateDomain');
  });

  it('still denies when neither the options nor the request store carry a role', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });

    const res = await runWithRequestConnection(
      {} as never,
      () => rag.query({} as never, 10, {}),
      undefined,
      undefined,
    );
    if (!res.ok) throw new Error('query failed');
    expect(writer.stats.queries).toBe(0);
    expect(res.value.map((r) => r.metadata.id)).not.toContain(
      'tool:CreateDomain',
    );
  });

  // The RUNTIME vectorization path — taken whenever the embedding bundle is
  // unusable, and always in in-memory mode. Routing only writer().upsertRaw()
  // would leave this one writing everything into the reader collection.
  it('routes upsert() — the runtime vectorization path — as well', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);

    await rag.upsert('text', { id: 'tool:GetTable', exposition: 'readonly' });
    await rag.upsert('text', { id: 'tool:CreateDomain', exposition: 'high' });

    expect(reader.rows.map((r) => r.metadata.id)).toEqual(['tool:GetTable']);
    expect(writer.rows.map((r) => r.metadata.id)).toEqual([
      'tool:CreateDomain',
    ]);
  });

  it('reports a delete as true no matter which collection held the id', async () => {
    const reader = fakeStore();
    const writer = fakeStore();
    const rag = new ExpositionFilteringRag(reader as never, writer as never);
    await rag.upsert('t', { id: 'tool:GetTable', exposition: 'readonly' });
    await rag.upsert('t', { id: 'tool:CreateDomain', exposition: 'high' });

    // The OTHER store legitimately answers false — that must not become the
    // reported result, in either direction.
    const w = await rag.deleteById('tool:CreateDomain');
    if (!w.ok) throw new Error('delete failed');
    expect(w.value).toBe(true);
    expect(writer.rows).toEqual([]);

    const r = await rag.deleteById('tool:GetTable');
    if (!r.ok) throw new Error('delete failed');
    expect(r.value).toBe(true);
    expect(reader.rows).toEqual([]);

    // And an id in neither is honestly false.
    const none = await rag.deleteById('tool:Missing');
    if (!none.ok) throw new Error('delete failed');
    expect(none.value).toBe(false);
  });

  it('still works as a single store when no writer collection is given', async () => {
    // In-memory mode and the existing tests construct it with one backend.
    const only = fakeStore();
    const rag = new ExpositionFilteringRag(only as never);
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:CreateDomain', 't', { exposition: 'high' });
    expect(only.rows.map((r) => r.metadata.id)).toEqual(['tool:CreateDomain']);
  });
});
