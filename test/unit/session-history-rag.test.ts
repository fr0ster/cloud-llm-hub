import { type RagResult, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { createHubRagAccess, initHubRagAccess } from '../../srv/lib/rag-access';
import {
  historyTestProvider,
  SessionHistoryFixture as SessionHistoryRag,
} from './helpers/session-history-fixture';

beforeEach(() => initHubRagAccess(createHubRagAccess(null, 'in-memory')));

import { objectNames, renderTurn, turnOwner } from '../../srv/lib/history-turn';

type Row = RagResult;

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
        metadata: RagResult['metadata'],
      ) => {
        written.push({ score: 1, text, metadata: { id, ...metadata } });
        return { ok: true as const, value: undefined };
      },
      deleteByIdRaw: async (id: string) => {
        const at = written.findIndex((row) => row.metadata.id === id);
        if (at !== -1) written.splice(at, 1);
        return { ok: true as const, value: at !== -1 };
      },
      clearAll: async () => {
        written.length = 0;
        return { ok: true as const, value: undefined };
      },
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

// The router selects a session collection and verifies the returned record ownership.
describe('recall is scoped to the conversation asking', () => {
  const rows: Row[] = [
    {
      score: 0.9,
      text: 'alice turn',
      metadata: { id: 'a', ownerScope: 'session', sessionId: 's-1' },
    },
    {
      score: 0.8,
      text: 'bob turn',
      metadata: { id: 'b', ownerScope: 'session', sessionId: 's-2' },
    },
  ];

  it('returns only the asking conversation’s turns', async () => {
    const rag = new SessionHistoryRag(
      historyTestProvider(fakeInner(rows)),
      () => ALICE,
    );
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    if (!res.ok) throw new Error('query failed');
    expect(res.value.map((r) => r.text)).toEqual(['alice turn']);
  });

  it('returns nothing when there is no conversation to recall for', async () => {
    const rag = new SessionHistoryRag(
      historyTestProvider(fakeInner(rows)),
      () => undefined,
    );
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    if (!res.ok) throw new Error('query failed');
    expect(res.value).toEqual([]);
  });

  it('scopes getById the same way', async () => {
    const rag = new SessionHistoryRag(
      historyTestProvider(fakeInner(rows)),
      () => ALICE,
    );
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
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
    const rag = new SessionHistoryRag(
      historyTestProvider(inner),
      () => ALICE,
      3,
    );
    for (let i = 0; i < 5; i++) {
      await rag.recordTurn({
        owner: ALICE,
        userText: `q${i}`,
        assistantText: `a${i}`,
        id: `turn:${i}`,
      });
    }
    expect(await rag.turnCount(ALICE)).toBe(3);
    expect(inner.written).toHaveLength(3);
  });

  it('forgets a whole conversation when its session is cleared', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(historyTestProvider(inner), () => ALICE);
    await rag.recordTurn({
      owner: ALICE,
      userText: 'q',
      assistantText: 'a',
      id: 'turn:x',
    });
    expect(await rag.turnCount(ALICE)).toBe(1);

    await rag.forgetOwner(ALICE);
    expect(await rag.turnCount(ALICE)).toBe(0);
  });

  it('counts each conversation separately', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(historyTestProvider(inner), () => ALICE);
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    await rag.recordTurn({ owner: BOB, userText: 'q', assistantText: 'a' });
    await rag.forgetOwner(ALICE);
    expect(await rag.turnCount(ALICE)).toBe(0);
    expect(await rag.turnCount(BOB)).toBe(1);
  });
});

describe('recording a turn', () => {
  it('stores it under its owner', async () => {
    const inner = fakeInner();
    const rag = new SessionHistoryRag(historyTestProvider(inner), () => ALICE);
    const ok = await rag.recordTurn({
      owner: ALICE,
      userText: 'make a domain',
      assistantText: 'created ZDEMO_TEST_9',
      id: 'turn:1',
    });
    expect(ok).toBe(true);
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0].metadata).toMatchObject({
      id: 'turn:1',
      ownerScope: 'session',
      sessionId: 's-1',
      authorUserId: 'alice@example.com',
    });
    expect(inner.written[0].metadata).not.toHaveProperty('owner');
    expect(inner.written[0].metadata).not.toHaveProperty('userId');
    expect(typeof inner.written[0].metadata.createdAt).toBe('string');
    expect(inner.written[0].text).toContain('ZDEMO_TEST_9');
  });

  it('reports failure instead of throwing — the answer is already sent', async () => {
    const noWriter = {
      query: async () => ({ ok: true as const, value: [] }),
      getById: async () => ({ ok: true as const, value: null }),
      healthCheck: async () => ({ ok: true as const, value: undefined }),
    };
    const rag = new SessionHistoryRag(
      historyTestProvider(noWriter),
      () => ALICE,
    );
    await expect(
      rag.recordTurn({ owner: ALICE, userText: 'a', assistantText: 'b' }),
    ).resolves.toBe(false);
  });
});

describe('listTurns', () => {
  it('is empty for a store that cannot enumerate its turns', async () => {
    const rag = new SessionHistoryRag(
      historyTestProvider(fakeInner()),
      () => ALICE,
    );
    await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
    await expect(rag.listTurns(ALICE)).resolves.toEqual([]);
  });
});

it('close waits for a late turn write before deleting its owner', async () => {
  const inner = fakeInner();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = inner.writer();
  const upsert = writer.upsertRaw;
  writer.upsertRaw = async (...args) => {
    await wait;
    return upsert(...args);
  };
  inner.writer = () => writer;
  const backend = {
    ...inner,
    deleteWhere: async () => {
      inner.written.length = 0;
      return { ok: true as const, value: 0 };
    },
  };
  const rag = new SessionHistoryRag(historyTestProvider(backend), () => ALICE);
  const writing = rag.recordTurn({
    owner: ALICE,
    userText: 'hi',
    assistantText: 'hello',
  });
  const closing = rag.forgetOwner(ALICE);
  release();
  await Promise.all([writing, closing]);
  expect(inner.written).toHaveLength(0);
});

it('forget reports a failed collection delete without throwing', async () => {
  const provider = historyTestProvider(fakeInner());
  const rag = new SessionHistoryRag(provider, () => ALICE);
  await rag.recordTurn({ owner: ALICE, userText: 'q', assistantText: 'a' });
  jest.spyOn(provider, 'deleteCollection').mockRejectedValue(new Error('down'));
  expect(await rag.forgetOwner(ALICE)).toBe(false);
});
