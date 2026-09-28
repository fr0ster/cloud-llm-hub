import {
  objectNames,
  renderTurn,
  SessionHistoryRag,
  turnOwner,
} from '../../srv/lib/session-history-rag';

type Row = { score: number; text: string; metadata: Record<string, unknown> };

function fakeInner(rows: Row[] = []) {
  const written: Row[] = [];
  return {
    written,
    query: async () => ({ ok: true as const, value: rows }),
    getById: async (id: string) => ({
      ok: true as const,
      value: rows.find((r) => r.metadata.id === id) ?? null,
    }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
    writer: () => ({
      upsertRaw: async (
        id: string,
        text: string,
        metadata: Record<string, unknown>,
      ) => {
        written.push({ score: 1, text, metadata: { id, ...metadata } });
        return { ok: true as const, value: undefined };
      },
      deleteByIdRaw: async () => ({ ok: true as const, value: true }),
    }),
  };
}

const ALICE = turnOwner('alice@example.com', 's-1');
const BOB = turnOwner('bob@example.com', 's-2');

describe('what a stored turn carries', () => {
  it('keeps the answer, not only the question', () => {
    // Storing the request alone would recall that a domain was asked for and
    // never what it was called — the one fact a later turn needs.
    const text = renderTurn(
      'зроби домен',
      'Створено ZDEMO_TEST_34345, CHAR 10',
    );
    expect(text).toContain('зроби домен');
    expect(text).toContain('ZDEMO_TEST_34345');
  });

  it('lifts object names out so a clip cannot lose them', () => {
    const long = `${'x'.repeat(4000)} created ZDEMO_LATE_NAME at the end`;
    const text = renderTurn('do it', long);
    expect(text).toContain('…');
    expect(text).toContain('Objects: ZDEMO_LATE_NAME');
  });

  it('picks out ABAP-shaped names and nothing else', () => {
    expect(
      objectNames('created ZDEMO_TEST_1 and ZCL_HANDLER, see the domain'),
    ).toEqual(['ZDEMO_TEST_1', 'ZCL_HANDLER']);
    expect(objectNames('no names here at all')).toEqual([]);
  });
});

// Upstream registers `history` with scope `global`, and the query handler adds a
// session filter only for scope `session`. Without the filter below one
// person's turns would surface in another's context.
describe('recall is scoped to the conversation asking', () => {
  const rows: Row[] = [
    { score: 0.9, text: 'alice turn', metadata: { id: 'a', owner: ALICE } },
    { score: 0.8, text: 'bob turn', metadata: { id: 'b', owner: BOB } },
  ];

  it('returns only the asking conversation’s turns', async () => {
    const rag = new SessionHistoryRag(fakeInner(rows) as never, () => ALICE);
    const res = await rag.query({} as never, 10);
    if (!res.ok) throw new Error('query failed');
    expect(res.value.map((r) => r.text)).toEqual(['alice turn']);
  });

  it('returns nothing when there is no conversation to recall for', async () => {
    const rag = new SessionHistoryRag(
      fakeInner(rows) as never,
      () => undefined,
    );
    const res = await rag.query({} as never, 10);
    if (!res.ok) throw new Error('query failed');
    expect(res.value).toEqual([]);
  });

  it('scopes getById the same way', async () => {
    const rag = new SessionHistoryRag(fakeInner(rows) as never, () => ALICE);
    const mine = await rag.getById('a');
    const theirs = await rag.getById('b');
    if (!mine.ok || !theirs.ok) throw new Error('getById failed');
    expect(mine.value?.text).toBe('alice turn');
    expect(theirs.value).toBeNull();
  });
});

describe('the store stays bounded', () => {
  it('forgets the oldest turns beyond the cap', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(inner as never, () => ALICE, 3);
    for (let i = 0; i < 5; i++) {
      await rag.recordTurn({
        owner: ALICE,
        userText: `q${i}`,
        assistantText: `a${i}`,
        id: `turn:${i}`,
      });
    }
    expect(rag.turnCount(ALICE)).toBe(3);
  });

  it('forgets a whole conversation when its session is cleared', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(inner as never, () => ALICE);
    await rag.recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
      id: 'turn:x',
    });
    expect(rag.turnCount(ALICE)).toBe(1);

    await rag.forgetOwner(ALICE);
    expect(rag.turnCount(ALICE)).toBe(0);
  });

  it('counts each conversation separately', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(inner as never, () => ALICE);
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    await rag.recordTurn({ owner: BOB, userText: 'q', assistantText: 'a' });
    await rag.forgetOwner(ALICE);
    expect(rag.turnCount(ALICE)).toBe(0);
    expect(rag.turnCount(BOB)).toBe(1);
  });
});

describe('recording a turn', () => {
  it('stores it under its owner', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(inner as never, () => ALICE);
    const ok = await rag.recordTurn({
      owner: ALICE,
      userText: 'make a domain',
      assistantText: 'created ZDEMO_TEST_9',
      id: 'turn:1',
    });
    expect(ok).toBe(true);
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0].metadata).toEqual({ id: 'turn:1', owner: ALICE });
    expect(inner.written[0].text).toContain('ZDEMO_TEST_9');
  });

  it('reports failure instead of throwing — the answer is already sent', async () => {
    const noWriter = {
      query: async () => ({ ok: true as const, value: [] }),
      getById: async () => ({ ok: true as const, value: null }),
      healthCheck: async () => ({ ok: true as const, value: undefined }),
    };
    const rag = new SessionHistoryRag(noWriter as never, () => ALICE);
    await expect(
      rag.recordTurn({ owner: ALICE, userText: 'a', assistantText: 'b' }),
    ).resolves.toBe(false);
  });
});
