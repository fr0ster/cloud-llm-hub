jest.mock('../../srv/lib/logging-config', () => ({ applyLoggingConfig() {} }));
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: {
      user: { id: 'alice', is: () => true, roles: ['MCP_Developer'] },
    },
  },
}));
jest.mock('../../srv/agent-manager', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentManagerMock(),
);
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual<typeof import('../../srv/agent-config')>(
    '../../srv/agent-config',
  ),
  getAgentConfig: () => ({
    ...jest
      .requireActual<typeof import('../../srv/agent-config')>(
        '../../srv/agent-config',
      )
      .getAgentConfig(),
    ...jest
      .requireActual<typeof import('./helpers/channel-harness')>(
        './helpers/channel-harness',
      )
      .agentConfigMock()
      .getAgentConfig(),
  }),
}));
jest.mock('../../srv/lib/request-connection', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestConnectionMock(),
);
jest.mock('../../srv/lib/request-system-context', () =>
  jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .requestSystemMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    proxyType: 'Internet',
    authenticationType: 'OAuth2JWTBearer',
    sapConfig: { authType: 'jwt' },
    destinationName: 'DEST',
  }),
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => ({ connect: async () => {} }),
}));

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cds from '@sap/cds';
import express, { type Request, type Response } from 'express';
import { getCollectionRegistry } from '../../srv/agent-manager';
import { executeStep } from '../../srv/agent-mcp';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { userCollectionId } from '../../srv/collection-ids';
import { collectionRetrieval } from '../../srv/lib/collection-retrieval';
import { type AdmitResult, Door } from '../../srv/lib/door';
import {
  admitPipeline,
  resetGatekeeperForTest,
  shutdownGatekeeper,
  theRetention,
} from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  discardSession,
  lifecycleHooks,
  openSession,
  resolveSession,
} from '../../srv/lib/session-lifecycle';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import type {
  SessionRecord,
  SessionRecordStore,
} from '../../srv/lib/session-record-store';
import {
  isRefusal,
  type Lease,
  SessionRetention,
} from '../../srv/lib/session-retention';
import { readUsageConfig } from '../../srv/lib/usage/config';
import type { SessionCloseReason } from '../../srv/lib/usage/hub-records';
import * as hubRecords from '../../srv/lib/usage/hub-records';
import { measureRequest } from '../../srv/lib/usage/request-records';
import {
  initUsage,
  setUsageRuntimeForTest,
  type UsageRuntime,
} from '../../srv/lib/usage/runtime';
import {
  beginUsageShutdown,
  closeUsageSessions,
  holdSessionDelivery,
  resetUsageSessionsForTest,
  SESSION_TOMBSTONE_LIMIT,
  sessionClosed,
  sessionOpened,
  sessionReleased,
  usageSessionBookkeepingForTest,
} from '../../srv/lib/usage/session-records';
import {
  type StorageSnapshot,
  setStorageSnapshots,
  type UsageSession,
} from '../../srv/lib/usage/storage-snapshot';
import { handleChatCompletions } from '../../srv/openai-handler';
import { registerRagRoutes } from '../../srv/rag-handler';
import {
  appendToSession,
  clearSession,
  hasSessionHistory,
  sweepSessionHistory,
} from '../../srv/session-store';
import { deferred, harness } from './helpers/channel-harness';

let runtime: UsageRuntime;
let control: ReturnType<typeof createUsageRecorder>;
let sink: ReturnType<typeof memorySink>;
let registry: LongSessionRegistry;
let records: Map<string, SessionRecord>;
let now: number;
const session = { userId: 'alice', sessionId: 'plain' };
const snapshot: StorageSnapshot = { storageSnapshotAt: 123, historyBytes: 7 };
const id = (s: UsageSession): string => JSON.stringify([s.userId, s.sessionId]);
async function rows(kind?: string) {
  await control.flush(1000);
  const found: UsageRecord[] = [];
  for await (const record of sink.read({
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  })) {
    if (!kind || record.kind === kind) found.push(record);
  }
  return found;
}
async function sessions(event: string) {
  return (await rows('x.hub.session')).filter(
    (r: UsageRecord) => r.kind === 'x.hub.session' && r.values.event === event,
  );
}
function lease(retention: SessionRetention, name: string): Lease {
  const result = retention.lease('alice', name, 'rag');
  if (isRefusal(result)) throw new Error('Admission refused');
  return result;
}
function plainRetention(cap: number = 1) {
  const state = new Set<string>();
  const retention = new SessionRetention(
    {
      hasState: (_userId: string, sessionId: string) => state.has(sessionId),
      deleteAll: (_userId: string, sessionId: string) => {
        state.delete(sessionId);
      },
      onSessionRetained: (userId: string, sessionId: string) =>
        sessionOpened({ userId, sessionId }),
      onSessionReleased: (
        userId: string,
        sessionId: string,
        reason: SessionCloseReason,
      ) => sessionReleased({ userId, sessionId }, reason),
    },
    cap,
    () => now++,
  );
  return { retention, state };
}
async function httpRun(
  run: (req: Request, res: Response) => Promise<void>,
  body: object = {},
  cookie: string = 'clh_session=plain',
) {
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware());
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>(
    (
      yes: (value: void | PromiseLike<void>) => void,
      no: (reason?: Error) => void,
    ) => {
      resolve = yes;
      reject = no;
    },
  );
  app.post('/', async (req: Request, res: Response) => {
    Object.assign(req, { sessionMinted: true });
    try {
      await run(req, res);
      resolve();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Handler failed'));
      res.status(500).end();
    }
  });
  const server = createServer(app);
  await new Promise<void>(
    (resolveListen: (value: void | PromiseLike<void>) => void) =>
      server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    await done;
    return { status: response.status, text, headers: response.headers };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(
      (resolveClose: (value: void | PromiseLike<void>) => void) =>
        server.close(() => resolveClose()),
    );
  }
}
beforeEach(async () => {
  harness.reset();
  resetGatekeeperForTest();
  resetUsageSessionsForTest();
  setStorageSnapshots();
  now = Date.now();
  sink = memorySink({ limit: 10000 });
  control = createUsageRecorder({ transport: directTransport(sink) });
  const enabled = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_USER_ID: 'plain',
    }),
    { recorderFactory: () => control },
  );
  if (!enabled) throw new Error('Runtime disabled');
  runtime = enabled;
  records = new Map();
  const store: SessionRecordStore = {
    async put(record: SessionRecord) {
      records.set(record.key, record);
    },
    async touch(record: SessionRecord) {
      records.set(record.key, record);
    },
    async get(_userId: string, key: string) {
      return records.get(key);
    },
    async delete(_userId: string, key: string) {
      records.delete(key);
    },
    async list() {
      return [...records.values()];
    },
  };
  registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 10, queueLength: 2 },
    lifecycleHooks(store),
    () => now,
  );
  setLongSessionsForTest(registry);
});
afterEach(async () => {
  await runtime.close(1000);
  setUsageRuntimeForTest(undefined);
  resetUsageSessionsForTest();
  setStorageSnapshots();
  setLongSessionsForTest(undefined);
  resetGatekeeperForTest();
  clearSession('plain', 'alice');
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  delete process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS;
  clearGatekeeperConfig();
  jest.restoreAllMocks();
});

