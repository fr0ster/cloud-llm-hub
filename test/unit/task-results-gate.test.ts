jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));

import type { IMcpClient, TaskResultEntry } from '@mcp-abap-adt/llm-agent';
import {
  executeRagTool,
  type RagExecutionContext,
} from '../../srv/agent-mcp-rag';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import {
  dialogueResultToolSelection,
  LocalRagMcpClient,
  runWithDialogueRagTools,
} from '../../srv/lib/dialogue-rag-tools';
import {
  type RagMcpTool,
  ragToolEffect,
  ragToolNames,
} from '../../srv/lib/rag-tool-catalogue';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { createTaskResultStore } from '../../srv/lib/task-result-store';
import { resolverFor } from '../../srv/lib/trust-resolver';
import { CollectionRegistry } from '../../srv/rag-collections';
import {
  runWithProfileTools,
  runWithSessionId,
} from '../../srv/request-session';
import { liveSession } from './helpers/canonical-rag';

const scope = { userId: 'alice', sessionKey: 'gate-session' };
const physical = sessionCollectionId(
  'task-results',
  scope.userId,
  scope.sessionKey,
);
const entry: TaskResultEntry = {
  id: 'task-1',
  worker: 'executor',
  goal: 'Report',
  result: 'report',
  outcome: 'done',
  summary: 'Complete',
  output: 'Private task result',
};
let registry: CollectionRegistry;
function context(
  overrides: Partial<RagExecutionContext> = {},
): RagExecutionContext {
  return {
    ...scope,
    registry,
    admin: false,
    internal: true,
    trustedAdmission: false,
    permissions: { allows: () => true },
    readOnly: false,
    channel: 'openai',
    ...overrides,
  };
}
function call(
  name: RagMcpTool,
  args: object,
  overrides: Partial<RagExecutionContext> = {},
) {
  return executeRagTool(context(overrides), name, args);
}
beforeEach(async () => {
  liveSession(scope.userId, scope.sessionKey);
  registry = new CollectionRegistry();
  const written = await createTaskResultStore(registry, scope).put(entry);
  if (!written.ok) throw new Error(written.error.message);
});

const mutations: Array<{ name: RagMcpTool; args: object }> = [
  { name: 'record_add', args: { record: 'new', text: 'Changed' } },
  { name: 'record_update', args: { record: entry.id, text: 'Changed' } },
  { name: 'record_delete', args: { record: entry.id } },
  { name: 'record_set_enabled', args: { id: entry.id, enabled: false } },
  {
    name: 'record_set_enabled',
    args: { source: 'session:task-results/task-1', enabled: false },
  },
  { name: 'collection_delete', args: {} },
  { name: 'collection_set_enabled', args: { enabled: false } },
  { name: 'collection_set_trust', args: { trust: 1 } },
  { name: 'record_set_trust', args: { record: entry.id, trust: 1 } },
];
test('mutation coverage follows the canonical effects', () => {
  expect(new Set(mutations.map(({ name }) => name))).toEqual(
    new Set(
      ragToolNames.filter(
        (name) =>
          ragToolEffect(name) !== 'read' &&
          name !== 'rag_persist' &&
          name !== 'collection_create',
      ),
    ),
  );
});
for (const dialogueRole of ['worker', 'coordinator', undefined] as const) {
  for (const channel of ['openai', 'anthropic', 'mcp-agent', 'rest'] as const) {
    test.each(mutations)(
      `${dialogueRole ?? 'external'} on ${channel} cannot mutate task-results: $name $args`,
      async ({ name, args }) => {
        for (const collection of ['task-results', physical]) {
          const result = await call(
            name,
            { collection, ...args },
            { dialogueRole, channel, admin: true },
          );
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: { code: 'TOOL_FORBIDDEN' },
          });
          expect(result.content[0].text).toContain(
            'task results are written by the session store only',
          );
        }
        expect((await registry.getDocument(physical, entry.id))?.text).toBe(
          entry.output,
        );
      },
    );
  }
}
test('collection_create cannot reuse the store collection', async () => {
  const result = await call('collection_create', {
    name: 'task-results',
    scope: 'session',
  });
  expect(result.structuredContent).toMatchObject({
    error: { code: 'TOOL_FORBIDDEN' },
  });
});

