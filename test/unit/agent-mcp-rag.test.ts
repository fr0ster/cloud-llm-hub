jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
jest.mock('../../srv/agent-manager', () => ({
  getCollectionRegistry: jest.fn(),
  getQueryEmbedder: jest.fn(),
  isProvidersReady: () => false,
  forgetSessionDestination: () => {},
}));
jest.mock('../../srv/lib/session-lifecycle', () => ({
  resolveSession: jest.fn(),
}));

jest.mock('../../srv/lib/usage/runtime', () => ({
  usageRuntime: () =>
    mockForSession.getMockImplementation()
      ? { forSession: mockForSession, enabled: () => false }
      : undefined,
}));

import {
  type CallOptions,
  type IUsageRecorder,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { z } from 'zod';
import {
  getCollectionRegistry,
  getQueryEmbedder,
} from '../../srv/agent-manager';
import { executeRagMcpTool, type RagMcpTool } from '../../srv/agent-mcp-rag';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import {
  configureCollectionOverridePersistence,
  deleteCollectionOverrides,
} from '../../srv/lib/collection-toggle';
import { theRetention } from '../../srv/lib/gatekeeper';
import {
  LongSessionRegistry,
  longSessions,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { resolveSession } from '../../srv/lib/session-lifecycle';
import {
  CollectionRegistry,
  CollectionSearchRag,
} from '../../srv/rag-collections';

const mockForSession = jest.fn<
  IUsageRecorder,
  [{ userId: string; sessionId: string }]
>();
let registry: CollectionRegistry;
let sid: string;
let other: string;
const cid = userCollectionId('notes', 'alice');
const second = userCollectionId('second', 'alice');
const inputs = {
  rag_search: { query: 'needle' },
  rag_read: { collection: 'notes', id: 'visible' },
  collections_list: {},
  collection_set_enabled: { collection: 'notes', enabled: false },
  collection_records: { collection: 'notes' },
  record_set_enabled: { collection: 'notes', id: 'visible', enabled: false },
};
const names: RagMcpTool[] = [
  'rag_search',
  'rag_read',
  'collections_list',
  'collection_set_enabled',
  'collection_records',
  'record_set_enabled',
];
const call = (
  name: RagMcpTool,
  args: Parameters<typeof executeRagMcpTool>[3] = {},
  user = 'alice',
) =>
  executeRagMcpTool({ headers: {} }, user, name, {
    ...inputs[name],
    session: sid,
    ...args,
  });
const responseSchema = z.object({
  hits: z
    .array(
      z.object({
        collection: z.string(),
        id: z.string(),
        text: z.string(),
        score: z.number(),
      }),
    )
    .default([]),
  collections: z
    .array(
      z.object({
        id: z.string(),
        enabled: z.boolean(),
        defaultEnabled: z.boolean(),
      }),
    )
    .default([]),
  records: z.array(z.object({ id: z.string() })).default([]),
  offset: z.number().optional(),
  total: z.number().optional(),
  next: z.number().optional(),
  text: z.string().optional(),
  updated: z.number().optional(),
});
const body = async (result: ReturnType<typeof call>) =>
  responseSchema.parse(JSON.parse((await result).content[0].text));
function open(user = 'alice') {
  const s = longSessions().open(user, {});
  if ('refused' in s) throw new Error(s.refused);
  return s.key;
}
beforeEach(async () => {
  jest.mocked(getQueryEmbedder).mockReturnValue(undefined);
  mockForSession.mockReset();
  registry = new CollectionRegistry();
  jest.mocked(getCollectionRegistry).mockReturnValue(registry);
  jest
    .mocked(resolveSession)
    .mockImplementation(async (user, key) => longSessions().get(user, key));
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      { onClose: async () => {} },
    ),
  );
  sid = open();
  other = open();
  for (const [id, logicalId] of [
    [cid, 'notes'],
    [second, 'second'],
  ]) {
    await registry.createCollection({
      id,
      logicalId,
      scope: 'user',
      owner: 'alice',
      displayName: logicalId,
      description: '',
    });
    await registry.addDocument(id, {
      id: 'visible',
      text: 'needle visible title\nneedle visible body',
      metadata: {},
    });
    await registry.addDocument(id, {
      id: 'hidden',
      text: 'needle SECRET TITLE\nSECRET BODY',
      metadata: { enabled: false, title: 'SECRET ATTRIBUTE' },
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  deleteCollectionOverrides('alice', sid);
  deleteCollectionOverrides('alice', other);
  configureCollectionOverridePersistence(async () => {});
  setLongSessionsForTest(undefined);
});

test.each(names)('%s happy path', async (name) => {
  expect((await call(name)).isError).toBeUndefined();
});
test.each(names)('%s refuses a closed session', async (name) => {
  await longSessions().close('alice', sid, 'explicit');
  expect(await call(name)).toMatchObject({ isError: true });
});
test.each(names)('%s refuses another caller session', async (name) => {
  expect(await call(name, {}, 'bob')).toMatchObject({ isError: true });
});
test.each(names)(
  '%s refuses a session whose retention is closing',
  async (name) => {
    // A retained lease keeps close in flight while the MCP request is presented.
    const lease = theRetention().lease('alice', sid, 'rag', {
      presented: true,
    });
    if ('refused' in lease) throw new Error(lease.refused);
    const closing = theRetention().close('alice', sid);
    try {
      expect(await call(name)).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'SESSION_CLOSED' }],
      });
    } finally {
      lease.release();
      await closing;
    }
  },
);
test('anonymous identity cannot reach legacy anonymous-owned records', async () => {
  const id = userCollectionId('legacy', 'anonymous');
  await registry.createCollection({
    id,
    logicalId: 'legacy',
    owner: 'anonymous',
    scope: 'user',
    displayName: 'legacy',
    description: '',
  });
  await registry.addDocument(id, {
    id: 'record',
    text: 'legacy secret',
    metadata: {},
  });
  expect(
    await call(
      'rag_read',
      { session: open('anonymous'), collection: id, id: 'record' },
      'anonymous',
    ),
  ).toMatchObject({ isError: true });
});
test.each(names.filter((name) => name !== 'collections_list'))(
  '%s refuses another owner collection',
  async (name) => {
    const bobSession = open('bob');
    expect(
      await call(
        name,
        { session: bobSession, collection: cid, collections: [cid] },
        'bob',
      ),
    ).toMatchObject({ isError: true });
  },
);
test('list does not reveal another owner collections or another session collections', async () => {
  const id = sessionCollectionId('scratch', 'alice', other);
  await registry.createCollection({
    id,
    logicalId: 'scratch',
    scope: 'session',
    sessionId: other,
    owner: 'alice',
    displayName: 'scratch',
    description: '',
  });
  expect(
    (await body(call('collections_list'))).collections.map(
      (c: { id: string }) => c.id,
    ),
  ).toEqual([cid, second]);
  expect(
    await body(call('collections_list', { session: open('bob') }, 'bob')),
  ).toMatchObject({ collections: [] });
});
test('search excludes disabled records, resolves names and returns usable record ids', async () => {
  const result = await call('rag_search', { collections: ['notes'] });
  expect(result.content[0].text).not.toContain('SECRET');
  const parsed = await body(Promise.resolve(result));
  expect(parsed.hits).toHaveLength(1);
  expect(parsed.hits[0]).toMatchObject({ collection: cid, id: 'visible' });
  expect(
    await body(call('rag_read', { collection: cid, id: parsed.hits[0].id })),
  ).toMatchObject({ text: 'needle visible title\nneedle visible body' });
  expect(await body(call('rag_search', { collections: [] }))).toMatchObject({
    hits: [],
  });
});
test('read and record lists never reveal disabled content or metadata titles', async () => {
  const result = await call('rag_read', { id: 'hidden' });
  expect(result.content[0].text).toBe(
    JSON.stringify({
      id: 'hidden',
      attributes: { enabled: false },
      reason: 'record-disabled',
    }),
  );
  expect((await call('collection_records')).content[0].text).not.toContain(
    'SECRET',
  );
});
test('session toggle affects the next search only in that session and is persisted', async () => {
  const persist = jest.fn(async () => {});
  configureCollectionOverridePersistence(persist);
  await call('collection_set_enabled');
  expect(persist).toHaveBeenCalledWith('alice', sid);
  expect(
    (await body(call('rag_search'))).hits.map(
      (h: { collection: string }) => h.collection,
    ),
  ).toEqual([second]);
  expect(
    (await body(call('rag_search', { session: other }))).hits,
  ).toHaveLength(2);
  expect((await call('rag_read')).content[0].text).not.toContain('needle');
  expect((await call('collection_records')).content[0].text).not.toContain(
    'needle',
  );
  expect((await body(call('collections_list'))).collections[0]).toMatchObject({
    enabled: false,
    defaultEnabled: true,
  });
});
test('read pages use character offsets and stop at the end', async () => {
  expect(await body(call('rag_read', { offset: 7, limit: 5 }))).toMatchObject({
    offset: 7,
    text: 'visib',
    next: 12,
    total: 40,
  });
  expect(await body(call('rag_read', { offset: 100 }))).toMatchObject({
    offset: 100,
    text: '',
  });
  expect(
    await body(call('collection_records', { offset: 1, limit: 1 })),
  ).toMatchObject({ total: 2, records: [{ id: 'hidden' }] });
});
test.each([
  ['rag_search', { k: 21 }],
  ['rag_search', { k: 0 }],
  ['rag_search', { query: '' }],
  ['rag_read', { limit: 32001 }],
  ['rag_read', { offset: -1 }],
  ['rag_read', { limit: 0 }],
  ['collection_records', { limit: 201 }],
  ['collection_records', { offset: 0.5 }],
  ['record_set_enabled', { source: 'file' }],
  ['record_set_enabled', { id: '' }],
] satisfies [RagMcpTool, Parameters<typeof executeRagMcpTool>[3]][])(
  '%s invalid arguments return tool errors: %j',
  async (name, args) => {
    expect((await call(name, args)).isError).toBe(true);
  },
);
test('record mutations affect search and all chunks of a selected upload only', async () => {
  await call('record_set_enabled');
  expect(
    (await body(call('rag_search', { collections: ['notes'] }))).hits,
  ).toEqual([]);
  for (const [id, uploadId] of [
    ['a', 'upload'],
    ['b', 'upload'],
    ['c', 'other'],
  ])
    await registry.addDocument(cid, {
      id,
      text: 'needle',
      metadata: { source: 'file', uploadId, chunkIndex: 0 },
    });
  expect(
    await body(
      call('record_set_enabled', {
        id: undefined,
        source: 'file',
        uploadId: 'upload',
      }),
    ),
  ).toMatchObject({ updated: 2 });
  expect((await registry.getDocument(cid, 'a'))?.enabled).toBe(false);
  expect((await registry.getDocument(cid, 'c'))?.enabled).toBe(true);
});
test('header session is accepted and absence is refused', async () => {
  expect(
    (
      await executeRagMcpTool(
        { headers: { 'x-clh-session': sid } },
        'alice',
        'collections_list',
        {},
      )
    ).isError,
  ).toBeUndefined();
  expect(
    (await executeRagMcpTool({ headers: {} }, 'alice', 'collections_list', {}))
      .isError,
  ).toBe(true);
});
test.each(['SESSION_LIMIT', 'SESSION_STORE_UNAVAILABLE'])(
  'session resolution preserves %s as a tool error',
  async (refused) => {
    jest
      .mocked(resolveSession)
      .mockRejectedValueOnce(
        Object.assign(new Error('session unavailable'), { refused }),
      );
    expect(await call('collections_list')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: refused }],
    });
  },
);
test('character paging applies its default and maximum accepted limit', async () => {
  await registry.addDocument(cid, {
    id: 'long',
    text: 'x'.repeat(40000),
    metadata: {},
  });
  expect((await body(call('rag_read', { id: 'long' }))).text).toHaveLength(
    8000,
  );
  const page = await body(call('rag_read', { id: 'long', limit: 32000 }));
  expect(page.text).toHaveLength(32000);
  expect(page.next).toBe(32000);
  expect(
    (await call('collection_records', { limit: 200 })).isError,
  ).toBeUndefined();
  expect((await call('rag_search', { k: 20 })).isError).toBeUndefined();
});
test('search bounds the serialized response and marks cuts', async () => {
  await registry.addDocument(cid, {
    id: 'large',
    text: 'needle "\\\n'.repeat(10000),
    metadata: {},
  });
  const result = await call('rag_search', { collections: ['notes'] });
  expect(result.content[0].text.length).toBeLessThanOrEqual(24000);
  expect(result.content[0].text).toContain('[truncated]');
});