test('long sessions open, revive and close, with a fresh snapshot before cleanup', async () => {
  const opened = await openSession('alice', 'DEST');
  if ('refused' in opened) throw new Error('Open refused');
  setStorageSnapshots({
    cached: () => undefined,
    async measure(s: UsageSession) {
      expect(records.has(s.sessionId)).toBe(true);
      return snapshot;
    },
  });
  await registry.close('alice', opened.key, 'explicit');
  records.set('revived', {
    userId: 'alice',
    key: 'revived',
    createdAt: now - 100,
    lastActivity: now,
    ttlMs: 60000,
  });
  const revived = await resolveSession('alice', 'revived');
  expect(revived?.revived).toBe(true);
  await registry.close('alice', 'revived', 'ttl');
  expect(await sessions('open')).toHaveLength(1);
  expect(await sessions('revive')).toHaveLength(1);
  expect(
    (await sessions('close')).map((r: UsageRecord) =>
      r.kind === 'x.hub.session' ? r.values : {},
    ),
  ).toEqual([
    expect.objectContaining({ reason: 'explicit', ...snapshot }),
    expect.objectContaining({ reason: 'ttl', ...snapshot }),
  ]);
});

test('expired-offline has an unknown end and snapshots before deletion', async () => {
  records.set('offline', {
    userId: 'alice',
    key: 'offline',
    createdAt: now - 100000,
    lastActivity: now - 100000,
    ttlMs: 60000,
  });
  setStorageSnapshots({
    cached: () => undefined,
    async measure(s: UsageSession) {
      expect(records.has(s.sessionId)).toBe(true);
      return snapshot;
    },
  });
  await discardSession('alice', 'offline');
  expect(await sessions('close')).toEqual([
    expect.objectContaining({
      values: expect.objectContaining({
        reason: 'expired-offline',
        endKnown: false,
        storageSnapshotAt: 123,
      }),
    }),
  ]);
});

test.each(['evicted', 'explicit', 'settle', 'forgetEmpty'])(
  'each plain close path is once-only: %s',
  async (path: string) => {
    const { retention, state } = plainRetention();
    const first = lease(retention, 'plain');
    if (path !== 'settle') state.add('plain');
    first.release();
    first.release();
    if (path === 'evicted') {
      const next = lease(retention, 'next');
      state.add('next');
      next.release();
    }
    if (path === 'explicit') {
      await retention.close('alice', 'plain');
      await retention.close('alice', 'plain');
    }
    if (path === 'forgetEmpty') {
      state.clear();
      retention.forgetEmpty();
      retention.forgetEmpty();
    }
    const closed = (await sessions('close')).filter(
      (r: UsageRecord) => r.context.sessionId === 'plain',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      values: {
        reason:
          path === 'evicted'
            ? 'evicted'
            : path === 'explicit'
              ? 'explicit'
              : 'ttl',
      },
    });
  },
);

test('eviction during slow measurement uses the cached snapshot and reuses the slot synchronously', async () => {
  const slow = deferred<void>();
  const calls: string[] = [];
  setStorageSnapshots({
    cached: () => snapshot,
    async measure(s: UsageSession) {
      calls.push(id(s));
      await slow.promise;
      return { storageSnapshotAt: 999 };
    },
  });
  const { retention, state } = plainRetention();
  const first = lease(retention, 'plain');
  state.add('plain');
  first.release();
  const measuring = (await import('../../srv/lib/usage/storage-snapshot'))
    .storageSnapshots()
    .measure(session);
  const next = lease(retention, 'next');
  state.add('next');
  next.release();
  const third = lease(retention, 'third');
  expect(third).toBeDefined();
  expect(retention.snapshot().retained).toBe(1);
  expect(calls).toHaveLength(1);
  expect((await sessions('close'))[0]).toMatchObject({
    context: { sessionId: 'plain' },
    values: { reason: 'evicted', ...snapshot },
  });
  slow.resolve();
  await measuring;
  third.release();
  expect(
    (await sessions('close')).filter(
      (r: UsageRecord) => r.context.sessionId === 'plain',
    ),
  ).toHaveLength(1);
});

