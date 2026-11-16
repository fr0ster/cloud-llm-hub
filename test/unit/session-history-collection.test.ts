import { createHash } from 'node:crypto';
import {
  type ILlm,
  InMemoryRagProvider,
  type RagCaller,
  RagError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  SmartAgentBuilder,
  unwrapBuilderResult,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  createHubRagAccess,
  getHubRagAccess,
  initHubRagAccess,
} from '../../srv/lib/rag-access';
import { callOptionsFor } from '../../srv/lib/rag-caller';
import {
  forgetSessionHistory,
  historyCollectionName,
  initSessionHistoryRouter,
  SessionHistoryRouter,
} from '../../srv/lib/session-history-collection';
import { assertToolSearchHealthy } from '../../srv/lib/tool-search-health';

const a: RagCaller = { userId: 'u1', sessionId: 's1', isAdmin: false };
const b: RagCaller = { ...a, sessionId: 's2' };
let provider: InMemoryRagProvider;
let router: SessionHistoryRouter;
beforeEach(async () => {
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  for (const caller of [a, b]) {
    const bound = await getHubRagAccess().access.bindings.bind(
      caller.sessionId,
      caller.userId,
    );
    if (!bound.ok) throw bound.error;
  }
  provider = new InMemoryRagProvider({ name: 'session-history' });
  router = new SessionHistoryRouter(provider);
  initSessionHistoryRouter(router);
});

test('historyCollectionName is the specified sha256 name', () => {
  expect(historyCollectionName('s1')).toBe(
    `h_hist_${createHash('sha256').update('s1').digest('hex').slice(0, 32)}`,
  );
  expect(historyCollectionName('s1')).not.toBe(historyCollectionName('s2'));
  expect(() => historyCollectionName('')).toThrow();
});

test("history recall returns only the session's own turns", async () => {
  for (const caller of [a, b])
    expect(
      await router.recordTurn({
        caller,
        userText: 'earlier',
        assistantText: caller.sessionId,
      }),
    ).toBe(true);
  const recalled = await router.query(
    new TextOnlyEmbedding('earlier'),
    10,
    callOptionsFor(a),
  );
  if (!recalled.ok) throw recalled.error;
  expect(recalled.value).toHaveLength(1);
  expect(recalled.value[0].text).toContain('Assistant: s1');
  expect(recalled.value[0].metadata).toMatchObject({
    ownerScope: 'session',
    sessionId: 's1',
    authorUserId: 'u1',
  });
  expect(recalled.value[0].metadata).not.toHaveProperty('owner');
  expect(recalled.value[0].metadata).not.toHaveProperty('userId');
  expect(await router.getById('absent', callOptionsFor(a))).toEqual({
    ok: true,
    value: null,
  });
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  expect(
    catalog.value.records.map((record) => ({
      name: record.name,
      scope: record.scope,
      sessionId: record.scope === 'session' ? record.sessionId : undefined,
    })),
  ).toEqual([
    { name: historyCollectionName('s1'), scope: 'session', sessionId: 's1' },
    { name: historyCollectionName('s2'), scope: 'session', sessionId: 's2' },
  ]);
});

test('no session, no history', async () => {
  await router.writer().upsertRaw('unscoped', 'secret', { sessionId: 's1' });
  await router.upsert(
    'secret',
    {},
    { sessionId: 's1', ragFilter: { caller: a } },
  );
  expect(await router.query(new TextOnlyEmbedding('secret'), 10)).toEqual({
    ok: true,
    value: [],
  });
  expect(await router.getById('unscoped')).toEqual({ ok: true, value: null });
  expect(await provider.describeCollections()).toEqual({
    ok: true,
    value: { records: [], rejected: [] },
  });
});

test('an unbound or conflicting caller cannot create history', async () => {
  for (const options of [
    { caller: { ...a, userId: 'intruder' } },
    { ...callOptionsFor(a), sessionId: 's2' },
    {
      ...callOptionsFor(a),
      ragFilter: { owner: { scope: 'session' as const, sessionId: 's2' } },
    },
  ])
    await router.writer().upsertRaw('refused', 'secret', {}, options);
  expect(await provider.describeCollections()).toEqual({
    ok: true,
    value: { records: [], rejected: [] },
  });
});

test('reading an unused session does not create a collection', async () => {
  expect(
    await router.query(new TextOnlyEmbedding('earlier'), 10, callOptionsFor(a)),
  ).toEqual({ ok: true, value: [] });
  expect(await provider.describeCollections()).toEqual({
    ok: true,
    value: { records: [], rejected: [] },
  });
});