test('read and lists use normalized safe attributes for visible and invisible records', async () => {
  await registry.addDocument(cid, {
    id: 'metadata',
    text: 'public text',
    metadata: { internal: 'PRIVATE'.repeat(10000), source: 'file' },
  });
  const read = await call('rag_read', { id: 'metadata', limit: 1 });
  expect(JSON.parse(read.content[0].text)).toEqual({
    id: 'metadata',
    offset: 0,
    total: 11,
    next: 1,
    text: 'p',
    attributes: { enabled: true },
  });
  const records = await call('collection_records');
  expect(records.content[0].text).not.toContain('PRIVATE');
  expect(JSON.parse(records.content[0].text)).toMatchObject({
    records: [
      { id: 'visible', attributes: { enabled: true } },
      {
        id: 'hidden',
        attributes: { enabled: false },
        reason: 'record-disabled',
      },
      { id: 'metadata', attributes: { enabled: true } },
    ],
  });
  await call('collection_set_enabled');
  expect(
    JSON.parse((await call('rag_read', { id: 'metadata' })).content[0].text),
  ).toEqual({
    id: 'metadata',
    attributes: { enabled: true },
    reason: 'collection-disabled',
  });
});

test.each(['store', 'query-result', 'query-throw', 'missing-store'])(
  'search skips a failing collection (%s) and bounds errors with healthy hits',
  async (failure) => {
    const message = 'unavailable "\\\n'.repeat(10000);
    const getStore = registry.getRagStore.bind(registry);
    if (failure === 'store' || failure === 'missing-store') {
      jest.spyOn(registry, 'getRagStore').mockImplementation(async (id) => {
        if (id === cid) {
          if (failure === 'store') throw new Error(message);
          return null;
        }
        return getStore(id);
      });
    } else {
      const query = CollectionSearchRag.prototype.query;
      jest
        .spyOn(CollectionSearchRag.prototype, 'query')
        .mockImplementationOnce(async () => {
          if (failure === 'query-throw') throw new Error(message);
          return { ok: false, error: new RagError(message, 'QUERY_ERROR') };
        })
        .mockImplementation(query);
    }
    await registry.addDocument(second, {
      id: 'large',
      text: 'needle "\\\n'.repeat(10000),
      metadata: {},
    });
    const result = await call('rag_search');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeLessThanOrEqual(24000);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      unavailable: [{ collection: cid, error: expect.any(String) }],
    });
    expect(
      (await body(Promise.resolve(result))).hits.every(
        (hit) => hit.collection === second,
      ),
    ).toBe(true);
    expect((await body(Promise.resolve(result))).hits.length).toBeGreaterThan(
      0,
    );
  },
);