test('shutdown closes every live long and plain session before the runtime closes', async () => {
  await openSession('alice');
  const { retention, state } = plainRetention();
  const held = lease(retention, 'plain');
  state.add('plain');
  held.release();
  const measured: string[] = [];
  setStorageSnapshots({
    cached: () => undefined,
    async measure(s: UsageSession) {
      expect(runtime.status().enabled).toBe(true);
      measured.push(s.sessionId);
      return snapshot;
    },
  });
  await registry.closeAll('shutdown');
  await closeUsageSessions();
  expect(measured).toHaveLength(2);
  expect(await sessions('close')).toHaveLength(2);
  for (const record of await sessions('close'))
    expect(record).toMatchObject({ values: { reason: 'shutdown' } });
  const source = readFileSync('srv/server.ts', 'utf8');
  expect(source.indexOf('await closeUsageSessions(')).toBeLessThan(
    source.indexOf('await usageRuntime()?.close(USAGE_SHUTDOWN_TIMEOUT_MS)'),
  );
});

test.each([
  ['openai', false],
  ['openai', true],
  ['anthropic', false],
  ['anthropic', true],
])(
  'one %s request record (stream=%s)',
  async (protocol: string | boolean, stream: string | boolean) => {
    const handler =
      protocol === 'openai' ? handleChatCompletions : handleAnthropicMessages;
    const response = await httpRun(handler, {
      model: 'm',
      stream,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'PROMPT_SENTINEL' }],
    });
    expect(response.status).toBe(200);
    const found = await rows('x.hub.request');
    expect(found).toHaveLength(1);
    expect(found[0].context.requestId).toBe(
      harness.seenOptions[0]?.trace?.traceId,
    );
    expect(found[0].context.traceId).toBe(found[0].context.requestId);
    expect(found[0]).toMatchObject({
      context: { sessionId: 'plain', userId: 'alice' },
      values: {
        protocol,
        stream,
        endReason: 'done',
        messagesDelivered: 1,
        bytesWritten: expect.any(Number),
      },
    });
    expect(JSON.stringify(await rows())).not.toContain('PROMPT_SENTINEL');
  },
);

test('agent MCP execute_step records its protocol and tool once', async () => {
  await httpRun(async (req: Request, res: Response) => {
    res.json(
      await executeStep(
        req,
        { userId: 'alice', exposition: undefined },
        { task: 'TASK_SENTINEL', destination: 'DEST' },
      ),
    );
  });
  expect(await rows('x.hub.request')).toEqual([
    expect.objectContaining({
      values: expect.objectContaining({
        protocol: 'mcp-agent',
        tool: 'execute_step',
        endReason: 'done',
      }),
    }),
  ]);
  const request = (await rows('x.hub.request'))[0];
  expect(request.context.requestId).toBe(
    harness.seenOptions[0]?.trace?.traceId,
  );
  expect(request.context.traceId).toBe(request.context.requestId);
  expect(request.context.sessionId).toBe(request.context.traceId);
  expect(JSON.stringify(await rows())).not.toContain('TASK_SENTINEL');
});

test('disconnect ends the response before continuing work, with exactly one record', async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  const signal = new AbortController();
  harness.process = async () => {
    started.resolve();
    await gate.promise;
    return { ok: true, value: { content: 'done' } };
  };
  await httpRun(async (req: Request, res: Response) => {
    const running = executeStep(
      req,
      { userId: 'alice', exposition: undefined },
      { task: 'run', destination: 'DEST' },
      signal.signal,
    );
    await started.promise;
    signal.abort();
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        setTimeout(resolve, 10),
    );
    expect(await rows('x.hub.request')).toHaveLength(0);
    gate.resolve();
    res.json(await running);
  });
  const found = await rows('x.hub.request');
  expect(found).toHaveLength(1);
  const record = found[0];
  if (record.kind !== 'x.hub.request') throw new Error('Wrong kind');
  expect(record.values.endReason).toBe('disconnected');
  expect(Number(record.values.operationEndAt)).toBeGreaterThan(
    Number(record.values.responseEndAt),
  );
});

test('history expiry retains collections without closing the session (Task 4 storage integration deferred)', async () => {
  const { retention, state } = plainRetention();
  const first = lease(retention, 'plain');
  state.add('plain');
  first.release();
  appendToSession('plain', 'alice', {
    role: 'user',
    content: 'HISTORY_SENTINEL',
  });
  expect(hasSessionHistory('plain', 'alice')).toBe(true);
  sweepSessionHistory(Date.now() + 365 * 86400000);
  retention.forgetEmpty();
  expect(hasSessionHistory('plain', 'alice')).toBe(false);
  expect(retention.isKnown('alice', 'plain')).toBe(true);
  expect(await sessions('close')).toHaveLength(0);
});

