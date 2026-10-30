import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { ragMcpSchemas, registerRagMcpTools } from '../../srv/agent-mcp-rag';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { runWithProfileTools } from '../../srv/request-session';

const mockWriteIdentity = { admin: false };
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: { user: { is: () => mockWriteIdentity.admin } },
  },
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
const inputs: Record<RagMcpTool, Parameters<typeof executeRagMcpTool>[3]> = {
  collection_create: { name: 'new-notes', scope: 'user' },
  collection_delete: { collection: 'notes' },
  record_add: { collection: 'notes', text: 'new record' },
  record_update: {
    collection: 'notes',
    record: 'visible',
    text: 'replacement',
  },
  record_delete: { collection: 'notes', record: 'visible' },
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
  mockWriteIdentity.admin = false;
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

test('profile RAG MCP registration omits mutations and forged calls never resolve a session or touch storage', async () => {
  const server = new McpServer({ name: 'profile-test', version: '1' });
  const register = jest.spyOn(server, 'registerTool');
  const collection = jest.spyOn(registry, 'getCollection');
  jest.mocked(resolveSession).mockClear();
  await runWithProfileTools(
    new AgentToolPermissions(['rag_read']),
    async () => {
      registerRagMcpTools(
        server,
        express.request,
        'alice',
        (_name, run) => run,
      );
      expect(register.mock.calls.map((args) => args[0])).toEqual(['rag_read']);
      expect(
        await call('record_set_enabled', { id: 'visible', enabled: false }),
      ).toMatchObject({ isError: true });
      expect(jest.mocked(resolveSession)).not.toHaveBeenCalled();
      expect(collection).not.toHaveBeenCalled();
    },
  );
  await server.close();
});

test('MCP enablement never writes an agents copy owned by its caller', async () => {
  const id = userCollectionId('my-agents', 'alice');
  await registry.createCollection({
    id,
    logicalId: 'my-agents',
    displayName: '',
    description: '',
    scope: 'user',
    owner: 'alice',
    collectionKind: 'agents',
  });
  await registry.addDocument(id, {
    id: 'analyst',
    text: 'prompt',
    metadata: {
      canonicalKey: 'analyst',
      name: 'analyst',
      kind: 'profile',
      description: 'analysis',
      tools: 'read-only',
      result: 'report',
    },
  });
  for (const name of [
    'collection_set_enabled',
    'record_set_enabled',
  ] as const) {
    const result = await call(name, {
      collection: id,
      id: 'analyst',
      enabled: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TOOL_FORBIDDEN');
  }
  expect((await registry.getDocument(id, 'analyst'))?.enabled).toBe(true);
});

test('MCP agent reads redact externally disabled current records', async () => {
  await registry.createCollection({
    id: 'agents',
    logicalId: 'agents',
    displayName: 'Agents',
    description: '',
    scope: 'global',
    collectionKind: 'agents',
  });
  await registry.addDocument('agents', {
    id: 'analyst',
    text: 'private stale prompt',
    metadata: {
      enabled: true,
      canonicalKey: 'analyst',
      name: 'analyst',
      kind: 'profile',
      description: 'private description',
      tools: 'all',
      result: 'report',
    },
  });
  const meta = await registry.getCollection('agents');
  if (!meta) throw new Error('Missing agents');
  jest.spyOn(registry, 'readAgentCollection').mockResolvedValue({
    meta,
    documents: [
      {
        id: 'analyst',
        text: 'private current prompt',
        createdAt: '',
        metadata: { enabled: false },
      },
    ],
  });
  for (const name of ['rag_read', 'collection_records'] as const) {
    const result = await call(name, { collection: 'agents', id: 'analyst' });
    expect(result.content[0].text).toContain('record-disabled');
    expect(result.content[0].text).not.toContain('private');
  }
});

const writeNames = [
  'collection_create',
  'collection_delete',
  'record_add',
  'record_update',
  'record_delete',
] satisfies RagMcpTool[];
const writePayload = z.object({
  result: z.string(),
  collection: z.string().optional(),
  record: z.string().optional(),
  error: z
    .object({ code: z.string(), status: z.number(), message: z.string() })
    .optional(),
});

function assertWriteResult(result: Awaited<ReturnType<typeof call>>) {
  const value = writePayload.parse(result.structuredContent);
  expect(result.content).toEqual([{ type: 'text', text: value.result }]);
  expect(result.isError === true).toBe(value.error !== undefined);
  return value;
}

test.each(writeNames)(
  '%s returns matching typed content and physical ids',
  async (name: RagMcpTool) => {
    const result = await call(name);
    const value = assertWriteResult(result);
    expect(result.isError).toBeUndefined();
    expect(value.collection).toContain('__u_');
  },
);

test('create normalizes identities and duplicate creation is idempotent', async () => {
  expect(
    (await call('collection_create', { name: ' Notes ' })).structuredContent,
  ).toMatchObject({
    collection: cid,
    name: 'notes',
    scope: 'user',
    created: false,
  });
  const result = await call('collection_create', { scope: 'session' });
  expect(result.structuredContent).toMatchObject({
    collection: sessionCollectionId('new-notes', 'alice', sid),
    created: true,
  });
  expect(
    await registry.getCollection(
      sessionCollectionId('new-notes', 'alice', sid),
    ),
  ).toMatchObject({
    owner: 'alice',
    sessionId: sid,
    expiresAt: expect.any(Number),
  });
});

test('text writes preserve whitespace, optional empty attributes, and unrelated metadata', async () => {
  const add = assertWriteResult(
    await call('record_add', {
      text: '  body\n ',
      title: '',
      source: 'https://example.org/reference',
    }),
  );
  if (!add.record) throw new Error('Missing record id');
  expect(add.record).toMatch(/^[a-f0-9-]{36}$/);
  expect(await registry.getDocument(cid, add.record)).toMatchObject({
    text: '  body\n ',
    metadata: { title: '', source: 'https://example.org/reference' },
  });
  await registry.updateDocument(cid, add.record, {
    metadata: { enabled: false, uploadId: 'old', chunkIndex: 2 },
  });
  const before = await registry.getDocument(cid, add.record);
  await call('record_update', {
    record: add.record,
    text: 'replacement',
    title: 'New',
  });
  expect(await registry.getDocument(cid, add.record)).toMatchObject({
    text: 'replacement',
    createdAt: before?.createdAt,
    metadata: {
      title: 'New',
      source: 'https://example.org/reference',
      enabled: false,
      uploadId: 'old',
      chunkIndex: 2,
    },
  });
  await call('record_delete', { record: add.record });
  expect(await registry.getDocument(cid, add.record)).toBeNull();
});

test('settled writes are immediately visible in read and record listing', async () => {
  const added = assertWriteResult(
    await call('record_add', { text: 'visible now' }),
  );
  expect(await body(call('rag_read', { id: added.record }))).toMatchObject({
    text: 'visible now',
  });
  await call('record_update', { record: added.record, text: 'updated now' });
  expect(await body(call('rag_read', { id: added.record }))).toMatchObject({
    text: 'updated now',
  });
  expect(
    (await body(call('collection_records'))).records.map(
      (record: { id: string }) => record.id,
    ),
  ).toContain(added.record);
});

test.each(writeNames)(
  '%s rejects visible agents and hides foreign agents',
  async (name: RagMcpTool) => {
    const target = userCollectionId('agents-copy', 'alice');
    await registry.createCollection({
      id: target,
      logicalId: 'agents-copy',
      displayName: 'Agents',
      description: '',
      scope: 'user',
      owner: 'alice',
      collectionKind: 'agents',
    });
    const result = assertWriteResult(
      await call(
        name,
        name === 'collection_create'
          ? { name: ' Agents-copy ' }
          : { collection: target },
      ),
    );
    expect(result.error).toMatchObject({ code: 'TOOL_FORBIDDEN', status: 403 });
    if (name !== 'collection_create')
      expect(
        assertWriteResult(
          await call(name, { collection: target, session: open('bob') }, 'bob'),
        ).error,
      ).toMatchObject({ code: 'COLLECTION_NOT_FOUND', status: 404 });
  },
);

test.each(writeNames)(
  '%s refuses unauthenticated, missing and closed sessions before writing',
  async (name: RagMcpTool) => {
    const mutate = jest.spyOn(registry, 'getOrCreateCollection');
    expect(
      assertWriteResult(await call(name, {}, 'anonymous')).error?.code,
    ).toBe('UNAUTHENTICATED');
    expect(
      assertWriteResult(await call(name, { session: undefined })).error?.code,
    ).toBe('SESSION_REQUIRED');
    await longSessions().close('alice', sid, 'explicit');
    expect(assertWriteResult(await call(name)).error?.code).toBe(
      'SESSION_NOT_FOUND',
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

test.each(['record_update', 'record_delete'] satisfies RagMcpTool[])(
  '%s reports missing record',
  async (name: RagMcpTool) => {
    expect(
      assertWriteResult(await call(name, { record: 'absent' })).error,
    ).toMatchObject({ code: 'RECORD_NOT_FOUND', status: 404 });
  },
);

test.each([
  'collection_delete',
  'record_add',
  'record_update',
  'record_delete',
] satisfies RagMcpTool[])(
  '%s requires collection existence and isolates sessions',
  async (name: RagMcpTool) => {
    expect(
      assertWriteResult(await call(name, { collection: 'absent' })).error,
    ).toMatchObject({ code: 'COLLECTION_NOT_FOUND', status: 404 });
    const created = assertWriteResult(
      await call('collection_create', { scope: 'session' }),
    );
    expect(
      assertWriteResult(
        await call(name, { collection: created.collection, session: other }),
      ).error?.status,
    ).toBe(404);
  },
);

test.each(writeNames)(
  '%s rejects additional fields before session or storage access',
  async (name: RagMcpTool) => {
    const resolve = jest.mocked(resolveSession).mockClear();
    const result = await executeRagMcpTool({ headers: {} }, 'alice', name, {
      ...inputs[name],
      session: sid,
      ...{ owner: 'forged' },
    });
    expect(assertWriteResult(result).error?.code).toBe('INVALID_ARGUMENT');
    expect(resolve).not.toHaveBeenCalled();
  },
);

test('write argument limit counts UTF-8 and JSON escaping at the exact boundary', async () => {
  const max = 10 * 1024 * 1024;
  const input = { collection: cid, session: sid, text: '' };
  const overhead = Buffer.byteLength(JSON.stringify(input));
  const text = '\u00e9'.repeat(Math.floor((max - overhead) / 2));
  const write = jest.spyOn(registry, 'addDocument');
  expect(
    (
      await executeRagMcpTool({ headers: {} }, 'alice', 'record_add', {
        ...input,
        text,
      })
    ).isError,
  ).toBeUndefined();
  const count = write.mock.calls.length;
  expect(
    assertWriteResult(
      await executeRagMcpTool({ headers: {} }, 'alice', 'record_add', {
        ...input,
        text: `${text}xx`,
      }),
    ).error?.code,
  ).toBe('PAYLOAD_TOO_LARGE');
  expect(
    assertWriteResult(await call('record_add', { text: '\n'.repeat(max / 2) }))
      .error?.code,
  ).toBe('PAYLOAD_TOO_LARGE');
  expect(write).toHaveBeenCalledTimes(count);
});

test('write errors preserve backend codes and separate embedding and storage failures', async () => {
  const write = jest.spyOn(registry, 'addDocument');
  write.mockRejectedValueOnce(
    new RagError('backend rejected', 'CUSTOM_STORE_ERROR'),
  );
  expect(assertWriteResult(await call('record_add')).error).toMatchObject({
    code: 'CUSTOM_STORE_ERROR',
    status: 400,
  });
  write.mockRejectedValueOnce(new Error('embedding failed'));
  expect(assertWriteResult(await call('record_add')).error?.code).toBe(
    'EMBEDDING_FAILED',
  );
  write.mockRejectedValueOnce(new Error('storage failed'));
  expect(assertWriteResult(await call('record_add')).error?.code).toBe(
    'BACKEND_ERROR',
  );
});

test('all writes register with output schemas and preserve structured results through callback wrappers', async () => {
  const server = new McpServer({ name: 'writes', version: '1' });
  const register = jest.spyOn(server, 'registerTool');
  const measured: string[] = [];
  registerRagMcpTools(
    server,
    express.request,
    'alice',
    (name: RagMcpTool, run) => async (args) => {
      measured.push(name);
      return run(args);
    },
  );
  for (const name of writeNames)
    expect(
      register.mock.calls.find((args) => args[0] === name)?.[1],
    ).toHaveProperty('outputSchema');
  expect(register.mock.calls.map((args) => args[0])).toEqual(
    expect.arrayContaining(writeNames),
  );
  expect(measured).toEqual([]);
  await server.close();
});

test('SDK rejects schema violations before measurement and measures semantic errors', async () => {
  const server = new McpServer({ name: 'invalid-writes-sdk', version: '1' });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  type ToolArgs = Parameters<typeof executeRagMcpTool>[3];
  type ToolResult = Awaited<ReturnType<typeof executeRagMcpTool>>;
  const measured: RagMcpTool[] = [];
  registerRagMcpTools(
    server,
    express.request,
    'alice',
    (name: RagMcpTool, run: (args: ToolArgs) => Promise<ToolResult>) =>
      async (args: ToolArgs): Promise<ToolResult> => {
        const result = await run(args);
        measured.push(name);
        return result;
      },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const writes = [
      jest.spyOn(registry, 'getOrCreateCollection'),
      jest.spyOn(registry, 'deleteCollection'),
      jest.spyOn(registry, 'addDocument'),
      jest.spyOn(registry, 'updateDocument'),
      jest.spyOn(registry, 'deleteDocument'),
    ];
    const schemaCases: {
      name: RagMcpTool;
      arguments: Record<string, string | number>;
    }[] = [
      { name: 'record_add', arguments: { collection: cid } },
      { name: 'record_add', arguments: { collection: cid, text: 42 } },
      { name: 'record_add', arguments: { collection: cid, text: '' } },
      {
        name: 'record_update',
        arguments: { collection: cid, record: 'visible', text: '' },
      },
      {
        name: 'collection_delete',
        arguments: { collection: cid, extra: 'rejected' },
      },
      {
        name: 'record_delete',
        arguments: { collection: cid, record: 'visible', extra: 'rejected' },
      },
      {
        name: 'collection_create',
        arguments: { name: 'notes', scope: 'global' },
      },
    ];
    for (const entry of schemaCases) {
      const result = await client.callTool({
        name: entry.name,
        arguments: { session: sid, ...entry.arguments },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('Input validation error'),
        },
      ]);
      expect(measured).toEqual([]);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    }
    const cases = [
      {
        name: 'record_add' as const,
        arguments: { collection: cid, text: 'x'.repeat(10 * 1024 * 1024) },
        code: 'PAYLOAD_TOO_LARGE',
        status: 413,
      },
      {
        name: 'collection_create' as const,
        arguments: { name: 'reserved__name', scope: 'user' },
        code: 'INVALID_ARGUMENT',
        status: 400,
      },
    ];
    for (const entry of cases) {
      const count = measured.length;
      const result = await client.callTool({
        name: entry.name,
        arguments: { session: sid, ...entry.arguments },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          result: expect.any(String),
          error: { code: entry.code, status: entry.status },
        },
      });
      const payload = writePayload.parse(result.structuredContent);
      expect(payload.result.length).toBeGreaterThan(0);
      expect(result.content).toEqual([{ type: 'text', text: payload.result }]);
      expect(measured.slice(count)).toEqual([entry.name]);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('SDK lists object output schemas and round-trips success and backend errors', async () => {
  const server = new McpServer({ name: 'writes-sdk', version: '1' });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  registerRagMcpTools(
    server,
    express.request,
    'alice',
    (_name: RagMcpTool, run) => run,
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    for (const name of writeNames) {
      const tool = listed.tools.find((tool) => tool.name === name);
      expect(tool?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(tool?.inputSchema.properties?.session).toMatchObject({
        type: 'string',
        minLength: 1,
      });
      for (const field of tool?.inputSchema.required ?? [])
        if (field !== 'scope')
          expect(tool?.inputSchema.properties?.[field]).toMatchObject({
            type: 'string',
            minLength: 1,
          });
      expect(tool?.outputSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['result']),
      });
    }
    expect(
      listed.tools.find((tool) => tool.name === 'collection_create')
        ?.inputSchema.properties?.scope,
    ).toMatchObject({ enum: ['user', 'session'] });
    const result = await client.callTool({
      name: 'record_add',
      arguments: { session: sid, collection: cid, text: 'SDK text' },
    });
    const parsed = writePayload.parse(result.structuredContent);
    expect(parsed.collection).toBe(cid);
    expect(result.content).toEqual([{ type: 'text', text: parsed.result }]);
    jest
      .spyOn(registry, 'addDocument')
      .mockRejectedValueOnce(new Error('store rejected'));
    const failed = await client.callTool({
      name: 'record_add',
      arguments: { session: sid, collection: cid, text: 'SDK text' },
    });
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        result: 'store rejected',
        error: { code: 'BACKEND_ERROR' },
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test.each([false, true])(
  'all writes reject visible global agents regardless of admin=%s',
  async (admin: boolean) => {
    mockWriteIdentity.admin = admin;
    await registry.createCollection({
      id: 'agents-global',
      logicalId: 'agents-global',
      displayName: 'Agents',
      description: '',
      scope: 'global',
      collectionKind: 'agents',
    });
    for (const name of writeNames.filter(
      (tool: RagMcpTool) => tool !== 'collection_create',
    )) {
      expect(
        assertWriteResult(await call(name, { collection: 'agents-global' }))
          .error,
      ).toMatchObject({ code: 'TOOL_FORBIDDEN', status: 403 });
    }
  },
);

test('writes use explicit session, header, then cookie precedence', async () => {
  const input = { name: 'precedence', scope: 'session' as const };
  const execute = (
    headers: { 'x-clh-session'?: string; cookie?: string },
    explicit?: string,
  ) =>
    executeRagMcpTool({ headers }, 'alice', 'collection_create', {
      ...input,
      session: explicit,
    });
  expect(
    (
      await execute(
        { 'x-clh-session': other, cookie: `clh_session=${other}` },
        sid,
      )
    ).structuredContent,
  ).toMatchObject({
    collection: sessionCollectionId('precedence', 'alice', sid),
  });
  expect(
    (await execute({ 'x-clh-session': other, cookie: `clh_session=${sid}` }))
      .structuredContent,
  ).toMatchObject({
    collection: sessionCollectionId('precedence', 'alice', other),
  });
  expect(
    (await execute({ cookie: `clh_session=${sid}` })).structuredContent,
  ).toMatchObject({
    collection: sessionCollectionId('precedence', 'alice', sid),
  });
});

test('a queued write holds its lease until the backend settles', async () => {
  let finish = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve: () => void) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve: () => void) => {
    finish = resolve;
  });
  const original = registry.addDocument.bind(registry);
  const write = jest
    .spyOn(registry, 'addDocument')
    .mockImplementationOnce(
      async (...args: Parameters<CollectionRegistry['addDocument']>) => {
        started();
        await gate;
        return original(...args);
      },
    );
  const first = call('record_add');
  await entered;
  const secondWrite = call('record_add');
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  let closed = false;
  const close = longSessions()
    .close('alice', sid, 'explicit')
    .then(() => {
      closed = true;
    });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  expect((await first).isError).toBeUndefined();
  expect((await secondWrite).isError).toBe(true);
  await close;
});

test('write embeddings receive caller, session and request trace without a second request measurement', async () => {
  const sink = memorySink({ limit: 20 });
  const recorder = createUsageRecorder({ transport: directTransport(sink) });
  mockForSession.mockImplementation(
    (identity: { userId: string; sessionId: string }) =>
      recorder.with(identity),
  );
  const original = registry.addDocument.bind(registry);
  jest
    .spyOn(registry, 'addDocument')
    .mockImplementation(
      async (...args: Parameters<CollectionRegistry['addDocument']>) => {
        args[3]?.usage?.record({
          kind: 'x.test.embedding',
          context: {},
          outcome: 'ok',
          values: { tokens: 7 },
        });
        return original(...args);
      },
    );
  await executeRagMcpTool(
    { headers: {} },
    'alice',
    'record_add',
    { session: sid, collection: cid, text: 'text' },
    'write-trace',
  );
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
        component: 'collection-write',
        userId: 'alice',
        sessionId: sid,
        requestId: 'write-trace',
        traceId: 'write-trace',
      },
    },
  ]);
  await recorder.close(1000);
});

test('reserved names, unsupported scopes and missing text never touch storage', async () => {
  const create = jest.spyOn(registry, 'getOrCreateCollection');
  const write = jest.spyOn(registry, 'addDocument');
  expect(
    assertWriteResult(
      await call('collection_create', { name: 'reserved__name' }),
    ).error?.code,
  ).toBe('INVALID_ARGUMENT');
  expect(
    ragMcpSchemas.collection_create.safeParse({
      name: 'notes',
      scope: 'global',
    }).success,
  ).toBe(false);
  expect(
    assertWriteResult(await call('record_add', { text: '' })).error?.code,
  ).toBe('INVALID_ARGUMENT');
  expect(create).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
