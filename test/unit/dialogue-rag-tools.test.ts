import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId } from '../../srv/collection-ids';
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
          { ok: true, total: 1, documents: [{ text: 'Analysis persisted' }] },
        );
      });
    });
    expect(spy).toHaveBeenCalledWith(registry, 'rag_add', expect.any(Object));
    expect(client.getToolRecords('task-1').map((r) => r.call.name)).toEqual([
      'rag_add',
      'rag_list',
    ]);
    const meta = await registry.getCollection(
      sessionCollectionId('results', 'alice', 'dialogue-1'),
    );
    expect(meta).toMatchObject({
      scope: 'session',
      owner: 'alice',
      sessionId: 'dialogue-1',
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