test('RAG-only sessions open and use cached close snapshots on eviction (Task 4 storage scheduling deferred)', async () => {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '1';
  process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '1';
  clearGatekeeperConfig();
  resetGatekeeperForTest();
  const app = express();
  registerRagRoutes(app, getCollectionRegistry());
  const response = await httpRun(
    async (req: Request, res: Response) => {
      req.url = '/rag/collections';
      app(req, res);
    },
    { id: 'only-rag', displayName: 'RAG', scope: 'session' },
  );
  expect(response.status).toBe(201);
  expect(hasSessionHistory('plain', 'alice')).toBe(false);
  expect(await sessions('open')).toMatchObject([
    { context: { sessionId: 'plain' } },
  ]);
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async (s: UsageSession) => {
      expect(s.sessionId).toBe('plain');
      expect(theRetention().isKnown('alice', 'plain')).toBe(true);
      return { storageSnapshotAt: 456, sessionCollectionDocuments: 0 };
    },
  );
  setStorageSnapshots({
    measure,
    cached: () => ({ storageSnapshotAt: 456, sessionCollectionDocuments: 0 }),
  });

  const admitted = lease(theRetention(), 'replacement');
  expect((await sessions('close'))[0]).toMatchObject({
    context: { sessionId: 'plain' },
    values: { reason: 'evicted', storageSnapshotAt: 456 },
  });
  expect(measure).not.toHaveBeenCalled();
  admitted.release();
});

test('usage off installs no request observers and never asks the storage seam', async () => {
  setUsageRuntimeForTest(undefined);
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => snapshot,
  );
  const cached = jest.fn<StorageSnapshot | undefined, [UsageSession]>(
    () => snapshot,
  );
  setStorageSnapshots({ measure, cached });
  const { retention, state } = plainRetention();
  const held = lease(retention, 'plain');
  state.add('plain');
  held.release();
  await retention.close('alice', 'plain');
  await httpRun(handleChatCompletions, {
    model: 'm',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const retainedBefore = theRetention().snapshot().retained;
  const productionLease = lease(theRetention(), 'off-sync');
  productionLease.release();
  expect(theRetention().snapshot().retained).toBe(retainedBefore);
  expect(theRetention().isKnown('alice', 'off-sync')).toBe(false);
  expect(await rows()).toHaveLength(0);
  expect(measure).not.toHaveBeenCalled();
  expect(cached).not.toHaveBeenCalled();
});

test.each([
  [true, true],
  [false, true],
  [true, false],
])(
  'retrieval records two collections and injected size without content (relevant=%s, user=%s)',
  async (relevant: boolean, hasUser: boolean) => {
    const collections = getCollectionRegistry();
    const ids = ['usage-a', 'usage-b'].map((logicalId: string) =>
      userCollectionId(logicalId, 'alice'),
    );
    for (const [index, collectionId] of ids.entries()) {
      await collections.createCollection({
        id: collectionId,
        logicalId: index === 0 ? 'usage-a' : 'usage-b',
        displayName: 'test',
        description: '',
        scope: 'user',
        owner: 'alice',
      });
      const store = await collections.getRagStore(collectionId);
      if (!store) throw new Error('Missing store');
      jest.spyOn(store, 'query').mockResolvedValue({
        ok: true,
        value: (index === 0 ? ['DOC_ONE', 'DOC_TWO'] : ['DOC_THREE']).map(
          (text: string) => ({
            id: text,
            text,
            score: relevant ? 1 : 0,
            metadata: {},
          }),
        ),
      });
    }
    const usage = runtime.forSession(session).with({ requestId: 'retrieval' });
    const retrieval = collectionRetrieval({ deps: { ragStores: {} } });
    try {
      await retrieval.retrieve(
        { headers: { 'x-rag-collections': 'usage-a,usage-b' }, body: {} },
        hasUser
          ? [{ role: 'user', content: 'question' }]
          : [{ role: 'system', content: 'system' }],
        'alice',
        'plain',
        cds.log('test'),
        false,
        usage,
      );
      expect(await rows('x.hub.retrieval')).toMatchObject([
        {
          context: { sessionId: 'plain', requestId: 'retrieval' },
          values: {
            collections: 2,
            chunks: relevant && hasUser ? 3 : 0,
            chars:
              relevant && hasUser
                ? ['DOC_ONE', 'DOC_TWO', 'DOC_THREE'].join('\n---\n').length
                : 0,
            injected: relevant && hasUser,
          },
        },
      ]);
      expect(await rows('x.hub.retrieval')).toHaveLength(1);
      expect(JSON.stringify(await rows())).not.toContain('DOC_ONE');
    } finally {
      retrieval.restore();
      for (const collectionId of ids)
        await collections.deleteCollection(collectionId);
    }
  },
);

test('explicit deletion awaits a fresh snapshot before history cleanup', async () => {
  const admitted = lease(theRetention(), 'plain');
  appendToSession('plain', 'alice', {
    role: 'user',
    content: 'DELETE_SENTINEL',
  });
  admitted.release();
  const slow = deferred<void>();
  const started = deferred<void>();
  setStorageSnapshots({
    cached: () => snapshot,
    async measure(s: UsageSession) {
      expect(s.sessionId).toBe('plain');
      expect(hasSessionHistory('plain', 'alice')).toBe(true);
      started.resolve();
      await slow.promise;
      return { storageSnapshotAt: 987, historyBytes: 55 };
    },
  });
  const closing = theRetention().close('alice', 'plain');
  await started.promise;
  expect(hasSessionHistory('plain', 'alice')).toBe(true);
  expect(await sessions('close')).toHaveLength(0);
  slow.resolve();
  await closing;
  expect(hasSessionHistory('plain', 'alice')).toBe(false);
  expect(await sessions('close')).toMatchObject([
    {
      values: { reason: 'explicit', storageSnapshotAt: 987, historyBytes: 55 },
    },
  ]);
});

test('shutdown marks closes caused by abort and waits for snapshots already in flight', async () => {
  sessionOpened(session);
  const slow = deferred<void>();
  setStorageSnapshots({
    cached: () => snapshot,
    async measure() {
      await slow.promise;
      return snapshot;
    },
  });
  beginUsageShutdown();
  const closing = sessionClosed(session, 'ttl');
  let finished = false;
  const shutdown = closeUsageSessions().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  slow.resolve();
  await closing;
  await shutdown;
  expect(await sessions('close')).toMatchObject([
    { values: { reason: 'shutdown' } },
  ]);
});

test('OpenAI HTTP disconnect records once after its admitted work finishes', async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  const disconnected = deferred<void>();
  const done = deferred<void>();
  harness.process = async () => {
    started.resolve();
    await gate.promise;
    return { ok: true, value: { content: 'answer' } };
  };
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware());
  app.post('/', async (req: Request, res: Response) => {
    Object.assign(req, { sessionMinted: true });
    res.once('close', () => disconnected.resolve());
    try {
      await handleChatCompletions(req, res);
    } finally {
      done.resolve();
    }
  });
  const server = createServer(app);
  await new Promise<void>(
    (resolve: (value: void | PromiseLike<void>) => void) =>
      server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${address.port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: 'clh_session=plain',
    },
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'question' }],
    }),
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    await started.promise;
    controller.abort();
    await disconnected.promise;
    expect(await rows('x.hub.request')).toHaveLength(0);
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        setTimeout(resolve, 10),
    );
    gate.resolve();
    await done.promise;
    await response;
    const found = await rows('x.hub.request');
    expect(found).toHaveLength(1);
    const record = found[0];
    if (record.kind !== 'x.hub.request') throw new Error('Wrong kind');
    expect(record.values.endReason).toBe('disconnected');
    expect(Number(record.values.operationEndAt)).toBeGreaterThan(
      Number(record.values.responseEndAt),
    );
  } finally {
    gate.resolve();
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        server.close(() => resolve()),
    );
  }
});

