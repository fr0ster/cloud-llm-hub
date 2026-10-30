import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import {
  DialogueRagMcpClient,
  runWithDialogueRagTools,
  withDialogueRagTools,
} from '../../srv/lib/dialogue-rag-tools';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { CollectionRegistry } from '../../srv/rag-collections';
import * as dispatcher from '../../srv/rag-tool-dispatcher';
import {
  getRequestSessionId,
  getRequestUserId,
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithSessionId,
} from '../../srv/request-session';

function setup() {
  const registry = new CollectionRegistry();
  const inner: IMcpClient = {
    listTools: jest.fn(async () => ({ ok: true as const, value: [] })),
    callTool: jest.fn(),
  };
  const client = new RecordingMcpClient(
    new DialogueRagMcpClient(inner, () => registry),
  );
  return { client, registry, inner };
}
const inWorker = <T>(fn: () => T) =>
  runWithSessionId(
    'dialogue-1',
    () => runWithDialogueRagTools(fn),
    [],
    'alice',
  );

test('profile RAG definitions and forged direct calls share the same policy before storage effects', async () => {
  const { client, registry } = setup();
  const create = jest.spyOn(registry, 'getOrCreateCollection');
  await inWorker(() =>
    runWithProfileTools(new AgentToolPermissions(['rag_list']), async () => {
      const listed = await client.listTools();
      expect(listed.ok && listed.value.map((tool) => tool.name)).toEqual([
        'rag_list',
      ]);
      expect(
        await client.callTool('rag_add', {
          collection: 'results',
          text: 'forged',
        }),
      ).toMatchObject({ ok: true, value: { isError: true } });
      expect(create).not.toHaveBeenCalled();
      expect(await client.callTool('rag_list', {})).toMatchObject({ ok: true });
    }),
  );
});

test('worker collections persist across sessions, isolate users and allow explicit scratch scope', async () => {
  const { client, registry } = setup();
  await inWorker(async () => {
    await client.callTool('rag_add', {
      collection: 'results',
      id: 'saved',
      text: 'Keep',
    });
    await client.callTool('rag_add', {
      collection: 'results',
      scope: 'session',
      id: 'scratch',
      text: 'Temporary',
    });
  });
  expect(
    await registry.getCollection(userCollectionId('results', 'alice')),
  ).toMatchObject({ owner: 'alice', scope: 'user' });
  expect(
    await registry.getCollection(
      sessionCollectionId('results', 'alice', 'dialogue-1'),
    ),
  ).toMatchObject({
    owner: 'alice',
    scope: 'session',
    sessionId: 'dialogue-1',
  });
  const call = (
    user: string,
    session: string,
    name: string,
    args: Record<string, unknown>,
  ) =>
    runWithSessionId(
      session,
      () => runWithDialogueRagTools(() => client.callTool(name, args)),
      [],
      user,
    );
  // The persistent collection wins even when this session has scratch data of the same name.
  for (const session of ['dialogue-1', 'dialogue-2']) {
    const read = await call('alice', session, 'rag_list', {
      collection: 'results',
      id: 'saved',
    });
    expect(read.ok && JSON.parse(String(read.value.content))).toMatchObject({
      ok: true,
      document: { text: 'Keep' },
    });
  }
  const denied = await call('bob', 'dialogue-1', 'rag_list', {
    collection: 'results',
  });
  expect(denied.ok && denied.value.isError).toBe(true);
  const corrected = await call('alice', 'dialogue-2', 'rag_correct', {
    collection: 'results',
    id: 'saved',
    newText: 'Updated',
    reason: 'Update',
  });
  expect(corrected.ok && corrected.value.isError).toBe(false);
  const removed = await call('alice', 'dialogue-2', 'rag_deprecate', {
    collection: 'results',
    id: 'saved',
    reason: 'Retire',
  });
  expect(removed.ok && removed.value.isError).toBe(false);
});

