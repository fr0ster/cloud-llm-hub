import {
  InMemoryRag,
  type IRagBackendWriter,
  RagError,
  resetQuotaGates,
} from '@mcp-abap-adt/llm-agent';
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import { QdrantRag } from '@mcp-abap-adt/qdrant-rag';
import { buildEmbedding, prefetchEmbedder } from '../../srv/lib/providers';
import { getHubRagAccess } from '../../srv/lib/rag-access';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';
import { SessionHistoryRouter } from '../../srv/lib/session-history-collection';
import { sessionHistoryWrite } from '../../srv/lib/session-history-write-scope';
import {
  assertToolSearchHealthy,
  toolSearchFailure,
  withToolSearchHealth,
} from '../../srv/lib/tool-search-health';
import {
  qdrantCollectionInfo,
  qdrantMultivectorConfig,
} from './helpers/qdrant-fetch';
import { historyTestProvider } from './helpers/session-history-fixture';

const caller = { userId: 'writer', sessionId: 'write-session', isAdmin: false };
const turn = {
  caller,
  userText: 'question',
  assistantText: 'complete answer',
  id: 'stable-turn',
};

beforeEach(async () => {
  jest.spyOn(Math, 'random').mockReturnValue(0);
  await getHubRagAccess().access.bindings.bind(caller.sessionId, caller.userId);
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetQuotaGates();
  await assertToolSearchHealthy();
});

function fixture() {
  const rag = new InMemoryRag();
  const writer = rag.writer();
  const upsert = jest.fn<
    ReturnType<IRagBackendWriter['upsertRaw']>,
    Parameters<IRagBackendWriter['upsertRaw']>
  >(writer.upsertRaw.bind(writer));
  jest.spyOn(rag, 'writer').mockReturnValue({ ...writer, upsertRaw: upsert });
  const router = new SessionHistoryRouter(historyTestProvider(rag));
  return { router, upsert };
}

test('a store 429 honors Retry-After repeatedly, without marking the hub unhealthy', async () => {
  jest.useFakeTimers();
  const { router, upsert } = fixture();
  const error = Object.assign(new RagError('quota'), {
    status: 429,
    retryAfterSeconds: 2,
  });
  for (let index = 0; index < 8; index++)
    upsert.mockResolvedValueOnce({ ok: false, error });
  const stored = router.recordTurn(turn);
  await jest.advanceTimersByTimeAsync(15_999);
  expect(upsert).toHaveBeenCalledTimes(8);
  expect(toolSearchFailure()).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1);
  await expect(stored).resolves.toBe(true);
  expect(upsert).toHaveBeenCalledTimes(9);
  expect(new Set(upsert.mock.calls.map(([id]) => id))).toEqual(
    new Set(['stable-turn']),
  );
  expect(await router.listTurns(caller)).toHaveLength(1);
});

test('production embedding composition waits through 429 for document writes', async () => {
  jest.useFakeTimers();
  const embed = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockRejectedValueOnce(
      Object.assign(new Error('quota'), { status: 429, retryAfterSeconds: 3 }),
    )
    .mockResolvedValue({ vector: [1, 2] });
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: 'history-test',
  });
  if (!embedding) throw new Error('Missing embedding');
  const stored = sessionHistoryWrite.run(true, () =>
    embedding.retrieval.embedDocument('answer'),
  );
  await jest.advanceTimersByTimeAsync(2999);
  expect(embed).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(stored).resolves.toMatchObject({ vector: [1, 2] });
  expect(embed).toHaveBeenCalledTimes(2);
});

test('Qdrant retries a fragmented history record using its Retry-After', async () => {
  const config = {
    kind: 'openai',
    model: 'history-embedding',
    apiKey: 'test',
  } as const;
  await prefetchEmbedder(config);
  const batch = jest
    .spyOn(OpenAiEmbedder.prototype, 'embedBatch')
    .mockImplementation(async (texts) => texts.map(() => ({ vector: [1, 2] })));
  const embedding = buildEmbedding(config);
  if (!embedding) throw new Error('Missing embedding');

  jest.useFakeTimers();
  let refused = false;
  let firstRefusal = () => {};
  const throttled = new Promise<void>((resolve) => {
    firstRefusal = resolve;
  });
  const isWrite = (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'PUT' &&
    new URL(String(input)).pathname.endsWith('/points');
  const transport = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      if (isWrite(input, init) && !refused) {
        refused = true;
        firstRefusal();
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '5' },
        });
      }
      return qdrantCollectionInfo(qdrantMultivectorConfig(2));
    });
  const rag = new QdrantRag({
    url: 'http://history.test',
    collectionName: 'turns',
    embedder: embedding.retrieval,
  });
  const router = new SessionHistoryRouter(historyTestProvider(rag), {
    storeUrl: 'http://history.test',
    storageBackend: 'qdrant',
  });
  const assistantText = 'complete answer '.repeat(280);
  const stored = router.recordTurn({ ...turn, assistantText });
  await Promise.race([
    throttled,
    stored.then(() => {
      throw new Error('History write finished before reaching Qdrant upsert');
    }),
  ]);
  await jest.advanceTimersByTimeAsync(4999);
  expect(
    transport.mock.calls.filter(([input, init]) => isWrite(input, init)),
  ).toHaveLength(1);
  expect(toolSearchFailure()).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1);
  await expect(stored).resolves.toBe(true);
  const writes = transport.mock.calls.filter(([input, init]) =>
    isWrite(input, init),
  );
  expect(writes).toHaveLength(2);
  expect(writes[1][1]?.body).toBe(writes[0][1]?.body);
  expect(writes[0][1]?.body).toContain(assistantText);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]?.[0].length).toBeGreaterThan(1);
});