test('storage-only measurement still receives close snapshots without session or request records', async () => {
  await runtime.close(1000);
  sink = memorySink({ limit: 10000 });
  control = createUsageRecorder({ transport: directTransport(sink) });
  const storageOnly = await initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: 'on',
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_MEASURE: 'storage',
    }),
    { recorderFactory: () => control },
  );
  if (!storageOnly) throw new Error('Expected runtime');
  runtime = storageOnly;
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => snapshot,
  );
  setStorageSnapshots({ measure, cached: () => undefined });
  const admitted = lease(theRetention(), 'plain');
  appendToSession('plain', 'alice', {
    role: 'user',
    content: 'STORAGE_ONLY_SENTINEL',
  });
  admitted.release();
  await theRetention().close('alice', 'plain');
  expect(measure).toHaveBeenCalledTimes(1);
  expect(await rows()).toHaveLength(0);
});

test('real response overload callbacks and later wrappers survive recording', async () => {
  let callbacks = 0;
  await httpRun(async (req: Request, res: Response) => {
    const originalWrite = res.write;
    const originalEnd = res.end;
    const measurement = measureRequest(req, res, session, 'openai', false);
    expect(res.write).toBe(originalWrite);
    expect(res.end).toBe(originalEnd);
    await new Promise<void>(
      (
        resolve: (value: void | PromiseLike<void>) => void,
        reject: (reason?: Error) => void,
      ) => {
        Reflect.apply(res.write, res, [
          'a',
          undefined,
          (error: Error | null | undefined) => {
            if (error) reject(error);
            else {
              callbacks++;
              resolve();
            }
          },
        ]);
      },
    );
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        res.end(null, () => {
          callbacks++;
          resolve();
        }),
    );
    measurement?.finish();
  });
  await httpRun(async (req: Request, res: Response) => {
    const measurement = measureRequest(req, res, session, 'openai', false);
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        Reflect.apply(res.end, res, [
          'b',
          undefined,
          () => {
            callbacks++;
            resolve();
          },
        ]),
    );
    measurement?.finish();
  });
  await httpRun(async (req: Request, res: Response) => {
    const measurement = measureRequest(req, res, session, 'openai', false);
    const laterEnd = res.end.bind(res);
    res.end = laterEnd;
    await new Promise<void>(
      (resolve: (value: void | PromiseLike<void>) => void) =>
        res.end(() => {
          callbacks++;
          resolve();
        }),
    );
    measurement?.finish();
    expect(res.end).toBe(laterEnd);
  });
  expect(callbacks).toBe(4);
  expect(await rows('x.hub.request')).toHaveLength(3);
});

test('real MCP SDK transport finishes a measured response after the tool returns', async () => {
  await httpRun(
    async (req: Request, res: Response) => {
      const server = new McpServer({ name: 'usage-test', version: '1' });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      server.registerTool('probe', { description: 'probe' }, async () => {
        const measurement = measureRequest(
          req,
          res,
          session,
          'mcp-agent',
          false,
          'probe',
        );
        measurement?.admitted();
        measurement?.finish();
        return { content: [] };
      });
      req.headers.accept = 'application/json, text/event-stream';
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await server.close();
    },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'probe', arguments: {} },
    },
  );
  expect(await rows('x.hub.request')).toMatchObject([
    { values: { messagesDelivered: 0, bytesWritten: expect.any(Number) } },
  ]);
});

test('shutdown waits for blocked plain pipeline teardown before final snapshot', async () => {
  const started = deferred<void>();
  const gate = deferred<void>();
  harness.process = async () => {
    started.resolve();
    await gate.promise;
    return { ok: true, value: { content: 'finished' } };
  };
  const running = httpRun(handleChatCompletions, {
    model: 'm',
    messages: [{ role: 'user', content: 'hello' }],
  });
  await started.promise;
  let closed = false;
  const shutdown = (async () => {
    beginUsageShutdown();
    await shutdownGatekeeper();
    await closeUsageSessions();
    closed = true;
  })();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(await sessions('close')).toHaveLength(0);
  gate.resolve();
  await running;
  await shutdown;
  expect(await rows('x.hub.request')).toHaveLength(1);
  expect(await sessions('close')).toMatchObject([
    { values: { messagesDelivered: 1, reason: 'shutdown' } },
  ]);
});

