import type { IUsageControl, IUsageRecorder } from '@mcp-abap-adt/llm-agent';

jest.mock('../../srv/agent-manager', (): object => ({
  getCollectionRegistry: (): CollectionRegistry => collections,
  isProvidersReady: (): boolean => providersReady,
  getSharedHistoryRag: (): SessionHistoryRag | undefined => historyRag,
}));
jest.mock('@sap/cds', (): object => ({
  __esModule: true,
  default: {
    log: (): { warn(): void; info(): void; error(): void; debug(): void } => ({
      warn(): void {},
      info(): void {},
      error(): void {},
      debug(): void {},
    }),
  },
}));

import {
  InMemoryRag,
  type IRag,
  type Message,
  RagError,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import {
  getDialogueStoreBackend,
  type HubDialogueState,
  initializeDialogueStore,
} from '../../srv/lib/dialogue-store';
import { loadSessionConfig } from '../../srv/lib/session-config';
import {
  renderTurn,
  SessionHistoryRag,
  turnOwner,
} from '../../srv/lib/session-history-rag';
import { isRefusal, SessionRetention } from '../../srv/lib/session-retention';
import { readUsageConfig } from '../../srv/lib/usage/config';
import {
  initUsage,
  setUsageRuntimeForTest,
  type UsageRuntime,
} from '../../srv/lib/usage/runtime';
import {
  resetUsageSessionsForTest,
  sessionClosed,
  sessionOpened,
  sessionReleased,
} from '../../srv/lib/usage/session-records';
import * as measurements from '../../srv/lib/usage/storage-meter';
import { measureSession, measureUser } from '../../srv/lib/usage/storage-meter';
import {
  StorageMeter,
  startStorageMeter,
  stopStorageMeter,
} from '../../srv/lib/usage/storage-scheduler';
import {
  setStorageSnapshots,
  storageSnapshots,
} from '../../srv/lib/usage/storage-snapshot';
import { CollectionRegistry } from '../../srv/rag-collections';
import {
  amendSessionMessage,
  appendToSession,
  clearSession,
  sweepSessionHistory,
} from '../../srv/session-store';

let providersReady = false;
let historyRag: SessionHistoryRag | undefined;
let collections: CollectionRegistry;
let runtime: UsageRuntime;
let control: ReturnType<typeof createUsageRecorder>;
let sink: ReturnType<typeof memorySink>;
const session = { userId: 'alice', sessionId: 'storage-session' };
const ticks: { tick: () => void; ms: number }[] = [];
const bytes = (value: object): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');
const state = (): HubDialogueState => ({
  conversation: [{ role: 'user', content: 'STATE_SENTINEL_\u{1f600}' }],
  tasks: [],
  pending: [],
  savedAt: Date.now(),
  outbox: [
    {
      id: 'reply',
      text: 'OUTBOX_SENTINEL_\u{1f600}',
      createdAt: Date.now(),
      trigger: 'user',
    },
  ],
});
async function records(kind: string): Promise<UsageRecord[]> {
  await control.flush(1000);
  const result: UsageRecord[] = [];
  for await (const row of sink.read({ from: 0, to: Number.MAX_SAFE_INTEGER })) {
    if (row.kind === kind) result.push(row);
  }
  return result;
}
async function start(measure: string = 'all'): Promise<UsageRuntime> {
  const result = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_MEASURE: measure,
      LLM_AGENT_USAGE_STORAGE_INTERVAL_MS: '1234',
    }),
    {
      recorderFactory: (): IUsageRecorder & IUsageControl => control,
      setInterval: (
        tick: () => void,
        ms: number,
      ): ReturnType<typeof setInterval> => {
        ticks.push({ tick, ms });
        const timer = setInterval((): void => {}, ms);
        clearInterval(timer);
        return timer;
      },
    },
  );
  if (!result) throw new Error('Expected runtime');
  startStorageMeter(result, 1234);
  return result;
}
async function collection(
  scope: 'session' | 'user' = 'session',
  owner: string = 'alice',
): Promise<string> {
  const id = `${scope}-${owner}`;
  await collections.createCollection({
    id,
    logicalId: id,
    displayName: id,
    description: '',
    scope,
    owner,
    ...(scope === 'session' ? { sessionId: session.sessionId } : {}),
  });
  await collections.addDocument(id, {
    id: 'one',
    text: 'DOCUMENT_SENTINEL_\u{1f600}',
    metadata: {},
  });
  return id;
}
beforeEach(async (): Promise<void> => {
  providersReady = false;
  historyRag = undefined;
  ticks.length = 0;
  sink = memorySink({ limit: 1000 });
  control = createUsageRecorder({ transport: directTransport(sink) });
  runtime = await start();
  collections = new CollectionRegistry({ defaultBackend: 'in-memory' });
  initializeDialogueStore(
    loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'none' }),
  );
  resetUsageSessionsForTest();
  sessionOpened(session);
});
afterEach(async (): Promise<void> => {
  jest.restoreAllMocks();
  clearSession(session.sessionId, session.userId);
  stopStorageMeter(runtime);
  await runtime.close(1000);
  setUsageRuntimeForTest(undefined);
  resetUsageSessionsForTest();
  setStorageSnapshots();
});