test('worker without profile RAG tools can discover, select and read only own task-results', async () => {
  const inner: IMcpClient = {
    listTools: async () => ({ ok: true, value: [] }),
    callTool: async () => {
      throw new Error('Unexpected external call');
    },
  };
  const client = new RecordingMcpClient(
    new LocalRagMcpClient(inner, () => registry),
  );
  await runWithSessionId(
    scope.sessionKey,
    () =>
      runWithDialogueRagTools(() =>
        runWithProfileTools(new AgentToolPermissions([]), async () => {
          const listed = await client.listTools();
          if (!listed.ok) throw new Error('Discovery failed');
          expect(listed.value.map((tool) => tool.name).sort()).toEqual([
            'collection_records',
            'rag_read',
          ]);
          expect(
            dialogueResultToolSelection
              .select([])
              .map((record) => record.metadata.name),
          ).toEqual(['rag_read', 'collection_records']);
          for (const collection of ['task-results', physical]) {
            for (const name of ['rag_read', 'collection_records'] as const) {
              const result = await client.callTool(name, {
                collection,
                ...(name === 'rag_read' ? { id: entry.id } : {}),
              });
              if (!result.ok) throw new Error('Read failed');
              expect(result.value.isError).not.toBe(true);
              expect(JSON.stringify(result.value)).toContain(
                name === 'rag_read' ? entry.output : entry.summary,
              );
            }
          }
          for (const collection of ['@skills', 'ordinary']) {
            const result = await client.callTool('rag_read', {
              collection,
              id: entry.id,
            });
            if (!result.ok) throw new Error('Call failed');
            expect(result.value.isError).toBe(true);
            expect(JSON.stringify(result.value)).toContain('TOOL_FORBIDDEN');
          }
        }),
      ),
    undefined,
    scope.userId,
  );
});

for (const dialogueRole of ['worker', 'coordinator'] as const) {
  test.each([
    { userId: 'alice', sessionKey: 'another-session' },
    { userId: 'bob', sessionKey: scope.sessionKey },
  ])(
    `${dialogueRole} task-results isolation: $userId/$sessionKey`,
    async (other) => {
      liveSession(other.userId, other.sessionKey);
      for (const collection of ['task-results', physical]) {
        for (const name of ['rag_read', 'collection_records'] as const) {
          const result = await call(
            name,
            { collection, ...(name === 'rag_read' ? { id: entry.id } : {}) },
            { ...other, dialogueRole, admin: true },
          );
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).not.toContain(entry.output);
        }
      }
      const listed = await call(
        'collections_list',
        {},
        { ...other, dialogueRole, admin: true },
      );
      expect(listed.isError).not.toBe(true);
      expect(JSON.stringify(listed)).not.toContain(physical);
    },
  );
}

test('rag_persist copies task results as information with provenance and leaves the store intact', async () => {
  const result = await call(
    'rag_persist',
    { collection: 'task-results', records: [entry.id], name: 'saved-results' },
    { dialogueRole: 'coordinator' },
  );
  expect(result.isError).not.toBe(true);
  const id = userCollectionId('saved-results', scope.userId);
  expect(await registry.getDocument(id, entry.id)).toMatchObject({
    text: entry.output,
    metadata: {
      persistenceProvenance: {
        sourceCollection: physical,
        sourceRecord: entry.id,
        timestamp: expect.any(String),
      },
    },
  });
  const read = await call('rag_read', { collection: id, id: entry.id });
  expect(read.isError).not.toBe(true);
  const meta = await registry.getCollection(id);
  const doc = await registry.getDocument(id, entry.id);
  if (!meta || !doc) throw new Error('Missing persisted record');
  expect(resolverFor(registry).inputFor(doc, meta)).toMatchObject({
    class: 'user',
  });
  expect((await registry.getDocument(physical, entry.id))?.text).toBe(
    entry.output,
  );
  expect(
    (
      await createTaskResultStore(registry, scope).put({
        ...entry,
        id: 'task-2',
      })
    ).ok,
  ).toBe(true);
});