test('completed offline close deduplicates late discards and permits legitimate revive', async () => {
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => snapshot,
  );
  setStorageSnapshots({ measure, cached: () => undefined });
  await sessionClosed(session, 'expired-offline', false);
  await sessionClosed(session, 'expired-offline', false);
  expect(measure).toHaveBeenCalledTimes(1);
  expect(await sessions('close')).toHaveLength(1);
  sessionOpened(session, 'revive');
  await sessionClosed(session, 'explicit');
  expect(measure).toHaveBeenCalledTimes(2);
  expect(await sessions('close')).toHaveLength(2);
});

test('pending session close waits for non-stream delivery and includes its final counter', async () => {
  sessionOpened(session);
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => snapshot,
  );
  setStorageSnapshots({ measure, cached: () => undefined });
  await httpRun(async (req: Request, res: Response) => {
    const measurement = measureRequest(req, res, session, 'openai', false);
    measurement?.admitted();
    measurement?.deliverOnResponseEnd();
    const closing = sessionClosed(session, 'explicit');
    await Promise.resolve();
    expect(measure).not.toHaveBeenCalled();
    expect(await sessions('close')).toHaveLength(0);
    res.end('assistant');
    measurement?.finish();
    await closing;
  });
  expect(await sessions('close')).toMatchObject([
    { values: { messagesDelivered: 1 } },
  ]);
});

test.each(['openai', 'anthropic', 'mcp'])(
  'empty %s result records zero delivered messages',
  async (protocol: string) => {
    harness.process = async () => ({ ok: true, value: { content: '' } });
    await httpRun(
      async (req: Request, res: Response) => {
        if (protocol === 'mcp')
          res.json(
            await executeStep(
              req,
              { userId: 'alice', exposition: undefined },
              { task: 'run', destination: 'DEST' },
            ),
          );
        else
          await (protocol === 'openai'
            ? handleChatCompletions
            : handleAnthropicMessages)(req, res);
      },
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect(await rows('x.hub.request')).toMatchObject([
      { values: { messagesDelivered: 0 } },
    ]);
  },
);

test('revive during an older close snapshot keeps the new generation independently closable', async () => {
  const started = deferred<void>();
  const slow = deferred<void>();
  let measurements = 0;
  setStorageSnapshots({
    cached: () => undefined,
    async measure() {
      measurements++;
      if (measurements === 1) {
        started.resolve();
        await slow.promise;
      }
      return snapshot;
    },
  });
  sessionOpened(session);
  const oldClose = sessionClosed(session, 'ttl');
  await started.promise;
  sessionOpened(session, 'revive');
  await sessionClosed(session, 'explicit');
  slow.resolve();
  await oldClose;
  expect(measurements).toBe(2);
  expect(await sessions('close')).toHaveLength(2);
});

test('concurrent offline discards deduplicate a stale read resolving after the first snapshot', async () => {
  const firstMeasured = deferred<void>();
  const finishMeasurement = deferred<void>();
  const persisted: SessionRecord = {
    userId: 'alice',
    key: 'offline-race',
    createdAt: now - 100000,
    lastActivity: now - 100000,
    ttlMs: 60000,
  };
  records.set(persisted.key, persisted);
  let reads = 0;
  const store: SessionRecordStore = {
    async get(_userId: string, key: string) {
      const captured = records.get(key);
      reads++;
      return captured;
    },
    async put(record: SessionRecord) {
      records.set(record.key, record);
    },
    async touch(record: SessionRecord) {
      records.set(record.key, record);
    },
    async delete(_userId: string, key: string) {
      records.delete(key);
    },
    async list() {
      return [...records.values()];
    },
  };
  lifecycleHooks(store);
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => {
      firstMeasured.resolve();
      await finishMeasurement.promise;
      return snapshot;
    },
  );
  setStorageSnapshots({ measure, cached: () => undefined });
  const first = discardSession('alice', persisted.key);
  await firstMeasured.promise;
  const second = discardSession('alice', persisted.key);
  expect(second).toBe(first);
  expect(reads).toBe(1);
  finishMeasurement.resolve();
  await first;
  await second;
  expect(measure).toHaveBeenCalledTimes(1);
  expect(await sessions('close')).toHaveLength(1);
});

test.each([false, true])(
  'queued admission resumes after delayed snapshot cleanup (failure=%s)',
  async (fails: boolean) => {
    const slow = deferred<void>();
    const started = deferred<void>();
    setStorageSnapshots({
      cached: () => snapshot,
      async measure() {
        started.resolve();
        await slow.promise;
        return snapshot;
      },
    });
    const retention = new SessionRetention(
      {
        hasState: () => false,
        deleteAll: () => {
          if (fails) throw new Error('cleanup failed');
        },
        onSessionRetained: (userId: string, sessionId: string) =>
          sessionOpened({ userId, sessionId }),
        beforeSessionReleased: (
          userId: string,
          sessionId: string,
          reason: SessionCloseReason,
        ) => sessionClosed({ userId, sessionId }, reason),
        onSessionReleased: (
          userId: string,
          sessionId: string,
          reason: SessionCloseReason,
        ) => sessionReleased({ userId, sessionId }, reason),
        afterAsyncRemoval: () => door.poke(),
      },
      1,
    );
    const door = new Door({ capacity: 1, queueLength: 1, retention });
    const first = await door.admit('alice', 'A');
    if (!('admitted' in first)) throw new Error('First admission refused');
    let dispatched = false;
    const queued = door.admit('alice', 'B').then((result: AdmitResult) => {
      dispatched = true;
      return result;
    });
    first.admitted.release();
    await started.promise;
    expect(dispatched).toBe(false);
    expect(door.snapshot().queued).toBe(1);
    slow.resolve();
    const second = await queued;
    if (!('admitted' in second)) throw new Error('Queued admission refused');
    expect(retention.snapshot().cleanupFailed).toBe(fails ? 1 : 0);
    second.admitted.release();
    await closeUsageSessions();
  },
);

