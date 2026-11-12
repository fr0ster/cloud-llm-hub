import { createHash } from 'node:crypto';
import {
  type ILlm,
  InMemoryRagProvider,
  type RagCaller,
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
    assistantText: 'answer',
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
