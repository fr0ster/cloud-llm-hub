jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
jest.mock('../../srv/lib/session-lifecycle', () => ({
  resolveSession: async (userId: string, key: string) =>
    jest
      .requireActual<typeof import('../../srv/lib/long-session')>(
        '../../srv/lib/long-session',
      )
      .longSessions()
      .get(userId, key),
}));

import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  symmetricEmbedder,
  type TaskResultEntry,
} from '@mcp-abap-adt/llm-agent';
import { executeRagTool } from '../../srv/agent-mcp-rag';
import { resolveRouteId, sessionCollectionId } from '../../srv/collection-ids';
import { loopReads, ReadDedup } from '../../srv/lib/read-dedup';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { createTaskResultStore } from '../../srv/lib/task-result-store';
import { withToolResultCap } from '../../srv/lib/tool-result-cap';
import { CollectionRegistry } from '../../srv/rag-collections';
import { liveSession } from './helpers/canonical-rag';

const scope = { userId: 'alice', sessionKey: 'result-session' };
const physical = sessionCollectionId(
  'task-results',
  scope.userId,
  scope.sessionKey,
);
const entry: TaskResultEntry = {
  id: 'task-1',
  stepId: 'step-1',
  worker: 'executor',
  goal: 'Produce report',
  result: 'report',
  outcome: 'done',
  summary: 'Completed report',
  output: 'Private report body',
};
function tool(
  registry: CollectionRegistry,
  name: Parameters<typeof executeRagTool>[1],
  args: object,
) {
  return executeRagTool(
    {
      registry,
      traceId: 'result-read',
      ...scope,
      admin: false,
      internal: true,
      trustedAdmission: false,
      permissions: { allows: () => true },
      readOnly: false,
      channel: 'openai',
    },
    name,
    args,
  );
}
beforeEach(() => {
  liveSession(scope.userId, scope.sessionKey);
});

test('registry resolution is deferred until an operation and shared by put and read', async () => {
  const registry = new CollectionRegistry();
  const resolveRegistry = jest.fn(() => registry);
  const store = createTaskResultStore(resolveRegistry, scope);
  expect(resolveRegistry).not.toHaveBeenCalled();
  const written = await store.put(entry);
  if (!written.ok) throw new Error(written.error.message);
  expect(await store.read(written.value)).toEqual({
    ok: true,
    value: entry.output,
  });
  expect(resolveRegistry).toHaveBeenCalledTimes(1);
});

test('put creates the session collection lazily and the record is readable information', async () => {
  const registry = new CollectionRegistry();
  const store = createTaskResultStore(registry, scope);
  expect(await registry.getCollection(physical)).toBeNull();
  const written = await store.put(entry);
  expect(written).toEqual({
    ok: true,
    value: {
      collection: 'task-results',
      record: entry.id,
      chars: entry.output.length,
    },
  });
  expect(await registry.getCollection(physical)).toMatchObject({
    collectionKind: 'task-results',
    scope: 'session',
    owner: scope.userId,
    sessionId: scope.sessionKey,
    expiresAt: expect.any(Number),
  });
  if (!written.ok) throw new Error(written.error.message);
  expect(await store.read(written.value)).toEqual({
    ok: true,
    value: entry.output,
  });
  expect(await registry.getDocument(physical, entry.id)).toMatchObject({
    trusted: true,
    source: 'session:task-results/task-1',
    metadata: {
      kind: 'task-result',
      taskId: entry.id,
      stepId: entry.stepId,
      worker: entry.worker,
      outcome: 'done',
    },
  });
});

test('identical concurrent puts across store instances return the same ref; different text returns exists', async () => {
  const registry = new CollectionRegistry();
  const first = createTaskResultStore(registry, scope);
  const second = createTaskResultStore(registry, scope);
  const written = await Promise.all([first.put(entry), second.put(entry)]);
  expect(written[0].ok).toBe(true);
  expect(written[1]).toEqual(written[0]);
  expect(await second.put({ ...entry, output: 'Changed' })).toMatchObject({
    ok: false,
    error: { code: 'exists' },
  });
  expect((await registry.getDocument(physical, entry.id))?.text).toBe(
    entry.output,
  );
});

