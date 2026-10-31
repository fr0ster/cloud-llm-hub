import type { IMcpClient, IRag, IUsageRecorder } from '@mcp-abap-adt/llm-agent';
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  createCallRegister,
  runWithAdmission,
} from '../../srv/lib/admission-scope';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import {
  LocalRagMcpClient,
  localRagTools,
  withDialogueRagTools,
} from '../../srv/lib/dialogue-rag-tools';
import { longSessions } from '../../srv/lib/long-session';
import { ragToolEffect, ragToolNames } from '../../srv/lib/rag-tool-catalogue';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { CollectionRegistry } from '../../srv/rag-collections';
import {
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithSessionId,
} from '../../srv/request-session';
import { liveSession } from './helpers/canonical-rag';

function setup() {
  const registry = new CollectionRegistry();
  const inner: IMcpClient = {
    listTools: async () => ({
      ok: true,
      value: [
        { name: 'record_add', description: 'untrusted', inputSchema: {} },
        { name: 'GetTable', description: 'read', inputSchema: {} },
        { name: 'GetTable', description: 'read', inputSchema: {} },
      ],
    }),
    callTool: jest.fn(),
  };
  const local = new LocalRagMcpClient(inner, () => registry);
  return { registry, inner, local, client: new RecordingMcpClient(local) };
}
const inSession = <T>(fn: () => T) =>
  runWithSessionId(liveSession('alice', 'dialogue-1'), fn, [], 'alice');

test('all canonical tools are local, upstream collisions and duplicates cannot shadow them', async () => {
  const { client, inner } = setup();
  const result = await inSession(() => client.listTools());
  expect(result.ok && result.value.map((tool) => tool.name)).toEqual([
    'GetTable',
    ...ragToolNames,
  ]);
  expect(
    result.ok &&
      result.value.find((tool) => tool.name === 'record_add')?.description,
  ).not.toBe('untrusted');
  await inSession(() => client.callTool('record_add', {}));
  expect(inner.callTool).not.toHaveBeenCalled();
});

test('checker gets exactly four reads; allow/deny and cached adapters reject forged mutations', async () => {
  const { client, registry } = setup();
  await inSession(() =>
    runWithReadOnlyTools(async () => {
      const result = await client.listTools();
      expect(
        result.ok &&
          result.value
            .filter((tool) => ragToolNames.some((name) => name === tool.name))
            .map((tool) => tool.name),
      ).toEqual(ragToolNames.filter((name) => ragToolEffect(name) === 'read'));
      expect(
        await client.callTool('collection_create', {
          name: 'denied',
          scope: 'user',
        }),
      ).toMatchObject({ value: { isError: true } });
    }),
  );
  await inSession(() =>
    runWithProfileTools(new AgentToolPermissions(['rag_read']), async () => {
      expect(await client.listTools()).toMatchObject({
        value: [{ name: 'rag_read' }],
      });
      expect(
        await client.callTool('collection_create', {
          name: 'denied',
          scope: 'user',
        }),
      ).toMatchObject({ value: { isError: true } });
    }),
  );
  expect(await registry.listCollections('alice')).toEqual([]);
});

test('local calls use enclosing sessions, physical ids and structured results; record evidence survives', async () => {
  const { client, registry } = setup();
  await inSession(async () => {
    expect(
      await client.callTool('collection_create', {
        name: 'results',
        scope: 'user',
      }),
    ).toMatchObject({ value: { structuredContent: { created: true } } });
    expect(
      await client.callTool(
        'record_add',
        { collection: 'results', record: 'tech-spec', text: 'Keep' },
        { trace: { traceId: 'task' } },
      ),
    ).toMatchObject({ value: { structuredContent: { record: 'tech-spec' } } });
    expect(
      await client.callTool('record_add', {
        collection: 'results',
        record: 'tech-spec',
        text: 'Overwrite',
      }),
    ).toMatchObject({
      value: {
        isError: true,
        structuredContent: { error: { code: 'RECORD_EXISTS', status: 409 } },
      },
    });
    expect(
      await client.callTool('rag_read', {
        collection: 'results',
        id: 'tech-spec',
        session: 'different',
      }),
    ).toMatchObject({ value: { isError: true } });
    const result = await client.callTool('rag_read', {
      collection: 'results',
      id: 'tech-spec',
      session: 'dialogue-1',
    });
    expect(result.ok && JSON.stringify(result.value.content)).toContain('Keep');
  });
  expect(client.getToolRecords('task')).toHaveLength(1);
  expect((await registry.listCollections('alice'))[0].documentCount).toBe(1);
});