test('rag_persist refuses instruction collections', async () => {
  await registry.createCollection({
    id: userCollectionId('agents', scope.userId),
    logicalId: 'agents',
    displayName: 'Agents',
    description: '',
    scope: 'user',
    owner: scope.userId,
    collectionKind: 'agents',
  });
  for (const name of ['agents']) {
    const result = await call(
      'rag_persist',
      { collection: 'task-results', records: [entry.id], name },
      { dialogueRole: 'coordinator' },
    );
    expect(result.isError).toBe(true);
  }
});

test('rag_persist names cannot address the skills instruction pool', async () => {
  const result = await call(
    'rag_persist',
    { collection: 'task-results', records: [entry.id], name: '@skills' },
    { dialogueRole: 'coordinator' },
  );
  expect(result.isError).not.toBe(true);
  const id = userCollectionId('skills', scope.userId);
  const meta = await registry.getCollection(id);
  const doc = await registry.getDocument(id, entry.id);
  if (!meta || !doc) throw new Error('Missing informational copy');
  expect(resolverFor(registry).inputFor(doc, meta)).toMatchObject({
    class: 'user',
  });
  expect(await registry.getDocument('@skills', entry.id)).toBeNull();
});

for (const dialogueRole of ['worker', 'coordinator'] as const) {
  test.each([true, false])(
    `${dialogueRole} cannot override the enclosing session (internal=%s)`,
    async (internal) => {
      const other = {
        userId: scope.userId,
        sessionKey: 'other-enclosing-session',
      };
      liveSession(other.userId, other.sessionKey);
      for (const name of [
        'rag_read',
        'collection_records',
        'collections_list',
      ] as const) {
        const result = await call(
          name,
          {
            session: scope.sessionKey,
            ...(name !== 'collections_list' ? { collection: physical } : {}),
            ...(name === 'rag_read' ? { id: entry.id } : {}),
          },
          { ...other, dialogueRole, internal },
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(entry.output);
        expect(JSON.stringify(result)).not.toContain(physical);
      }
    },
  );
}

test.each(mutations)(
  'admin cannot mutate another owner/session task-results: $name',
  async ({ name, args }) => {
    for (const other of [
      { userId: 'alice', sessionKey: 'admin-other-session' },
      { userId: 'bob', sessionKey: scope.sessionKey },
    ]) {
      liveSession(other.userId, other.sessionKey);
      const result = await call(
        name,
        { collection: physical, ...args },
        { ...other, admin: true },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'TOOL_FORBIDDEN' },
      });
      expect(result.content[0].text).toContain(
        'task results are written by the session store only',
      );
    }
  },
);

test.each([false, true])(
  'reserved user name is refused consistently (store exists: %s)',
  async (exists) => {
    if (!exists) {
      registry = new CollectionRegistry();
    }
    const result = await call('collection_create', {
      name: 'task-results',
      scope: 'user',
    });
    expect(JSON.stringify(result)).toMatch(/Reserved name/);
    expect(
      await registry.getCollection(
        userCollectionId('task-results', scope.userId),
      ),
    ).toBeNull();
  },
);

test('registry source and its async descendants cannot mutate task results during put', async () => {
  const attempts: Promise<unknown>[] = [];
  const store = createTaskResultStore(() => {
    attempts.push(registry.setEnabled(scope.userId, physical, false));
    attempts.push(
      registry.updateDocument(physical, entry.id, { text: 'Corrupted' }),
    );
    attempts.push(
      Promise.resolve().then(() => registry.deleteDocument(physical, entry.id)),
    );
    // Attach rejection handlers before put yields.
    attempts.forEach((attempt) => {
      void attempt.catch(() => undefined);
    });
    return registry;
  }, scope);
  expect((await store.put({ ...entry, id: 'safe-result' })).ok).toBe(true);
  for (const attempt of attempts) {
    await expect(attempt).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
  }
  expect((await registry.getDocument(physical, entry.id))?.text).toBe(
    entry.output,
  );
});

