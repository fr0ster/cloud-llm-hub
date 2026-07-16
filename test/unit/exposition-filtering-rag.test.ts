import { ExpositionFilteringRag } from '../../srv/agent-manager';

type Row = { score: number; metadata: Record<string, unknown> };

function innerWith(rows: Row[]) {
  return {
    query: async () => ({ ok: true as const, value: rows }),
    writer: () => undefined,
  };
}

describe('ExpositionFilteringRag exposition filter', () => {
  const rows: Row[] = [
    { score: 0.9, metadata: { id: 'tool:CreateDomain', exposition: 'high' } },
    { score: 0.8, metadata: { id: 'tool:HandlerLowLevel' } }, // untagged tool
    { score: 0.7, metadata: { id: 'skill:creating-draft-table' } }, // untagged skill
  ];

  it('keeps skill:* even though they carry no exposition', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('skill:creating-draft-table');
  });

  it('still drops an untagged TOOL when a role filter is active', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).not.toContain('tool:HandlerLowLevel');
    expect(ids).toContain('tool:CreateDomain');
  });

  it('returns everything when no role filter is active', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {});
    if (!res.ok) throw new Error('query failed');
    expect(res.value).toHaveLength(3);
  });
});

describe('ExpositionFilteringRag writer — skill re-vectorization dedup', () => {
  function recordingInner() {
    const upserts: string[] = [];
    const backend = {
      upsertRaw: async (id: string) => {
        upserts.push(id);
        return { ok: true as const, value: undefined };
      },
      deleteByIdRaw: async () => ({ ok: true as const, value: true }),
    };
    return {
      upserts,
      rag: {
        query: async () => ({ ok: true as const, value: [] }),
        writer: () => backend,
      },
    };
  }

  it('embeds a skill id once and skips the re-upsert (per shared store)', async () => {
    const { upserts, rag } = recordingInner();
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const store = new ExpositionFilteringRag(rag as any);
    const w = store.writer();
    if (!w) throw new Error('no writer');
    // Simulate build() upserting the same skill on two destination builds.
    await w.upsertRaw('skill:creating-draft-table', 'Skill: …', {});
    await w.upsertRaw('skill:creating-draft-table', 'Skill: …', {});
    expect(upserts).toEqual(['skill:creating-draft-table']); // second is a no-op
  });

  it('does NOT dedup non-skill (tool) upserts', async () => {
    const { upserts, rag } = recordingInner();
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const store = new ExpositionFilteringRag(rag as any);
    const w = store.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:CreateDomain', 'x', {});
    await w.upsertRaw('tool:CreateDomain', 'x', {});
    expect(upserts).toEqual(['tool:CreateDomain', 'tool:CreateDomain']);
  });

  it('re-vectorizes a skill after it is deleted (edited-skill path)', async () => {
    const { upserts, rag } = recordingInner();
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const store = new ExpositionFilteringRag(rag as any);
    const w = store.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('skill:s', 'v1', {});
    await w.deleteByIdRaw('skill:s');
    await w.upsertRaw('skill:s', 'v2', {});
    expect(upserts).toEqual(['skill:s', 'skill:s']);
  });
});