test.each(ragToolNames)(
  '%s stays listed without a session and returns SESSION_REQUIRED',
  async (name) => {
    const { local } = setup();
    const inputs = {
      collection_create: { name: 'results', scope: 'user' },
      collection_delete: { collection: 'results' },
      record_add: { collection: 'results', text: 'Keep' },
      record_update: { collection: 'results', record: 'id', text: 'Keep' },
      record_delete: { collection: 'results', record: 'id' },
      rag_search: { query: 'Keep' },
      rag_read: { collection: 'results', id: 'id' },
      collections_list: {},
      collection_records: { collection: 'results' },
      collection_set_enabled: { collection: 'results', enabled: false },
      record_set_enabled: { collection: 'results', id: 'id', enabled: false },
    };
    expect(localRagTools().some((tool) => tool.name === name)).toBe(true);
    expect(
      await runWithSessionId(
        undefined,
        () => local.callTool(name, inputs[name]),
        [],
        'alice',
      ),
    ).toMatchObject({
      value: {
        isError: true,
        structuredContent: { error: { code: 'SESSION_REQUIRED' } },
      },
    });
  },
);

test('nested host admission avoids the session FIFO and measures exactly once in the caller channel', async () => {
  const { local } = setup();
  const record = jest.fn<
    ReturnType<IUsageRecorder['record']>,
    Parameters<IUsageRecorder['record']>
  >();
  const usage: IUsageRecorder = { record, with: () => usage };
  const key = liveSession('alice', 'nested');
  const session = longSessions().get('alice', key);
  if (!session) throw new Error('Missing live session');
  await longSessions().run(session, () =>
    runWithAdmission(createCallRegister(), () =>
      runWithSessionId(
        key,
        () =>
          local.callTool(
            'collections_list',
            {},
            { usage, trace: { traceId: 'origin' } },
          ),
        [],
        'alice',
      ),
    ),
  );
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'tool.call',
      context: expect.objectContaining({
        traceId: 'origin',
        channel: 'openai',
        sessionId: key,
      }),
    }),
  );
});

test.each(['rag_list', 'rag_add', 'rag_correct', 'rag_deprecate'])(
  'removed %s is rejected without forwarding',
  async (name) => {
    const { local, inner } = setup();
    expect(await local.callTool(name, {})).toMatchObject({
      value: { isError: true },
    });
    expect(inner.callTool).not.toHaveBeenCalled();
  },
);

test('canonical tool candidates deduplicate imported names and obey the read ceiling', async () => {
  const base: IRag = {
    query: async () => ({
      ok: true,
      value: [
        {
          text: 'fake',
          metadata: { id: 'tool:record_add', name: 'record_add' },
          score: 1,
        },
      ],
    }),
    getById: async () => ({ ok: true, value: null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
  const rag = withDialogueRagTools(base);
  const result = await runWithReadOnlyTools(() =>
    rag.query(new TextOnlyEmbedding('read'), 20),
  );
  expect(result.ok && result.value.map((row) => row.metadata.id)).toEqual(
    ragToolNames
      .filter((name) => ragToolEffect(name) === 'read')
      .map((name) => `tool:${name}`),
  );
  for (const tool of localRagTools())
    expect(
      z.object({ type: z.literal('object') }).parse(tool.inputSchema),
    ).toEqual({ type: 'object' });
});