test('forgetSessionHistory removes the collection', async () => {
  for (const caller of [a, b])
    await router.recordTurn({ caller, userText: 'q', assistantText: 'a' });
  await forgetSessionHistory('s1');
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  expect(catalog.value.records.map((record) => record.name)).toEqual([
    historyCollectionName('s2'),
  ]);
  expect(await router.listTurns(a)).toEqual([]);
  expect(await router.listTurns(b)).toHaveLength(1);
  await forgetSessionHistory('s1');
});

test('session deletion waits for a write already waiting on binding or storage', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = provider.createCollection.bind(provider);
  jest
    .spyOn(provider, 'createCollection')
    .mockImplementation(async (name, options) => {
      const result = await create(name, options);
      if (result.ok) {
        const writer = result.value.rag.writer?.();
        if (!writer) throw new Error('Missing writer');
        const upsert = writer.upsertRaw.bind(writer);
        writer.upsertRaw = async (...args) => {
          await gate;
          return upsert(...args);
        };
        result.value.rag.writer = () => writer;
      }
      return result;
    });
  const writing = router.recordTurn({
    caller: a,
    userText: 'late',
    assistantText: 'answer'.repeat(3000),
  });
  const forgetting = router.forgetSessionHistory(a.sessionId);
  release();
  expect(await writing).toBe(true);
  await forgetting;
  expect(await provider.describeCollections()).toEqual({
    ok: true,
    value: { records: [], rejected: [] },
  });
});

test('the real builder forwards the trusted caller to history query and upsert', async () => {
  const llm: ILlm = {
    chat: async () => ({
      ok: true,
      value: { content: 'Earlier session fact', finishReason: 'stop' },
    }),
    async *streamChat(messages, tools, options) {
      yield await this.chat(messages, tools, options);
    },
  };
  const query = jest.spyOn(router, 'query');
  const writer = router.writer();
  const upsert = jest.spyOn(writer, 'upsertRaw');
  jest.spyOn(router, 'writer').mockReturnValue(writer);
  const agent = unwrapBuilderResult(
    await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: {
        classificationEnabled: false,
        ragTranslateEnabled: false,
        semanticHistoryEnabled: true,
      },
    })
      .withMainLlm(llm)
      .withHelperLlm(llm)
      .withRagAccess(getHubRagAccess().access)
      .setHistoryRag(router)
      .withHistorySummarization(1)
      .build(),
  );
  const response = await agent.agent.process(
    'remember this',
    callOptionsFor(a),
  );
  if (!response.ok) throw response.error;
  expect(query).toHaveBeenCalled();
  expect(query.mock.calls[0][2]).toMatchObject({
    caller: a,
    sessionId: 's1',
    ragFilter: {
      owner: { scope: 'session', sessionId: 's1' },
      sessionId: 's1',
    },
  });
  expect(upsert).toHaveBeenCalled();
  expect(upsert.mock.calls[0][3]).toMatchObject({ caller: a, sessionId: 's1' });
  expect(await router.listTurns(a)).toHaveLength(0); // Library summaries use their own text format.
  const recalled = await router.query(
    new TextOnlyEmbedding('remember'),
    10,
    callOptionsFor(a),
  );
  expect(recalled.ok && recalled.value.length).toBe(1);
});

test('chunked turns preserve all Unicode text, order and session isolation', async () => {
  const userText = `question\nAssistant: quoted ${'\u043f\u0438\u0442\u0430\u043d\u043d\u044f\u{1f642}'.repeat(1600)}`;
  const assistantText = `${'answer\u{1f642}'.repeat(2200)}\nObjects: original text`;
  expect(
    await router.recordTurn({ caller: a, userText, assistantText, id: 'long' }),
  ).toBe(true);
  const result = await router.query(
    new TextOnlyEmbedding('question'),
    100,
    callOptionsFor(a),
  );
  if (!result.ok) throw result.error;
  expect(result.value).toHaveLength(1);
  expect(result.value[0].text).toBe(
    `User: ${userText}\nAssistant: ${assistantText}`,
  );
  expect(await router.listTurns(a)).toEqual([
    expect.objectContaining({ id: 'long', userText, assistantText }),
  ]);
  expect(
    await router.query(
      new TextOnlyEmbedding('question'),
      100,
      callOptionsFor(b),
    ),
  ).toEqual({ ok: true, value: [] });
  await router.forgetSessionHistory(a.sessionId);
  expect(await router.listTurns(a)).toEqual([]);
});