test('session measures use non-overlapping state, outbox, history and collection counters', async (): Promise<void> => {
  const saved = state();
  await getDialogueStoreBackend().save('alice', session.sessionId, saved);
  const message: Message = {
    role: 'user',
    content: 'HISTORY_SENTINEL_\u{1f600}',
  };
  appendToSession(session.sessionId, 'alice', message);
  await collection();
  const { outbox, ...rest } = saved;
  expect(await measureSession(session.sessionId, 'alice')).toEqual({
    stateBytes: bytes(rest),
    outboxBytes: bytes(outbox ?? []),
    historyBytesUnknown: true,
    sessionCollectionDocuments: 1,
    sessionCollectionTextBytes: Buffer.byteLength(
      'DOCUMENT_SENTINEL_\u{1f600}',
      'utf8',
    ),
    sessionCollectionVectorBytes: 0,
  });
  expect(bytes(rest)).toBeLessThan(bytes(saved));
});

test('no content-loading API is called and serialized records contain no content', async (): Promise<void> => {
  await getDialogueStoreBackend().save('alice', session.sessionId, state());
  await collection();
  const load = jest
    .spyOn(getDialogueStoreBackend(), 'load')
    .mockRejectedValue(new Error('Content read'));
  const documents = jest
    .spyOn(collections, 'listDocuments')
    .mockRejectedValue(new Error('Content read'));
  const get = jest
    .spyOn(collections, 'getDocument')
    .mockRejectedValue(new Error('Content read'));
  const meter = storageSnapshots();
  if (!(meter instanceof StorageMeter)) throw new Error('Expected meter');
  await meter.tick(runtime);
  await sessionClosed(session, 'explicit');
  expect(load).not.toHaveBeenCalled();
  expect(documents).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  const encoded = JSON.stringify([
    ...(await records('x.hub.storage')),
    ...(await records('x.hub.storage.user')),
  ]);
  for (const sentinel of [
    'STATE_SENTINEL',
    'OUTBOX_SENTINEL',
    'DOCUMENT_SENTINEL',
  ])
    expect(encoded).not.toContain(sentinel);
});

test('user collections are isolated from session collections and other users', async (): Promise<void> => {
  await collection('user');
  await collection('session');
  await collection('user', 'bob');
  expect(await measureUser('alice')).toEqual({
    userCollectionDocuments: 1,
    userCollectionTextBytes: Buffer.byteLength('DOCUMENT_SENTINEL_\u{1f600}'),
    userCollectionVectorBytes: 0,
  });
});

test('collection overwrite, update and deletion maintain byte counters', async (): Promise<void> => {
  const id = await collection();
  await collections.addDocument(id, {
    id: 'one',
    text: '\u00e9',
    metadata: {},
  });
  expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
    sessionCollectionDocuments: 1,
    sessionCollectionTextBytes: 2,
  });
  await collections.updateDocument(id, 'one', { text: '\u{1f600}' });
  expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
    sessionCollectionTextBytes: 4,
  });
  await collections.deleteDocument(id, 'one');
  expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
    sessionCollectionDocuments: 0,
    sessionCollectionTextBytes: 0,
  });
});

test('unavailable counters omit their value and set the corresponding Unknown flag', async (): Promise<void> => {
  jest
    .spyOn(getDialogueStoreBackend(), 'storageBytes')
    .mockReturnValue(undefined);
  const snapshot = await measureSession(session.sessionId, 'alice');
  expect(snapshot).toMatchObject({
    stateBytesUnknown: true,
    outboxBytesUnknown: true,
  });
  expect(snapshot).not.toHaveProperty('stateBytes');
  expect(snapshot).not.toHaveProperty('outboxBytes');
});

test('unavailable collection registry produces unknown measures', async (): Promise<void> => {
  jest.spyOn(collections, 'storageMeasures').mockImplementation((): never => {
    throw new Error('Unavailable');
  });
  expect(await measureUser('alice')).toEqual({
    userCollectionDocumentsUnknown: true,
    userCollectionTextBytesUnknown: true,
    userCollectionVectorBytesUnknown: true,
  });
});

test('memory history amendments and expiry do not claim persisted history bytes', async (): Promise<void> => {
  const message: Message = { role: 'user', content: 'before' };
  appendToSession(session.sessionId, 'alice', message);
  amendSessionMessage(session.sessionId, 'alice', message, '\u{1f600}');
  expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
    historyBytesUnknown: true,
  });
  sweepSessionHistory(Date.now() + 365 * 86400000);
  expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
    historyBytesUnknown: true,
  });
});