test('records are not embedded and rag_search and automatic retrieval skip the collection', async () => {
  const embed = jest.fn(async () => {
    throw new Error('Embedding must not be called');
  });
  const registry = new CollectionRegistry({
    embedder: symmetricEmbedder({ embed }),
  });
  expect((await createTaskResultStore(registry, scope).put(entry)).ok).toBe(
    true,
  );
  expect(embed).not.toHaveBeenCalled();
  expect(await registry.getRagStore(physical)).toBeNull();
  expect(await registry.getRagStores([physical])).toEqual({});
  const searched = await tool(registry, 'rag_search', {
    query: 'report',
    collections: ['task-results'],
  });
  expect(searched.isError).not.toBe(true);
  expect(JSON.stringify(searched)).not.toContain(entry.output);
  expect(JSON.stringify(searched)).not.toContain(
    'Collection store unavailable',
  );
  expect(embed).not.toHaveBeenCalled();
});

test('collection_records lists result metadata without any body; rag_read returns body by id', async () => {
  const registry = new CollectionRegistry();
  await createTaskResultStore(registry, scope).put(entry);
  const listed = await tool(registry, 'collection_records', {
    collection: 'task-results',
  });
  expect(listed.isError).not.toBe(true);
  const serialized = JSON.stringify(listed);
  expect(serialized).not.toContain(entry.output);
  expect(JSON.parse(listed.content[0].text)).toMatchObject({
    records: [
      {
        id: entry.id,
        stepId: entry.stepId,
        worker: entry.worker,
        goal: entry.goal,
        summary: entry.summary,
        chars: entry.output.length,
        outcome: 'done',
      },
    ],
  });
  const read = await tool(registry, 'rag_read', {
    collection: 'task-results',
    id: entry.id,
  });
  expect(read.isError).not.toBe(true);
  expect(JSON.stringify(read)).toContain(entry.output);
});

test('read returns the full 70 000 characters', async () => {
  const store = createTaskResultStore(new CollectionRegistry(), scope);
  const output = 'R'.repeat(70_000);
  const written = await store.put({ ...entry, output });
  if (!written.ok) throw new Error(written.error.message);
  expect(await store.read(written.value)).toEqual({ ok: true, value: output });
});