test('synchronous release claims a generation while close waits for delivery', async () => {
  sessionOpened(session);
  const finishDelivery = holdSessionDelivery(session);
  const measure = jest.fn<Promise<StorageSnapshot | undefined>, [UsageSession]>(
    async () => snapshot,
  );
  setStorageSnapshots({ measure, cached: () => snapshot });
  const closing = sessionClosed(session, 'explicit');
  await Promise.resolve();
  expect(measure).not.toHaveBeenCalled();
  sessionReleased(session, 'evicted');
  expect(await sessions('close')).toMatchObject([
    { values: { reason: 'evicted' } },
  ]);
  finishDelivery();
  await closing;
  expect(measure).not.toHaveBeenCalled();
  expect(await sessions('close')).toHaveLength(1);
});

test.each([
  ['openai', false],
  ['openai', true],
  ['anthropic', false],
  ['anthropic', true],
])(
  'thrown %s stream records failure (partial=%s)',
  async (protocol: string | boolean, partial: string | boolean) => {
    harness.stream = async function* () {
      if (partial) yield { ok: true, value: { content: 'partial answer' } };
      throw new Error('generator failed');
    };
    const response = await httpRun(
      protocol === 'openai' ? handleChatCompletions : handleAnthropicMessages,
      {
        model: 'm',
        stream: true,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect(response.status).toBe(200);
    expect(response.text).toContain('generator failed');
    if (partial) expect(response.text).toContain('partial answer');
    const found = await rows('x.hub.request');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      outcome: 'error',
      values: { endReason: 'error' },
    });
  },
);

test('many closed generations retain only capped oldest-dropped tombstones', async () => {
  setStorageSnapshots({
    cached: () => snapshot,
    async measure() {
      return snapshot;
    },
  });
  for (let i = 0; i < SESSION_TOMBSTONE_LIMIT + 20; i++) {
    const current = { userId: 'alice', sessionId: `bounded-${i}` };
    sessionOpened(current);
    if (i % 3 === 0) sessionReleased(current, 'ttl');
    else await sessionClosed(current, 'explicit');
  }
  expect(usageSessionBookkeepingForTest()).toEqual({
    live: 0,
    pending: 0,
    closing: 0,
    tombstones: SESSION_TOMBSTONE_LIMIT,
  });
  const before = (await sessions('close')).length;
  await sessionClosed(
    { userId: 'alice', sessionId: `bounded-${SESSION_TOMBSTONE_LIMIT + 19}` },
    'expired-offline',
    false,
  );
  expect(await sessions('close')).toHaveLength(before);
});

test.each([false, true])(
  'unreleased pipeline shutdown is bounded (usage=%s)',
  async (enabled: boolean) => {
    if (!enabled) await runtime.close(1000);
    const pipeline = await admitPipeline('alice', 'unreleased');
    if (!('admitted' in pipeline)) throw new Error('Admission refused');
    const releaseDelivery = holdSessionDelivery({
      userId: 'alice',
      sessionId: 'unreleased',
    });
    const started = Date.now();
    try {
      beginUsageShutdown();
      const deadline = started + 5000;
      await shutdownGatekeeper();
      await closeUsageSessions(Math.max(0, deadline - Date.now()));
      expect(Date.now() - started).toBeLessThan(enabled ? 5500 : 250);
      expect(pipeline.admitted.signal?.aborted).toBe(
        enabled ? true : undefined,
      );
      if (enabled) {
        expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
        expect(await sessions('close')).toMatchObject([
          { values: { reason: 'shutdown' } },
        ]);
      }
    } finally {
      releaseDelivery();
      pipeline.admitted.release();
    }
  },
  8000,
);

test('pipelined HTTP responses count only their own transport bytes', async () => {
  const firstBody = 'A'.repeat(4096);
  const secondBody = 'B'.repeat(29);
  let releaseFirst: () => void = () => {};
  const firstReady = new Promise<void>((resolve: () => void) => {
    releaseFirst = resolve;
  });
  let handled = 0;
  const app = express();
  const server = createServer(app);
  app.get('/', async (req: Request, res: Response) => {
    const index = ++handled;
    const measurement = measureRequest(req, res, session, 'openai', false);
    res.sendDate = false;
    res.setHeader(
      'Content-Length',
      index === 1 ? firstBody.length : secondBody.length,
    );
    if (index === 1) {
      res.write(firstBody.slice(0, 10));
      await firstReady;
      res.end(firstBody.slice(10));
    } else {
      expect(res.socket).toBeNull();
      res.end(secondBody);
      releaseFirst();
    }
    measurement?.finish();
  });
  await new Promise<void>((resolve: () => void) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const client = connect(address.port, '127.0.0.1');
  let wire = '';
  client.setEncoding('utf8');
  try {
    await new Promise<void>(
      (resolve: () => void, reject: (error: Error) => void) => {
        client.on('data', (chunk: string) => {
          wire += chunk;
        });
        client.on('error', reject);
        client.on('end', resolve);
        client.on('connect', () =>
          client.write(
            'GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
          ),
        );
      },
    );
    const split = wire.indexOf('HTTP/1.1', 1);
    expect(split).toBeGreaterThan(firstBody.length);
    const records = await rows('x.hub.request');
    expect(records).toHaveLength(2);
    expect(
      records
        .map((record: UsageRecord) => {
          if (record.kind !== 'x.hub.request') throw new Error('Wrong kind');
          return record.values.bytesWritten;
        })
        .map(Number)
        .sort((a: number, b: number) => a - b),
    ).toEqual(
      [
        Buffer.byteLength(wire.slice(0, split)),
        Buffer.byteLength(wire.slice(split)),
      ].sort((a: number, b: number) => a - b),
    );
  } finally {
    releaseFirst();
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void) =>
      server.close(() => resolve()),
    );
  }
});