test('writes refresh the synchronous eviction cache; close drops it', async (): Promise<void> => {
  appendToSession(session.sessionId, 'alice', {
    role: 'user',
    content: 'cached',
  });
  await storageSnapshots().measure(session);
  expect(storageSnapshots().cached(session)).toMatchObject({
    historyBytesUnknown: true,
    storageSnapshotAt: expect.any(Number),
  });
  sessionReleased(session, 'evicted');
  expect(storageSnapshots().cached(session)).toBeUndefined();
  expect(await records('x.hub.storage')).toHaveLength(1);
});

test('eviction before the first measurement emits Unknown storage for a history-only session', async (): Promise<void> => {
  const measure = jest.spyOn(measurements, 'measureSession');
  appendToSession(session.sessionId, session.userId, {
    role: 'user',
    content: 'recent history only',
  });
  sessionReleased(session, 'evicted');
  const expected = {
    storageSnapshotAt: expect.any(Number),
    stateBytesUnknown: true,
    outboxBytesUnknown: true,
    historyBytesUnknown: true,
    sessionCollectionDocumentsUnknown: true,
    sessionCollectionTextBytesUnknown: true,
    sessionCollectionVectorBytesUnknown: true,
  };
  expect(await records('x.hub.storage')).toMatchObject([{ values: expected }]);
  const closes = (await records('x.hub.session')).filter(
    (record: UsageRecord): boolean =>
      record.kind === 'x.hub.session' && record.values.event === 'close',
  );
  expect(closes).toMatchObject([{ values: expected }]);
  expect(measure).not.toHaveBeenCalled();
  expect(storageSnapshots().cached(session)).toBeUndefined();
});

test('close without a measurement or cached snapshot emits Unknown storage', async (): Promise<void> => {
  setStorageSnapshots({
    measure: async (): Promise<undefined> => undefined,
    cached: (): undefined => undefined,
  });
  await sessionClosed(session, 'explicit');
  expect(await records('x.hub.storage')).toMatchObject([
    { values: { historyBytesUnknown: true, stateBytesUnknown: true } },
  ]);
});