test('executor sees four hub tools; checker sees only rag_list and cannot write', async () => {
  const { client, registry, inner } = setup();
  const executor = await inWorker(() => client.listTools());
  expect(executor.ok && executor.value.map((t) => t.name).sort()).toEqual([
    'rag_add',
    'rag_correct',
    'rag_deprecate',
    'rag_list',
  ]);
  await inWorker(() =>
    runWithReadOnlyTools(async () => {
      const checker = await client.listTools();
      expect(checker.ok && checker.value.map((t) => t.name)).toEqual([
        'rag_list',
      ]);
      const denied = await client.callTool('rag_add', {
        collection: 'results',
        text: 'no',
      });
      expect(denied.ok && denied.value.isError).toBe(true);
    }),
  );
  expect(
    await registry.getCollection(
      sessionCollectionId('results', 'alice', 'dialogue-1'),
    ),
  ).toBeNull();
  expect(inner.callTool).not.toHaveBeenCalled();
});

test('local dispatch binds session/user, persists results, reads them back and records ground truth', async () => {
  const { client, registry } = setup();
  const original = dispatcher.dispatchRagTool;
  const spy = jest
    .spyOn(dispatcher, 'dispatchRagTool')
    .mockImplementation((...args) => {
      expect(getRequestSessionId()).toBe('dialogue-1');
      expect(getRequestUserId()).toBe('alice');
      return original(...args);
    });
  try {
    await inWorker(async () => {
      const added = await client.callTool(
        'rag_add',
        { collection: 'results', id: 'dump-1', text: 'Analysis persisted' },
        { trace: { traceId: 'task-1' } },
      );
      expect(added.ok && added.value.isError).toBe(false);
      await runWithReadOnlyTools(async () => {
        const read = await client.callTool(
          'rag_list',
          { collection: 'results' },
          { trace: { traceId: 'task-1' } },
        );
        expect(read.ok && JSON.parse(String(read.value.content))).toMatchObject(
          {
            ok: true,
            total: 1,
            documents: [
              { id: 'dump-1', title: 'Analysis persisted', length: 18 },
            ],
          },
        );
      });
    });
    expect(spy).toHaveBeenCalledWith(registry, 'rag_add', expect.any(Object), {
      defaultScope: 'user',
    });
    expect(client.getToolRecords('task-1').map((r) => r.call.name)).toEqual([
      'rag_add',
      'rag_list',
    ]);
    const meta = await registry.getCollection(
      userCollectionId('results', 'alice'),
    );
    expect(meta).toMatchObject({
      scope: 'user',
      owner: 'alice',
    });
    const outside = await client.callTool('rag_add', {
      collection: 'results',
      text: 'no',
    });
    expect(outside.ok && outside.value.isError).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('hub tools remain selectable with an empty SAP search and checker selection excludes writes', async () => {
  const rag = withDialogueRagTools({
    query: async () => ({ ok: true, value: [] }),
  } as unknown as IRag);
  const query = () =>
    rag.query({ text: 'store analysis' } as Parameters<IRag['query']>[0], 5);
  expect(await query()).toEqual({ ok: true, value: [] });
  const executor = await inWorker(query);
  expect(executor.ok && executor.value.map((r) => r.metadata.id)).toEqual([
    'tool:rag_list',
    'tool:rag_add',
    'tool:rag_correct',
    'tool:rag_deprecate',
  ]);
  const checker = await inWorker(() => runWithReadOnlyTools(query));
  expect(checker.ok && checker.value.map((r) => r.metadata.id)).toEqual([
    'tool:rag_list',
  ]);
});

test('dialogue local rag_list full read is capped and reviewer records the visible prefix', async () => {
  const { registry, inner } = setup();
  const client = new RecordingMcpClient(
    new DialogueRagMcpClient(inner, () => registry),
    undefined,
    100,
  );
  await inWorker(async () => {
    await client.callTool('rag_add', {
      collection: 'results',
      id: 'large',
      text: 'x'.repeat(1000),
    });
    const result = await client.callTool(
      'rag_list',
      { collection: 'results', id: 'large' },
      { trace: { traceId: 'large' } },
    );
    expect(result.ok && result.value.content).toContain(
      '[result truncated: 100 of',
    );
    expect(result.ok && result.value.isError).toBe(false);
    expect(client.getToolRecords('large')[0].result).toEqual(
      result.ok && result.value,
    );
    expect(client.getToolRecords('large')[0]).toMatchObject({
      truncation: { truncated: true, keptLength: 100 },
    });
  });
});