test('same-user and different-user sessions cannot resolve or read another session record', async () => {
  const registry = new CollectionRegistry();
  const store = createTaskResultStore(registry, scope);
  const written = await store.put(entry);
  if (!written.ok) throw new Error(written.error.message);
  for (const other of [
    { userId: 'alice', sessionKey: 'other' },
    { userId: 'bob', sessionKey: scope.sessionKey },
  ]) {
    expect(
      await resolveRouteId(
        registry,
        physical,
        other.userId,
        other.sessionKey,
        false,
      ),
    ).toBeUndefined();
    const isolated = createTaskResultStore(registry, other);
    expect(await isolated.read(written.value)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(
      await isolated.read({ ...written.value, collection: physical }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  }
});

test('abort and backend errors map to store error codes', async () => {
  const registry = new CollectionRegistry();
  const store = createTaskResultStore(registry, scope);
  const abort = new AbortController();
  abort.abort();
  expect(await store.put(entry, { signal: abort.signal })).toMatchObject({
    ok: false,
    error: { code: 'aborted' },
  });
  expect(await registry.getCollection(physical)).toBeNull();
  jest
    .spyOn(registry, 'getCollection')
    .mockRejectedValue(new Error('Backend unavailable'));
  expect(await store.put(entry)).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(
    await store.read(
      { collection: 'task-results', record: entry.id, chars: 1 },
      { signal: abort.signal },
    ),
  ).toMatchObject({ ok: false, error: { code: 'aborted' } });
});

test('abort interrupts an in-flight wait without a timeout', async () => {
  const registry = new CollectionRegistry();
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(registry, 'getCollection').mockImplementation(async () => {
    await blocked;
    return null;
  });
  const controller = new AbortController();
  const waiting = createTaskResultStore(registry, scope).put(entry, {
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  expect(await waiting).toMatchObject({
    ok: false,
    error: { code: 'aborted' },
  });
  release();
});

test('PG persists unembedded full results and restores refs independently of the embedder fingerprint', async () => {
  const { createPgClient, PgVectorRagProvider } = await import(
    '@mcp-abap-adt/pg-vector-rag'
  );
  const { startPglite } = await import('./helpers/pglite');
  const { createCollectionPersistence } = await import(
    '../../srv/lib/collection-persistence'
  );
  const database = await startPglite({ dimension: 1536 });
  const client = await createPgClient({
    connectionString: database.url,
    credential: database.credential,
    collectionName: 'hub-collections',
  });
  try {
    const embed = jest.fn(async () => {
      throw new Error('Embedding must not be called');
    });
    const embedder = symmetricEmbedder({ embed });
    const provider = new PgVectorRagProvider({
      name: 'hub-collections',
      embedder,
      layout: 'shared',
      connection: {
        collectionName: 'hub-collections',
        schema: database.schema,
        layout: 'shared',
      },
      clientFactory: () => client,
    });
    const registry = new CollectionRegistry({
      defaultBackend: 'pg-vector',
      persistence: createCollectionPersistence(provider, 'before'),
    });
    const output = 'Stored result'.repeat(6000);
    const written = await createTaskResultStore(registry, scope).put({
      ...entry,
      output,
    });
    if (!written.ok) throw new Error(written.error.message);
    const restored = new CollectionRegistry({
      defaultBackend: 'pg-vector',
      persistence: createCollectionPersistence(provider, 'after'),
    });
    const store = createTaskResultStore(restored, scope);
    expect(await store.read(written.value)).toEqual({
      ok: true,
      value: output,
    });
    expect(await store.put({ ...entry, output })).toEqual(written);
    expect(await store.put({ ...entry, output: 'changed' })).toMatchObject({
      ok: false,
      error: { code: 'exists' },
    });
    expect(await restored.getCollection(physical)).toMatchObject({
      collectionKind: 'task-results',
    });
    expect(await restored.getRagStores([physical])).toEqual({});
    expect(embed).not.toHaveBeenCalled();
  } finally {
    await client.end();
    await database.stop();
  }
});

test.each([0, 60000, 4096])(
  'escaped result pages survive worker cap %i and dedup',
  async (cap) => {
    const registry = new CollectionRegistry();
    const output = '"\n\\\u0000'.repeat(17500);
    expect(output.length).toBe(70000);
    expect(
      (await createTaskResultStore(registry, scope).put({ ...entry, output }))
        .ok,
    ).toBe(true);
    const inner: IMcpClient = {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async (name, args) => ({
        ok: true,
        value: await tool(registry, name as Parameters<typeof tool>[1], args),
      }),
    };
    // Exercise both production cap wrappers, including the worker's recording path.
    const client = new RecordingMcpClient(
      withToolResultCap(inner, cap),
      undefined,
      cap,
    );
    await loopReads.run(new ReadDedup(8), async () => {
      let offset = 0;
      let combined = '';
      let pages = 0;
      while (offset < output.length) {
        const read = () =>
          client.callTool(
            'rag_read',
            {
              collection: 'task-results',
              id: entry.id,
              offset,
            },
            { trace: { traceId: 'result-read' } },
          );
        const result = await read();
        if (!result.ok) throw new Error('Tool failed');
        expect(result.value.isError).not.toBe(true);
        expect(typeof result.value.content).not.toBe('string');
        const content = result.value.content as Array<{ text: string }>;
        if (cap)
          expect(JSON.stringify(content).length).toBeLessThanOrEqual(cap);
        const page = JSON.parse(content[0].text);
        expect(page.alreadyRead).toBeUndefined();
        expect(page.offset).toBe(offset);
        expect(page.total).toBe(output.length);
        expect(page.text.length).toBeGreaterThan(0);
        combined += page.text;
        const repeated = await read();
        if (!repeated.ok) throw new Error('Repeat failed');
        expect(
          JSON.parse(
            (repeated.value.content as Array<{ text: string }>)[0].text,
          ).alreadyRead,
        ).toBe(true);
        offset += page.text.length;
        expect(page.next).toBe(offset < output.length ? offset : undefined);
        expect(++pages).toBeLessThan(1000);
      }
      expect(combined).toBe(output);
      expect(pages).toBeGreaterThan(2);
    });
  },
);