test('a stalled query releases the deadline lock for another measurement and discards late results', async (): Promise<void> => {
  const meter = new StorageMeter(20);
  meter.retain(session);
  let finish: (value: Record<string, number | boolean>) => void =
    (): void => {};
  const gate = new Promise<Record<string, number | boolean>>(
    (resolve: (value: Record<string, number | boolean>) => void): void => {
      finish = resolve;
    },
  );
  const measure = jest
    .spyOn(measurements, 'measureSession')
    .mockReturnValueOnce(gate)
    .mockResolvedValue({ historyBytes: 7 });
  const first = meter.measure(session);
  // Allow the pending measurement to advance.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const second = meter.measure(session);
  const other = meter.measure({ userId: 'bob', sessionId: 'other' });
  await Promise.all([first, second, other]);
  expect(measure).toHaveBeenCalledTimes(1);
  expect(await first).toMatchObject({ historyBytesUnknown: true });
  expect(await second).toMatchObject({ historyBytesUnknown: true });
  expect(await other).toMatchObject({ historyBytesUnknown: true });
  await meter.measure(session);
  expect(meter.cached(session)).toMatchObject({ historyBytes: 7 });
  finish({ historyBytes: 123 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(meter.cached(session)).toMatchObject({ historyBytes: 7 });
  meter.release(session);
  expect(meter.cached(session)).toBeUndefined();
});

test('periodic ticks emit one session record per live session and one user record per user', async (): Promise<void> => {
  const meter = storageSnapshots();
  if (!(meter instanceof StorageMeter)) throw new Error('Expected meter');
  await collection('user');
  sessionOpened({ userId: 'alice', sessionId: 'second' });
  await meter.tick(runtime);
  expect(await records('x.hub.storage')).toHaveLength(2);
  const users = await records('x.hub.storage.user');
  expect(users).toHaveLength(1);
  expect(users[0]?.context.sessionId).toBeUndefined();
  expect(users[0]?.context.userId).not.toBe('alice');
  expect(
    ticks.filter(
      (item: { tick: () => void; ms: number }): boolean => item.ms === 1234,
    ),
  ).toHaveLength(1);
});

test.each(['explicit', 'ttl'])(
  'plain %s close measures the real history before cleanup',
  async (reason: string): Promise<void> => {
    const retention = new SessionRetention({
      hasState: (): boolean => reason === 'explicit',
      deleteAll: (userId: string, sessionId: string): void =>
        clearSession(sessionId, userId),
      onSessionRetained: (userId: string, sessionId: string): void =>
        sessionOpened({ userId, sessionId }),
      beforeSessionReleased: (
        userId: string,
        sessionId: string,
      ): Promise<void> =>
        sessionClosed(
          { userId, sessionId },
          reason === 'explicit' ? 'explicit' : 'ttl',
        ),
      onSessionReleased: (userId: string, sessionId: string): void =>
        sessionReleased(
          { userId, sessionId },
          reason === 'explicit' ? 'explicit' : 'ttl',
        ),
    });
    const lease = retention.lease('alice', session.sessionId, 'rag');
    if (isRefusal(lease)) throw new Error('Refused');
    const message: Message = { role: 'user', content: 'final history' };
    appendToSession(session.sessionId, 'alice', message);
    lease.release();
    await retention.close('alice', session.sessionId);
    expect(await records('x.hub.storage')).toMatchObject([
      { values: { historyBytesUnknown: true } },
    ]);
    expect(await measureSession(session.sessionId, 'alice')).toMatchObject({
      historyBytesUnknown: true,
    });
    expect(storageSnapshots().cached(session)).toBeUndefined();
  },
);

test.each(['off', 'session'])(
  'usage %s maintains no byte counters or storage timer',
  async (mode: string): Promise<void> => {
    stopStorageMeter(runtime);
    await runtime.close(1000);
    ticks.length = 0;
    if (mode === 'off') setUsageRuntimeForTest(undefined);
    else runtime = await start('session');
    initializeDialogueStore(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'none' }),
    );
    await getDialogueStoreBackend().save('alice', session.sessionId, state());
    appendToSession(session.sessionId, 'alice', {
      role: 'user',
      content: 'off',
    });
    expect(
      getDialogueStoreBackend().storageBytes?.('alice', session.sessionId),
    ).toBeUndefined();
    expect(await measureSession(session.sessionId, 'alice')).toEqual({});
    expect(await measureUser('alice')).toEqual({});
    const track = jest.fn<void, [string, boolean]>();
    const update = jest.fn();
    setStorageSnapshots({
      measure: async (): Promise<undefined> => undefined,
      cached: (): undefined => undefined,
      trackUser: track,
      update,
    });
    const owner = turnOwner(session.userId, session.sessionId);
    const rag = new SessionHistoryRag(
      new InMemoryRag(),
      (): string => owner,
      1,
      {
        storageBackend: 'hana-vector',
      },
    );
    for (let index = 0; index < 2; index++)
      await rag.recordTurn({
        owner,
        id: `off-${index}`,
        userText: 'q',
        assistantText: 'a',
      });
    await rag.listTurns(owner);
    await rag.forgetOwner(owner);
    expect(rag['byteCounters']).toBeUndefined();
    expect(rag['clearedOwners']).toBeUndefined();
    await collection('user');
    expect(track).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(
      ticks.filter(
        (item: { tick: () => void; ms: number }): boolean => item.ms === 1234,
      ),
    ).toHaveLength(0);
  },
);

test('a closing generation cannot delete a replacement session cache', async (): Promise<void> => {
  const meter = new StorageMeter();
  const replacement = { ...session };
  meter.retain(session);
  meter.retain(replacement);
  meter.update(replacement, { historyBytes: 11 });
  meter.release(session);
  expect(meter.cached(replacement)).toMatchObject({ historyBytes: 11 });
  meter.release(replacement);
  expect(meter.cached(replacement)).toBeUndefined();
});

test('a cached measure becoming unavailable omits its previous numeric value', (): void => {
  const meter = new StorageMeter();
  meter.retain(session);
  meter.update(session, { sessionCollectionTextBytes: 12 });
  meter.update(session, { sessionCollectionTextBytesUnknown: true });
  expect(meter.cached(session)).toMatchObject({
    sessionCollectionTextBytesUnknown: true,
  });
  expect(meter.cached(session)).not.toHaveProperty(
    'sessionCollectionTextBytes',
  );
  meter.update(session, { sessionCollectionTextBytes: 24 });
  expect(meter.cached(session)).toMatchObject({
    sessionCollectionTextBytes: 24,
  });
  expect(meter.cached(session)).not.toHaveProperty(
    'sessionCollectionTextBytesUnknown',
  );
  meter.stop();
});

test('RAG writes refresh eviction cache without waiting for a periodic tick', async (): Promise<void> => {
  const id = await collection();
  expect(storageSnapshots().cached(session)).toMatchObject({
    sessionCollectionDocuments: 1,
  });
  await collections.deleteDocument(id, 'one');
  expect(storageSnapshots().cached(session)).toMatchObject({
    sessionCollectionDocuments: 0,
    sessionCollectionTextBytes: 0,
  });
});