test('callbacks during each store operation cannot update, delete or disable task results', async () => {
  const add = registry.addDocument.bind(registry);
  const create = registry.getOrCreateCollection.bind(registry);
  const read = registry.getDocument.bind(registry);
  const attack = async () => {
    for (const attempt of [
      () => registry.setEnabled(scope.userId, physical, false),
      () => registry.updateCollection(physical, { description: 'Corrupted' }),
      () => registry.updateDocument(physical, entry.id, { text: 'Corrupted' }),
      () => registry.deleteDocument(physical, entry.id),
      () => registry.deleteCollection(physical),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    }
  };
  jest
    .spyOn(registry, 'getOrCreateCollection')
    .mockImplementation(async (...args) => {
      await attack();
      return create(...args);
    });
  jest.spyOn(registry, 'addDocument').mockImplementation(async (...args) => {
    await attack();
    // The add permission is restricted to create-only and the exact task id.
    await expect(
      add(
        physical,
        { id: 'injected', text: 'Injected', metadata: {} },
        undefined,
        {
          createOnly: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    await expect(
      add(physical, { id: args[1].id, text: 'Injected', metadata: {} }),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    return add(...args);
  });
  jest.spyOn(registry, 'getDocument').mockImplementation(async (...args) => {
    await attack();
    return read(...args);
  });
  expect(
    (
      await createTaskResultStore(registry, scope).put({
        ...entry,
        id: 'safe-result',
      })
    ).ok,
  ).toBe(true);
  expect((await read(physical, entry.id))?.text).toBe(entry.output);
  expect((await read(physical, 'safe-result'))?.text).toBe(entry.output);
});

test('a put capability for session A cannot create or add records in session B', async () => {
  const otherScope = { ...scope, sessionKey: 'session-b' };
  liveSession(otherScope.userId, otherScope.sessionKey);
  const otherId = sessionCollectionId(
    'task-results',
    otherScope.userId,
    otherScope.sessionKey,
  );
  const otherStore = createTaskResultStore(registry, otherScope);
  expect((await otherStore.put(entry)).ok).toBe(true);
  const add = registry.addDocument.bind(registry);
  jest.spyOn(registry, 'addDocument').mockImplementation(async (...args) => {
    await expect(
      add(otherId, args[1], undefined, { createOnly: true }),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    await expect(
      registry.createCollection({
        id: sessionCollectionId('task-results', scope.userId, 'session-c'),
        logicalId: 'task-results',
        displayName: 'task-results',
        description: '',
        collectionKind: 'task-results',
        scope: 'session',
        owner: scope.userId,
        sessionId: 'session-c',
      }),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    return add(...args);
  });
  expect(
    (
      await createTaskResultStore(registry, scope).put({
        ...entry,
        id: 'session-a-result',
      })
    ).ok,
  ).toBe(true);
  expect(await registry.getDocument(otherId, 'session-a-result')).toBeNull();
});

test('usage callbacks and derived recorders run outside the put capability', async () => {
  const add = registry.addDocument.bind(registry);
  const attempts: Promise<unknown>[] = [];
  const attack = () => {
    const attempt = add(
      physical,
      { id: 'usage-result', text: 'Injected', metadata: {} },
      undefined,
      { createOnly: true },
    );
    void attempt.catch(() => undefined);
    attempts.push(attempt);
  };
  const usage = {
    record: attack,
    with: () => {
      attack();
      return { record: attack, with: () => usage };
    },
  };
  jest.spyOn(registry, 'addDocument').mockImplementation(async (...args) => {
    const recorder = args[3]?.usage;
    if (!recorder) throw new Error('Missing usage recorder');
    const input = {} as Parameters<typeof recorder.record>[0];
    recorder.record(input);
    recorder.with({}).record(input);
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    }
    return add(...args);
  });
  expect(
    (
      await createTaskResultStore(registry, scope).put(
        { ...entry, id: 'usage-result' },
        { usage },
      )
    ).ok,
  ).toBe(true);
  expect(attempts).toHaveLength(3);
  expect((await registry.getDocument(physical, 'usage-result'))?.text).toBe(
    entry.output,
  );
});