test('default retention keeps the whole dialogue beyond 200 turns', async () => {
  for (let i = 0; i < 205; i++)
    await router.recordTurn({
      caller: a,
      userText: `q${i}`,
      assistantText: `a${i}`,
    });
  expect(await router.listTurns(a)).toHaveLength(205);
});

test('unlimited writes avoid scans and account for UTF-8 upserts and deletion', async () => {
  const storage = await import('../../srv/lib/usage/storage-values');
  const enabled = jest.spyOn(storage, 'storageEnabled').mockReturnValue(true);
  try {
    await router.upsert('seed', { id: 'seed' }, { caller: a });
    const opened = await provider.openCollection({
      name: historyCollectionName(a.sessionId),
      storeName: historyCollectionName(a.sessionId),
      scope: 'session',
      sessionId: a.sessionId,
    });
    if (!opened.ok) throw opened.error;
    const { isRagScanner } = await import('@mcp-abap-adt/llm-agent');
    if (!isRagScanner(opened.value.rag)) throw new Error('Scanner required');
    const scan = jest.spyOn(opened.value.rag, 'scan');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        router.upsert('payload', { id: `row:${i}` }, { caller: a }),
      ),
    );
    await router.upsert('replacement\u{1f642}', { id: 'seed' }, { caller: a });
    expect(router.storageBytes(a.sessionId)).toBe(30 * 7 + 15);
    await router.deleteById('seed', { caller: a });
    expect(router.storageBytes(a.sessionId)).toBe(30 * 7);
    expect(scan).not.toHaveBeenCalled();
    await router.forgetSessionHistory(a.sessionId);
    expect(router.storageBytes(a.sessionId)).toBe(0);
  } finally {
    enabled.mockRestore();
  }
});

test('query waits for a pending turn write in its own session', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = provider.createCollection.bind(provider);
  jest
    .spyOn(provider, 'createCollection')
    .mockImplementation(async (...args) => {
      await gate;
      return create(...args);
    });
  const writing = router.recordTurn({
    caller: a,
    userText: 'pending',
    assistantText: 'complete',
  });
  const reading = router.query(
    new TextOnlyEmbedding('pending'),
    2,
    callOptionsFor(a),
  );
  expect(
    await router.query(new TextOnlyEmbedding('pending'), 2, callOptionsFor(b)),
  ).toEqual({ ok: true, value: [] });
  release();
  expect(await writing).toBe(true);
  const result = await reading;
  expect(result.ok && result.value[0].text).toBe(
    'User: pending\nAssistant: complete',
  );
});

test('k counts full turns instead of chunks', async () => {
  const answer = 'recall '.repeat(9000);
  await router.recordTurn({
    caller: a,
    id: 'long',
    userText: 'recall',
    assistantText: answer,
  });
  await router.recordTurn({
    caller: a,
    id: 'short',
    userText: 'recall',
    assistantText: 'short',
  });
  for (const id of ['short-two', 'short-three'])
    await router.recordTurn({
      caller: a,
      id,
      userText: 'recall',
      assistantText: 'brief answer',
    });
  await router.recordTurn({
    caller: b,
    id: 'foreign',
    userText: 'recall',
    assistantText: 'foreign secret',
  });
  const result = await router.query(
    new TextOnlyEmbedding('recall'),
    2,
    callOptionsFor(a),
  );
  if (!result.ok) throw result.error;
  expect(result.value).toHaveLength(2);
  expect(JSON.stringify(result.value)).not.toContain('foreign secret');
  expect(result.value.find((row) => row.metadata.turnId === 'long')?.text).toBe(
    `User: recall\nAssistant: ${answer}`,
  );
});

