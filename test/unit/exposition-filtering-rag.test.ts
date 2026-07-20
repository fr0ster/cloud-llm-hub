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
    { score: 0.75, metadata: { id: 'skill:creating-domain' } }, // write skill → high
    { score: 0.7, metadata: { id: 'skill:some-consumer-skill' } }, // untagged skill
  ];

  it('keeps an UNtagged skill regardless of role (instructions default)', async () => {
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'search'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('skill:some-consumer-skill');
  });

  it('drops a WRITE skill for a role lacking its exposition', async () => {
    // read-only caller: no 'high' → the creating-domain skill must NOT reach the
    // executor (else it narrates a create it cannot perform — the hallucination).
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'search', 'system'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).not.toContain('skill:creating-domain');
    expect(ids).not.toContain('tool:CreateDomain'); // its tool is gated too
  });

  it('keeps a WRITE skill for a role that has its exposition', async () => {
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'search', 'system', 'high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('skill:creating-domain');
    expect(ids).toContain('tool:CreateDomain');
  });

  it('still drops an untagged TOOL when a role filter is active', async () => {
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
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {});
    if (!res.ok) throw new Error('query failed');
    expect(res.value).toHaveLength(4);
  });
});

describe('ExpositionFilteringRag — skill K cap (LLM_AGENT_SKILL_RAG_K, default 3)', () => {
  // 2 tools + 5 skills, score-descending. The inner double ignores k and returns
  // these verbatim, so the cap logic is what's under test.
  const many: Row[] = [
    { score: 0.99, metadata: { id: 'tool:A', exposition: 'high' } },
    { score: 0.98, metadata: { id: 'skill:s1' } },
    { score: 0.97, metadata: { id: 'skill:s2' } },
    { score: 0.96, metadata: { id: 'skill:s3' } },
    { score: 0.95, metadata: { id: 'skill:s4' } },
    { score: 0.94, metadata: { id: 'skill:s5' } },
    { score: 0.93, metadata: { id: 'tool:B', exposition: 'high' } },
  ];
  const count = (ids: unknown[], pfx: string) =>
    ids.filter((i) => typeof i === 'string' && i.startsWith(pfx)).length;

  it('caps skills at 3 while tools keep their full budget (role filter active)', async () => {
    const rag = new ExpositionFilteringRag(innerWith(many) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(count(ids, 'skill:')).toBe(3); // 5 offered → capped to 3
    expect(count(ids, 'tool:')).toBe(2); // both tools survive
    expect(ids).toContain('skill:s1'); // top-scored skills kept
    expect(ids).not.toContain('skill:s5'); // lowest dropped
  });

  it('caps skills even when no role filter is active', async () => {
    const rag = new ExpositionFilteringRag(innerWith(many) as any);
    const res = await rag.query({} as never, 10, {});
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(count(ids, 'skill:')).toBe(3);
    expect(count(ids, 'tool:')).toBe(2);
  });

  it('recovers a tool ranked below k*3 when many skills outrank it', async () => {
    // 18 skills all outrank a single tool. With k=5 a fixed k*3=15 over-fetch would
    // stop before the tool and starve it; the over-fetch adds the known skill count,
    // so the tool is still reached. An inner double that RESPECTS the requested K.
    const rows: Row[] = [
      ...Array.from({ length: 18 }, (_v, i) => ({
        score: 0.99 - i * 0.001,
        metadata: { id: `skill:s${i}` },
      })),
      { score: 0.5, metadata: { id: 'tool:Late', exposition: 'high' } },
    ];
    const kRespectingInner = {
      query: async (_e: unknown, reqK: number) => ({
        ok: true as const,
        value: rows.slice(0, reqK),
      }),
      writer: () => ({
        upsertRaw: async () => ({ ok: true as const, value: undefined }),
        deleteByIdRaw: async () => ({ ok: true as const, value: true }),
      }),
    };
    const rag = new ExpositionFilteringRag(kRespectingInner as any);
    // Populate the store's known-skill-count via the writer (as the builder does).
    const w = rag.writer();
    if (!w) throw new Error('no writer');
    for (let i = 0; i < 18; i++) await w.upsertRaw(`skill:s${i}`, 't', {});

    const res = await rag.query({} as never, 5, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('tool:Late'); // recovered despite ranking below k*3
    expect(count(ids, 'skill:')).toBe(3); // still capped
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
    const store = new ExpositionFilteringRag(rag as any);
    const w = store.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('tool:CreateDomain', 'x', {});
    await w.upsertRaw('tool:CreateDomain', 'x', {});
    expect(upserts).toEqual(['tool:CreateDomain', 'tool:CreateDomain']);
  });

  it('re-vectorizes a skill after it is deleted (edited-skill path)', async () => {
    const { upserts, rag } = recordingInner();
    const store = new ExpositionFilteringRag(rag as any);
    const w = store.writer();
    if (!w) throw new Error('no writer');
    await w.upsertRaw('skill:s', 'v1', {});
    await w.deleteByIdRaw('skill:s');
    await w.upsertRaw('skill:s', 'v2', {});
    expect(upserts).toEqual(['skill:s', 'skill:s']);
  });
});
