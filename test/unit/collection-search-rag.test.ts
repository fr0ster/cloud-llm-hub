import { CollectionSearchRag } from '../../srv/rag-collections';

type Row = { text: string; score: number; metadata: Record<string, unknown> };

/** A store that, like the backends, keeps only records of a given namespace. */
function namespacedInner(rows: Row[]) {
  const seen: unknown[] = [];
  return {
    seen,
    store: {
      query: async (
        _e: unknown,
        _k: number,
        options?: { ragFilter?: { namespace?: string } },
      ) => {
        seen.push(options);
        const ns = options?.ragFilter?.namespace;
        return {
          ok: true as const,
          value: rows.filter(
            (r) => ns === undefined || r.metadata.namespace === ns,
          ),
        };
      },
      healthCheck: async () => ({ ok: true as const, value: undefined }),
      getById: async () => ({ ok: true as const, value: rows[0] }),
      writer: () => undefined,
    },
  };
}

describe('CollectionSearchRag — a user collection as the agent searches it', () => {
  const rows: Row[] = [
    {
      text: 'untagged user doc',
      score: 0.9,
      metadata: { id: 'd1', docId: 'd1' },
    },
    { text: 'second doc', score: 0.5, metadata: { id: 'd2', docId: 'd2' } },
  ];

  it('returns documents that carry no exposition tag', async () => {
    const { store } = namespacedInner(rows);
    const rag = new CollectionSearchRag(store as never);
    const res = await rag.query({} as never, 5, {
      ragFilter: { namespace: 'u1:DEST', exposition: ['readonly'] },
    } as never);
    if (!res.ok) throw new Error('query failed');
    expect(res.value.map((r: { text: string }) => r.text)).toEqual([
      'untagged user doc',
      'second doc',
    ]);
  });

  it('does not pass the agent ragFilter to the collection, keeps the signal', async () => {
    const { store, seen } = namespacedInner(rows);
    const rag = new CollectionSearchRag(store as never);
    const signal = new AbortController().signal;
    await rag.query({} as never, 5, {
      signal,
      ragFilter: { namespace: 'u1:DEST', exposition: ['readonly'] },
    } as never);
    expect(seen).toEqual([{ signal }]);
  });

  it('delegates getById, healthCheck and writer', async () => {
    const { store } = namespacedInner(rows);
    const rag = new CollectionSearchRag(store as never);
    expect((await rag.getById('d1')).ok).toBe(true);
    expect((await rag.healthCheck()).ok).toBe(true);
    expect(rag.writer()).toBeUndefined();
  });
});