test('server shutdown stops the meter and drops every retained snapshot', async (): Promise<void> => {
  const meter = storageSnapshots();
  if (!(meter instanceof StorageMeter)) throw new Error('Expected meter');
  appendToSession(session.sessionId, 'alice', {
    role: 'user',
    content: 'cached',
  });
  await meter.measure(session);
  expect(meter.cached(session)).toBeDefined();
  stopStorageMeter(runtime);
  await runtime.close(1000);
  expect(meter.cached(session)).toBeUndefined();
  expect(await meter.measure(session)).toBeUndefined();
});

test('a slow snapshot cannot replace newer write-time cache counters', async (): Promise<void> => {
  const meter = new StorageMeter();
  meter.retain(session);
  let finish: (value: Record<string, number | boolean>) => void =
    (): void => {};
  const gate = new Promise<Record<string, number | boolean>>(
    (resolve: (value: Record<string, number | boolean>) => void): void => {
      finish = resolve;
    },
  );
  jest.spyOn(measurements, 'measureSession').mockReturnValue(gate);
  const measuring = meter.measure(session);
  meter.update(session, { historyBytes: 22 });
  finish({ historyBytes: 11 });
  await measuring;
  expect(meter.cached(session)).toMatchObject({ historyBytes: 22 });
});

test('two overlapping periodic ticks perform only one measurement', async (): Promise<void> => {
  const meter = new StorageMeter();
  meter.retain(session);
  let finish: (value: Record<string, number | boolean>) => void =
    (): void => {};
  const gate = new Promise<Record<string, number | boolean>>(
    (resolve: (value: Record<string, number | boolean>) => void): void => {
      finish = resolve;
    },
  );
  const measuring = jest
    .spyOn(measurements, 'measureSession')
    .mockReturnValue(gate);
  const first = meter.tick(runtime);
  await meter.tick(runtime);
  expect(measuring).toHaveBeenCalledTimes(1);
  finish({ historyBytes: 11 });
  await first;
});

test('runtime initialization leaves storage scheduling to the server lifecycle', async (): Promise<void> => {
  stopStorageMeter(runtime);
  await runtime.close(1000);
  ticks.length = 0;
  const initialized = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
    }),
    { recorderFactory: (): IUsageRecorder & IUsageControl => control },
  );
  if (!initialized) throw new Error('Expected runtime');
  runtime = initialized;
  expect(storageSnapshots()).not.toBeInstanceOf(StorageMeter);
  const schedule = jest.spyOn(runtime, 'schedule');
  startStorageMeter(runtime, 1234);
  startStorageMeter(runtime, 1234);
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(schedule).toHaveBeenCalledWith('storage', expect.any(Function), 1234);
});