test('real vector history fails on the first embedding 503 and replays after repair without keyword write fallback', async () => {
  const raw = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockRejectedValue(new Error('embedder down'));
  const embedding = buildEmbedding({
    kind: 'sap-ai-core',
    model: 'failed-history',
  });
  if (!embedding) throw new Error('Missing embedding');
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: {
        tools: 'in-memory',
        session: 'vector',
        persistent: 'in-memory',
      },
    },
    embedding,
  );
  const router = new SessionHistoryRouter(
    historyTestProvider(stores.create('session', 'history')),
  );
  await expect(router.recordTurn(turn)).resolves.toBe(false);
  expect(raw).toHaveBeenCalledTimes(1);
  expect(toolSearchFailure()).toBeDefined();
  for (let index = 0; index < 30; index++) embedding.breaker.recordFailure();
  raw.mockResolvedValue({ vector: [1, 2] });
  await assertToolSearchHealthy();
  expect(await router.listTurns(caller)).toContainEqual(
    expect.objectContaining({
      id: 'stable-turn',
      assistantText: 'complete answer',
    }),
  );
});

test('the next request waits for all earlier writes of its session and preserves write order', async () => {
  const { router, upsert } = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = upsert.getMockImplementation();
  if (!original) throw new Error('Missing writer');
  upsert.mockImplementationOnce(async (...args) => {
    await held;
    return original(...args);
  });
  const first = router.recordTurn(turn);
  const second = router.recordTurn({ ...turn, id: 'second-turn' });
  let admitted = false;
  const next = router.waitForTurns(caller.sessionId).then(() => {
    admitted = true;
  });
  await router.waitForTurns('another-session');
  expect(admitted).toBe(false);
  release();
  await Promise.all([first, second, next]);
  expect(admitted).toBe(true);
  expect(upsert.mock.calls.map(([id]) => id)).toEqual([
    'stable-turn',
    'second-turn',
  ]);
});

test('abort cancels the next request wait while the owed write survives', async () => {
  const { router, upsert } = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = upsert.getMockImplementation();
  if (!original) throw new Error('Missing writer');
  upsert.mockImplementationOnce(async (...args) => {
    await held;
    return original(...args);
  });
  const stored = router.recordTurn(turn);
  const abort = new AbortController();
  const waiting = router.waitForTurns(caller.sessionId, abort.signal);
  abort.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  release();
  await expect(stored).resolves.toBe(true);
  expect(await router.listTurns(caller)).toHaveLength(1);
});

test.each(['result', 'exception'] as const)(
  '%s failure makes readiness DOWN and retains writes until repair',
  async (failure) => {
    const { router, upsert } = fixture();
    const original = upsert.getMockImplementation();
    if (!original) throw new Error('Missing writer');
    upsert.mockImplementation(async () => {
      if (failure === 'exception') throw new Error('private backend payload');
      return { ok: false, error: new RagError('private embedder payload') };
    });
    await expect(router.recordTurn(turn)).resolves.toBe(false);
    expect(withToolSearchHealth({ status: 200, body: {} })).toMatchObject({
      status: 503,
    });
    await expect(assertToolSearchHealthy()).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      router.recordTurn({ ...turn, id: 'later-turn' }),
    ).resolves.toBe(false);
    expect(toolSearchFailure()).not.toContain('private');
    upsert.mockImplementation(original);
    await assertToolSearchHealthy();
    await router.waitForTurns(caller.sessionId);
    expect(toolSearchFailure()).toBeUndefined();
    expect(
      (await router.listTurns(caller)).map((item) => item.id).sort(),
    ).toEqual(['later-turn', 'stable-turn']);
  },
);