test('shutdown finalizes both blocked closing generations before runtime shutdown', async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const finishFirst = deferred<void>();
  const finishSecond = deferred<void>();
  let calls = 0;
  setStorageSnapshots({
    cached: () => snapshot,
    async measure() {
      if (++calls === 1) {
        firstStarted.resolve();
        await finishFirst.promise;
      } else {
        secondStarted.resolve();
        await finishSecond.promise;
      }
      return snapshot;
    },
  });
  sessionOpened(session);
  const firstClose = sessionClosed(session, 'ttl');
  await firstStarted.promise;
  sessionOpened(session, 'revive');
  const secondClose = sessionClosed(session, 'explicit');
  await secondStarted.promise;
  beginUsageShutdown();
  await closeUsageSessions(0);
  expect(await sessions('close')).toMatchObject([
    { values: { reason: 'shutdown', ...snapshot } },
    { values: { reason: 'shutdown', ...snapshot } },
  ]);
  const record = jest.spyOn(hubRecords, 'sessionRecord');
  await runtime.close(1000);
  record.mockClear();
  finishFirst.resolve();
  finishSecond.resolve();
  await Promise.all([firstClose, secondClose]);
  expect(record).not.toHaveBeenCalled();
  expect(usageSessionBookkeepingForTest()).toMatchObject({
    live: 0,
    pending: 0,
    closing: 0,
  });
});

test.each(['   \n\t', '   hello   '])(
  'Anthropic stream counts non-whitespace content without retaining chunks (%j)',
  async (content: string) => {
    harness.stream = async function* () {
      yield { ok: true, value: { content: '   ' } };
      yield { ok: true, value: { content } };
    };
    await httpRun(handleAnthropicMessages, {
      model: 'm',
      max_tokens: 10,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(await rows('x.hub.request')).toMatchObject([
      { values: { messagesDelivered: /\S/.test(content) ? 1 : 0 } },
    ]);
  },
);

test('overlapping offline discards share a stalled read across tombstone eviction', async () => {
  const read = deferred<SessionRecord | undefined>();
  const get = jest.fn(
    (_userId: string, key: string): Promise<SessionRecord | undefined> =>
      key === 'stalled' ? read.promise : Promise.resolve(undefined),
  );
  lifecycleHooks({
    get,
    async put(_record: SessionRecord) {},
    async touch(_record: SessionRecord) {},
    async delete(_userId: string, _key: string) {},
    async list() {
      return [];
    },
  });
  const first = discardSession('alice', 'stalled');
  const second = discardSession('alice', 'stalled');
  expect(second).toBe(first);
  expect(get).toHaveBeenCalledTimes(1);
  for (let i = 0; i <= SESSION_TOMBSTONE_LIMIT; i++) {
    const current = { userId: 'alice', sessionId: `eviction-${i}` };
    sessionOpened(current);
    sessionReleased(current, 'ttl');
  }
  read.resolve({
    userId: 'alice',
    key: 'stalled',
    createdAt: 0,
    lastActivity: 0,
    ttlMs: 60000,
  });
  await Promise.all([first, second]);
  expect(
    (await sessions('close')).filter(
      (record: UsageRecord) => record.context.sessionId === 'stalled',
    ),
  ).toHaveLength(1);
});

test('disconnect after end while output is buffered records disconnected', async () => {
  const closed = deferred<void>();
  const app = express();
  app.get('/', (req: Request, res: Response) => {
    const measurement = measureRequest(req, res, session, 'openai', false);
    measurement?.admitted();
    measurement?.deliverOnResponseEnd();
    res.once('close', () => closed.resolve());
    res.socket?.cork();
    res.end('x'.repeat(32 * 1024 * 1024));
    expect(res.writableEnded).toBe(true);
    expect(res.writableFinished).toBe(false);
    measurement?.finish();
    // Deliver the premature transport close while end() still has buffered output.
    res.emit('close');
    res.destroy();
  });
  const server = createServer(app);
  await new Promise<void>((resolve: () => void) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const client = connect(address.port, '127.0.0.1');
  client.on('error', (_error: Error) => {});
  client.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
  try {
    await closed.promise;
    expect(await rows('x.hub.request')).toMatchObject([
      { values: { endReason: 'disconnected', messagesDelivered: 0 } },
    ]);
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void) =>
      server.close(() => resolve()),
    );
  }
});

test('usage-off pipelines without a door preserve undefined shutdown signals', async () => {
  await runtime.close(1000);
  const result = await admitPipeline('alice', 'off-no-door');
  if (!('admitted' in result)) throw new Error('Admission refused');
  expect(result.admitted.signal).toBeUndefined();
  expect(shutdownGatekeeper()).toBeUndefined();
  expect(result.admitted.signal).toBeUndefined();
  result.admitted.release();
});