test('a timed-out session measurement does not begin user queries after shutdown', async (): Promise<void> => {
  const meter = new StorageMeter(5);
  meter.retain(session);
  let finish: (value: Record<string, number | boolean>) => void =
    (): void => {};
  const gate = new Promise<Record<string, number | boolean>>(
    (resolve: (value: Record<string, number | boolean>) => void): void => {
      finish = resolve;
    },
  );
  jest.spyOn(measurements, 'measureSession').mockReturnValue(gate);
  const user = jest.spyOn(measurements, 'measureUser');
  const pending = meter.measure(session);
  await new Promise<void>(
    (resolve: () => void): NodeJS.Timeout => setTimeout(resolve, 15),
  );
  await pending;
  meter.stop();
  finish({ historyBytes: 1 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(user).not.toHaveBeenCalled();
  expect(meter.cached(session)).toBeUndefined();
});

test.each(['expiry', 'clear'])(
  'memory history %s followed directly by synchronous eviction preserves Unknown persisted bytes',
  async (action: string): Promise<void> => {
    await collection();
    appendToSession(session.sessionId, session.userId, {
      role: 'user',
      content: 'old',
    });
    if (action === 'expiry') sweepSessionHistory(Date.now() + 365 * 86400000);
    else clearSession(session.sessionId, session.userId);
    await collections.updateDocument('session-alice', 'one', { text: 'new' });
    sessionReleased(session, 'evicted');
    expect(await records('x.hub.storage')).toMatchObject([
      { values: { historyBytesUnknown: true } },
    ]);
  },
);

test.each(['expiry', 'delete'])(
  'dialogue %s followed directly by synchronous eviction records zero bytes',
  async (action: string): Promise<void> => {
    await collection();
    const store = getDialogueStoreBackend();
    await store.save(session.userId, session.sessionId, state());
    if (action === 'expiry')
      await store.sweepExpired(Date.now() + 365 * 86400000);
    else await store.delete(session.userId, session.sessionId);
    sessionReleased(session, 'evicted');
    expect(await records('x.hub.storage')).toMatchObject([
      { values: { stateBytes: 0, outboxBytes: 0 } },
    ]);
  },
);

test.each(['before', 'after'])(
  'user collection storage is reported with zero retained sessions (last session closes %s collection creation)',
  async (timing: string): Promise<void> => {
    if (timing === 'before') sessionReleased(session, 'evicted');
    const id = await collection('user');
    if (timing === 'after') sessionReleased(session, 'evicted');
    const meter = storageSnapshots();
    if (!(meter instanceof StorageMeter)) throw new Error('Expected meter');
    await meter.tick(runtime);
    expect(await records('x.hub.storage.user')).toMatchObject([
      { values: { userCollectionDocuments: 1 } },
    ]);
    await collections.deleteCollection(id);
    await meter.tick(runtime);
    expect(await records('x.hub.storage.user')).toHaveLength(1);
  },
);

test('rotating ticks fairly measure later sessions and users when work exceeds one tick budget', async (): Promise<void> => {
  jest.useFakeTimers();
  const meter = new StorageMeter(10);
  meter.retain(session);
  meter.retain({ userId: 'bob', sessionId: 'later' });
  meter.trackUser('alice', true);
  const measured: string[] = [];
  jest
    .spyOn(measurements, 'measureSession')
    .mockImplementation(
      async (id: string): Promise<Record<string, number | boolean>> => {
        measured.push(id);
        return new Promise<Record<string, number | boolean>>(
          (
            resolve: (value: Record<string, number | boolean>) => void,
          ): NodeJS.Timeout =>
            setTimeout((): void => resolve({ historyBytes: 1 }), 30),
        );
      },
    );
  const user = jest
    .spyOn(measurements, 'measureUser')
    .mockImplementation(
      async (id: string): Promise<Record<string, number | boolean>> => {
        measured.push(id);
        return new Promise<Record<string, number | boolean>>(
          (
            resolve: (value: Record<string, number | boolean>) => void,
          ): NodeJS.Timeout =>
            setTimeout((): void => resolve({ userCollectionDocuments: 1 }), 30),
        );
      },
    );
  try {
    for (let i = 0; i < 3; i++) {
      const tick = meter.tick(runtime);
      await jest.advanceTimersByTimeAsync(10);
      await tick;
    }
    expect(measured).toEqual([session.sessionId, 'alice', 'later']);
    expect(user).toHaveBeenCalledTimes(1);
  } finally {
    meter.stop();
    jest.useRealTimers();
  }
});

test('eligible user tracking is capped with oldest dropped and disabled with usage off', async (): Promise<void> => {
  const meter = new StorageMeter();
  const user = jest.spyOn(measurements, 'measureUser').mockResolvedValue({});
  for (let i = 0; i < 1001; i++) meter.trackUser(`owner-${i}`, true);
  await meter.tick(runtime);
  expect(user).toHaveBeenCalledTimes(1000);
  expect(user.mock.calls[0]?.[0]).toBe('owner-1');
  user.mockClear();
  meter.stop();
  const disabled = new StorageMeter();
  setUsageRuntimeForTest(undefined);
  disabled.trackUser('off', true);
  setUsageRuntimeForTest(runtime);
  await disabled.tick(runtime);
  expect(user).not.toHaveBeenCalled();
  disabled.stop();
});

test('persisted recall beyond ten turns stays Unknown through window expiry and revival without content reads', async (): Promise<void> => {
  const backend = new InMemoryRag();
  const owner = turnOwner(session.userId, session.sessionId);
  providersReady = true;
  historyRag = new SessionHistoryRag(backend, (): string => owner, 12);
  for (let turn = 0; turn < 15; turn++) {
    expect(
      await historyRag.recordTurn({
        owner,
        id: `turn-${turn}`,
        userText: `question ${turn}`,
        assistantText: `answer ${turn}`,
      }),
    ).toBe(true);
    appendToSession(
      session.sessionId,
      session.userId,
      { role: 'user', content: `question ${turn}` },
      { role: 'assistant', content: `answer ${turn}` },
    );
  }
  expect(await historyRag.listTurns(owner)).toHaveLength(12);
  const scan = jest.spyOn(backend, 'scan');
  const get = jest.spyOn(backend, 'getById');
  const assertUnknown = async (): Promise<void> => {
    const measured = await storageSnapshots().measure(session);
    expect(measured).toMatchObject({ historyBytesUnknown: true });
    expect(measured).not.toHaveProperty('historyBytes');
    expect(scan).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  };
  await assertUnknown();
  sweepSessionHistory(Date.now() + 365 * 86400000);
  await assertUnknown();
  expect(storageSnapshots().cached(session)).toMatchObject({
    historyBytesUnknown: true,
  });
  historyRag = new SessionHistoryRag(backend, (): string => owner, 12);
  const turns = await historyRag.listTurns(owner);
  expect(turns).toHaveLength(12);
  for (const turn of turns)
    appendToSession(
      session.sessionId,
      session.userId,
      { role: 'user', content: turn.userText },
      { role: 'assistant', content: turn.assistantText },
    );
  scan.mockClear();
  await assertUnknown();
  expect(
    await historyRag.recordTurn({
      owner,
      id: turns[0].id,
      userText: 'replacement',
      assistantText: 'updated',
    }),
  ).toBe(true);
  scan.mockClear();
  await assertUnknown();
  clearSession(session.sessionId, session.userId);
  await historyRag.forgetOwner(owner);
  scan.mockClear();
  await assertUnknown();
});

test('a configured provider with no recall store reports zero persisted history', async (): Promise<void> => {
  providersReady = true;
  appendToSession(session.sessionId, session.userId, {
    role: 'user',
    content: 'window only',
  });
  expect(await measureSession(session.sessionId, session.userId)).toMatchObject(
    { historyBytes: 0 },
  );
});

test.each(['in-memory', 'hana-vector'])(
  '%s recall counters count stored text through cap, expiry, revival and deletion',
  async (storageBackend: string): Promise<void> => {
    const backend = new InMemoryRag();
    const owner = turnOwner(session.userId, session.sessionId);
    providersReady = true;
    historyRag = new SessionHistoryRag(backend, (): string => owner, 12, {
      storageBackend,
    });
    const textBytes = Buffer.byteLength(
      renderTurn('\u00e9\u{1f600}', 'answer'),
      'utf8',
    );
    for (let index = 0; index < 15; index++) {
      await historyRag.recordTurn({
        owner,
        id: `turn-${index}`,
        userText: '\u00e9\u{1f600}',
        assistantText: 'answer',
      });
    }
    const scan = jest.spyOn(backend, 'scan');
    expect(
      await measureSession(session.sessionId, session.userId),
    ).toMatchObject({ historyBytes: textBytes * 12 });
    expect(scan).not.toHaveBeenCalled();
    sweepSessionHistory(Date.now() + 365 * 86400000);
    expect(
      await measureSession(session.sessionId, session.userId),
    ).toMatchObject({ historyBytes: textBytes * 12 });
    historyRag = new SessionHistoryRag(backend, (): string => owner, 12, {
      storageBackend,
    });
    await historyRag.listTurns(owner);
    scan.mockClear();
    expect(
      await measureSession(session.sessionId, session.userId),
    ).toMatchObject({ historyBytes: textBytes * 12 });
    expect(scan).not.toHaveBeenCalled();
    await historyRag.forgetOwner(owner);
    expect(
      await measureSession(session.sessionId, session.userId),
    ).toMatchObject({ historyBytes: 0 });
  },
);

test.each([true, false])(
  'closing many distinct history owners releases counter storage (filtered deletion: %s)',
  async (filtered: boolean): Promise<void> => {
    const backend = new InMemoryRag();
    const inner: IRag = filtered
      ? backend
      : {
          query: backend.query.bind(backend),
          getById: backend.getById.bind(backend),
          healthCheck: backend.healthCheck.bind(backend),
          writer: backend.writer.bind(backend),
        };
    const rag = new SessionHistoryRag(inner, (): undefined => undefined, 12, {
      storageBackend: 'hana-vector',
    });
    for (let index = 0; index < 600; index++) {
      const owner = turnOwner('alice', `closed-${index}`);
      expect(
        await rag.recordTurn({
          owner,
          id: `closed-turn-${index}`,
          userText: 'question',
          assistantText: 'answer',
        }),
      ).toBe(true);
      expect(rag.storageBytes(owner)).toBeGreaterThan(0);
      expect(await rag.forgetOwner(owner)).toBe(true);
      expect(rag.storageBytes(owner)).toBe(0);
      expect(rag['byteCounters']?.size).toBe(0);
    }
    expect(rag['clearedOwners']?.size).toBeLessThanOrEqual(256);
  },
);

test('eviction immediately after a persisted-history write includes the new history bytes', async (): Promise<void> => {
  const backend = new InMemoryRag();
  const owner = turnOwner(session.userId, session.sessionId);
  providersReady = true;
  historyRag = new SessionHistoryRag(backend, (): string => owner, 12, {
    storageBackend: 'hana-vector',
  });
  expect(historyRag.storageBytes(owner)).toBeUndefined();
  await historyRag.listTurns(owner);
  await storageSnapshots().measure(session);
  expect(storageSnapshots().cached(session)).toMatchObject({ historyBytes: 0 });
  const scan = jest.spyOn(backend, 'scan');
  expect(
    await historyRag.recordTurn({
      owner,
      id: 'persisted-before-eviction',
      userText: 'new question',
      assistantText: 'new answer',
    }),
  ).toBe(true);
  const historyBytes = Buffer.byteLength(
    renderTurn('new question', 'new answer'),
    'utf8',
  );
  expect(scan).toHaveBeenCalledTimes(1);
  scan.mockClear();
  await getDialogueStoreBackend().save(
    session.userId,
    session.sessionId,
    state(),
  );
  sessionReleased(session, 'evicted');
  expect(await records('x.hub.storage')).toMatchObject([
    { values: { historyBytes } },
  ]);
  expect(scan).not.toHaveBeenCalled();
});

test.each(['result', 'throw'])(
  'repeated failed history cleanup releases owner counters without a zero marker (%s)',
  async (failure: string): Promise<void> => {
    const backend = new InMemoryRag();
    const rag = new SessionHistoryRag(backend, (): undefined => undefined, 12, {
      storageBackend: 'hana-vector',
    });
    const deletion = jest.spyOn(backend, 'deleteWhere');
    if (failure === 'throw')
      deletion.mockRejectedValue(new Error('Database unavailable'));
    else
      deletion.mockResolvedValue({
        ok: false,
        error: new RagError('Database unavailable', 'RAG_DELETE_ERROR'),
      });
    for (let index = 0; index < 600; index++) {
      const owner = turnOwner('alice', `failed-${index}`);
      await rag.recordTurn({
        owner,
        id: `failed-turn-${index}`,
        userText: 'question',
        assistantText: 'answer',
      });
      expect(rag.storageBytes(owner)).toBeGreaterThan(0);
      expect(await rag.forgetOwner(owner)).toBe(false);
      expect(rag.storageBytes(owner)).toBeUndefined();
      expect(rag['byteCounters']?.size).toBe(0);
      expect(rag['clearedOwners']?.has(owner) ?? false).toBe(false);
      expect(rag.turnCount(owner)).toBe(0);
      expect(rag['pending'].size).toBe(0);
    }
    const owner = turnOwner('alice', 'failed-599');
    await rag.listTurns(owner);
    expect(rag.storageBytes(owner)).toBeGreaterThan(0);
    deletion.mockRestore();
    expect(await rag.forgetOwner(owner)).toBe(true);
    expect(rag.storageBytes(owner)).toBe(0);
    expect(rag['byteCounters']?.size).toBe(0);
    jest
      .spyOn(backend, 'deleteWhere')
      .mockRejectedValue(new Error('Database unavailable again'));
    expect(await rag.forgetOwner(owner)).toBe(false);
    expect(rag.storageBytes(owner)).toBeUndefined();
    expect(rag['clearedOwners']?.has(owner)).toBe(false);
  },
);

test('parallel async closes wait for a periodic snapshot and each take a fresh measurement', async (): Promise<void> => {
  const meter = storageSnapshots();
  if (!(meter instanceof StorageMeter)) throw new Error('Expected meter');
  const other = { userId: 'bob', sessionId: 'other-close' };
  sessionOpened(other);
  let finish: (value: Record<string, number | boolean>) => void =
    (): void => {};
  const blocked = new Promise<Record<string, number | boolean>>(
    (resolve: (value: Record<string, number | boolean>) => void): void => {
      finish = resolve;
    },
  );
  const measure = jest
    .spyOn(measurements, 'measureSession')
    .mockReturnValueOnce(blocked)
    .mockResolvedValue({ historyBytes: 77 });
  const periodic = meter.tick(runtime);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const closes = Promise.all([
    sessionClosed(session, 'explicit'),
    sessionClosed(other, 'ttl'),
  ]);
  finish({ historyBytes: 11 });
  await Promise.all([periodic, closes]);
  expect(
    measure.mock.calls.filter(
      (args: Parameters<typeof measurements.measureSession>): boolean =>
        args[0] === session.sessionId,
    ),
  ).toHaveLength(2);
  expect(
    measure.mock.calls.filter(
      (args: Parameters<typeof measurements.measureSession>): boolean =>
        args[0] === other.sessionId,
    ),
  ).toHaveLength(2);
  const closed = (await records('x.hub.session')).filter(
    (row: UsageRecord): boolean =>
      row.kind === 'x.hub.session' && row.values.event === 'close',
  );
  expect(closed).toHaveLength(2);
  for (const row of closed)
    expect(row).toMatchObject({ values: { historyBytes: 77 } });
});

test('failed async measurements report Unknown instead of reusing cached values before the deadline', async (): Promise<void> => {
  const meter = new StorageMeter();
  meter.retain(session);
  meter.update(session, { historyBytes: 99 });
  jest
    .spyOn(measurements, 'measureSession')
    .mockRejectedValue(new Error('Unavailable'));
  const measured = await meter.measure(session);
  expect(measured).toMatchObject({ historyBytesUnknown: true });
  expect(measured).not.toHaveProperty('historyBytes');
});