test('search supplies embedding usage with retrieval context and caller attribution', async () => {
  const sink = memorySink({ limit: 20 });
  const recorder = createUsageRecorder({ transport: directTransport(sink) });
  mockForSession.mockImplementation((session) => recorder.with(session));
  const embedQuery = jest.fn(async (_text: string, options?: CallOptions) => {
    options?.usage?.record({
      kind: 'x.test.embedding',
      context: {},
      outcome: 'ok',
      values: { tokens: 7 },
    });
    return { vector: [1], usage: { promptTokens: 7, totalTokens: 7 } };
  });
  jest.mocked(getQueryEmbedder).mockReturnValue({ embedQuery });
  const query = CollectionSearchRag.prototype.query;
  jest
    .spyOn(CollectionSearchRag.prototype, 'query')
    .mockImplementation(async function (
      this: CollectionSearchRag,
      embedding,
      k,
      filter,
    ) {
      await embedding.toVector();
      return query.call(this, embedding, k, filter);
    });
  const result = await executeRagMcpTool(
    { headers: {} },
    'alice',
    'rag_search',
    { session: sid, query: 'needle' },
    'trace',
  );
  expect(result.isError).toBeUndefined();
  expect(mockForSession).toHaveBeenCalledWith({
    userId: 'alice',
    sessionId: sid,
  });
  expect(embedQuery).toHaveBeenCalledTimes(1);
  await recorder.flush(1000);
  const records = [];
  for await (const record of sink.read({
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  }))
    records.push(record);
  expect(records).toMatchObject([
    {
      context: {
        role: 'embedding',
        component: 'collection-retrieval',
        userId: 'alice',
        sessionId: sid,
        requestId: 'trace',
        traceId: 'trace',
      },
    },
  ]);
  await recorder.close(1000);
});