test('failed history writes warn with identifiers and error class only', async () => {
  const warn = jest.fn();
  router = new SessionHistoryRouter(provider, { log: { warn } });
  const create = jest.spyOn(provider, 'createCollection').mockResolvedValue({
    ok: false,
    error: new RagError('private user and assistant text'),
  });
  await expect(
    router.recordTurn({
      caller: a,
      id: 'failed-turn',
      userText: 'private user',
      assistantText: 'private assistant',
    }),
  ).resolves.toBe(false);
  expect(warn).toHaveBeenCalledWith('Session history write failed', {
    sessionHash: historyCollectionName(a.sessionId),
    turnId: 'failed-turn',
    error: 'RagError',
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  create.mockRestore();
  await assertToolSearchHealthy();
  expect(await router.listTurns(a)).toContainEqual(
    expect.objectContaining({ id: 'failed-turn' }),
  );
});

test('turn ranking uses the best chunk score and warns for missing chunks', async () => {
  const warn = jest.fn();
  router = new SessionHistoryRouter(provider, { log: { warn } });
  await router.recordTurn({
    caller: a,
    id: 'long',
    userText: 'rank',
    assistantText: 'rank '.repeat(9000),
  });
  await router.recordTurn({
    caller: a,
    id: 'short',
    userText: 'rank',
    assistantText: 'short',
  });
  const catalog = await provider.describeCollections();
  if (!catalog.ok) throw catalog.error;
  const opened = await provider.openCollection(catalog.value.records[0]);
  if (!opened.ok) throw opened.error;
  const hits = await opened.value.rag.query(
    new TextOnlyEmbedding('rank'),
    100,
    callOptionsFor(a),
  );
  if (!hits.ok) throw hits.error;
  const ranked = hits.value
    .map((row) => ({
      ...row,
      score:
        row.metadata.turnId === 'short'
          ? 0.8
          : row.metadata.chunkIndex === 3
            ? 0.9
            : 0.1,
    }))
    .sort((left, right) => right.score - left.score);
  jest
    .spyOn(opened.value.rag, 'query')
    .mockImplementation(async (_embedding, k) => ({
      ok: true,
      value: ranked.slice(0, k),
    }));
  const get = opened.value.rag.getById.bind(opened.value.rag);
  jest
    .spyOn(opened.value.rag, 'getById')
    .mockImplementation(async (id, options) =>
      id.endsWith('00000002') ? { ok: true, value: null } : get(id, options),
    );
  const result = await router.query(
    new TextOnlyEmbedding('rank'),
    2,
    callOptionsFor(a),
  );
  if (!result.ok) throw result.error;
  expect(result.value.map((row) => [row.metadata.turnId, row.score])).toEqual([
    ['long', 0.9],
    ['short', 0.8],
  ]);
  expect(warn).toHaveBeenCalledWith(
    'Session history chunks missing',
    expect.objectContaining({ turnId: 'long', error: 'IncompleteTurn' }),
  );
});

test('a backend write can re-enter history for its own session', async () => {
  await router.recordTurn({
    caller: a,
    userText: 'committed',
    assistantText: 'answer',
    id: 'first',
  });
  const opened = await provider.openCollection({
    name: historyCollectionName(a.sessionId),
    storeName: historyCollectionName(a.sessionId),
    scope: 'session',
    sessionId: a.sessionId,
  });
  if (!opened.ok) throw opened.error;
  const writer = opened.value.rag.writer?.();
  if (!writer) throw new Error('Missing writer');
  const original = writer.upsertRaw.bind(writer);
  const reentry = jest
    .spyOn(writer, 'upsertRaw')
    .mockImplementation(async (...args) => {
      const recalled = await router.query(
        new TextOnlyEmbedding('committed'),
        2,
        callOptionsFor(a),
      );
      expect(recalled.ok && recalled.value[0].text).toContain('committed');
      return original(...args);
    });
  jest.spyOn(opened.value.rag, 'writer').mockReturnValue(writer);
  expect(
    await router.recordTurn({
      caller: a,
      userText: 'next',
      assistantText: 'answer',
    }),
  ).toBe(true);
  expect(reentry).toHaveBeenCalled();
});

test('the router embeds text-only vector queries once with scoped options', async () => {
  const embedQuery = jest.fn(async () => ({ vector: [1, 2] }));
  router = new SessionHistoryRouter(provider, {
    queryEmbedder: { embedQuery },
  });
  await router.recordTurn({
    caller: a,
    userText: 'fact',
    assistantText: 'answer',
  });
  const opened = await provider.openCollection({
    name: historyCollectionName(a.sessionId),
    storeName: historyCollectionName(a.sessionId),
    scope: 'session',
    sessionId: a.sessionId,
  });
  if (!opened.ok) throw opened.error;
  const inner = opened.value.rag;
  const original = inner.query.bind(inner);
  jest
    .spyOn(inner, 'query')
    .mockImplementation(async (embedding, k, options) => {
      expect(await embedding.toVector()).toEqual([1, 2]);
      expect(await embedding.toVector()).toEqual([1, 2]);
      return original(embedding, k, options);
    });
  const result = await router.query(
    new TextOnlyEmbedding('fact'),
    2,
    callOptionsFor(a),
  );
  expect(result.ok && result.value[0].text).toContain('answer');
  expect(embedQuery).toHaveBeenCalledTimes(1);
  expect(embedQuery).toHaveBeenCalledWith(
    'fact',
    expect.objectContaining({ sessionId: a.sessionId }),
  );
});
