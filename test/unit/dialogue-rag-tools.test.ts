import type { IMcpClient, IRag, IUsageRecorder } from '@mcp-abap-adt/llm-agent';
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  createCallRegister,
  runWithAdmission,
} from '../../srv/lib/admission-scope';
import {
  AgentToolPermissions,
  effectiveProfileTools,
} from '../../srv/lib/agent-profile-tools';
import {
  LocalRagMcpClient,
  localRagTools,
  runWithDialogueRagTools,
  withDialogueRagTools,
} from '../../srv/lib/dialogue-rag-tools';
import { longSessions } from '../../srv/lib/long-session';
import {
  buildRagToolSchemas,
  ragDescriptions,
  ragMcpSchemas,
  ragToolEffect,
  ragToolNames,
} from '../../srv/lib/rag-tool-catalogue';
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
    ...ragToolNames.filter((name) => name !== 'rag_persist'),
  ]);
  expect(
    result.ok &&
      result.value.find((tool) => tool.name === 'record_add')?.description,
  ).not.toBe('untrusted');
  await inSession(() => client.callTool('record_add', {}));
  expect(inner.callTool).not.toHaveBeenCalled();
});

test('checker gets reads and knowledge; allow/deny and cached adapters reject forbidden mutations', async () => {
  const { client, registry } = setup();
  await inSession(() =>
    runWithDialogueRagTools(() =>
      runWithReadOnlyTools(async () => {
        const result = await client.listTools();
        expect(
          result.ok &&
            result.value
              .filter((tool) => ragToolNames.some((name) => name === tool.name))
              .map((tool) => tool.name),
        ).toEqual(
          ragToolNames.filter(
            (name) =>
              ragToolEffect(name) === 'read' ||
              [
                'collection_create',
                'record_add',
                'record_update',
                'record_set_enabled',
              ].includes(name),
          ),
        );
        expect(
          await client.callTool('collection_set_trust', {
            collection: 'denied',
            trust: 3,
          }),
        ).toMatchObject({ value: { isError: true } });
      }),
    ),
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

test.each(ragToolNames.filter((name) => name !== 'rag_persist'))(
  '%s stays listed without a session and returns SESSION_REQUIRED',
  async (name) => {
    const { local } = setup();
    const inputs = {
      collection_set_trust: { collection: 'notes', trust: 3 },
      record_set_trust: { collection: 'notes', record: 'visible', trust: 3 },
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
        ...['rag_list', 'rag_add', 'rag_correct', 'rag_deprecate'].map(
          (name: string) => ({
            text: 'stale cached candidate',
            metadata: { id: `tool:${name}`, name },
            score: 1,
          }),
        ),
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
      .filter(
        (name) => name !== 'rag_persist' && ragToolEffect(name) === 'read',
      )
      .map((name) => `tool:${name}`),
  );
  for (const tool of localRagTools())
    expect(
      z.object({ type: z.literal('object') }).parse(tool.inputSchema),
    ).toEqual({ type: 'object' });
});

import { createToolLoopWindow } from '../../srv/lib/tool-loop-window';

test('local rag_read uses loop pointers and restores text after eviction or another-page change', async () => {
  const { client } = setup();
  await inSession(async () => {
    const strategy = createToolLoopWindow(1);
    const options = { trace: { traceId: 'read-loop' } };
    const emptyRound = {
      assistant: { role: 'assistant' as const, content: '' },
      results: [],
    };
    const created = await client.callTool(
      'collection_create',
      { name: 'pages', scope: 'user' },
      options,
    );
    const collection = z
      .object({ collection: z.string() })
      .parse(
        created.ok ? JSON.parse(String(created.value.content)) : {},
      ).collection;
    await client.callTool(
      'record_add',
      { collection, record: 'r', text: 'a'.repeat(40000) },
      options,
    );
    const read = () =>
      client.callTool('rag_read', { collection, id: 'r' }, options);
    expect(await read()).toMatchObject({
      value: { content: expect.stringContaining('"next":32000') },
    });
    await strategy.record(emptyRound);
    expect(await read()).toMatchObject({
      value: { content: expect.stringContaining('"alreadyRead":true') },
    });
    await strategy.record(emptyRound);
    expect(await read()).toMatchObject({
      value: { content: expect.stringContaining('"text":') },
    });
    await client.callTool(
      'record_update',
      { collection, record: 'r', text: `${'a'.repeat(39999)}b` },
      options,
    );
    expect(await read()).toMatchObject({
      value: { content: expect.stringContaining('"text":') },
    });
  });
});

test('coordinator exposes only RAG reads and refuses all nine mutations; worker catalogue stays complete', async () => {
  const { inner, registry, local } = setup();
  const coordinator = new LocalRagMcpClient(inner, () => registry, true);
  const result = await coordinator.listTools();
  expect(result.ok && result.value.map((tool) => tool.name)).toEqual([
    'GetTable',
    ...ragToolNames.filter(
      (name) => name === 'rag_persist' || ragToolEffect(name) === 'read',
    ),
  ]);
  const mutations = ragToolNames.filter(
    (name) => name !== 'rag_persist' && ragToolEffect(name) !== 'read',
  );
  expect(mutations).toHaveLength(9);
  for (const name of mutations)
    expect(await coordinator.callTool(name, {})).toMatchObject({
      ok: true,
      value: { isError: true },
    });
  const worker = await local.listTools();
  expect(worker.ok && worker.value.map((tool) => tool.name)).toEqual([
    'GetTable',
    ...ragToolNames.filter((name) => name !== 'rag_persist'),
  ]);
  expect(inner.callTool).not.toHaveBeenCalled();
});

import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import { persistRagRecords } from '../../srv/lib/rag-write-operations';

test('dialogue workers write session collections only; plain user calls retain user writes', async () => {
  const { client } = setup();
  await inSession(async () => {
    await client.callTool('collection_create', {
      name: 'persistent',
      scope: 'user',
    });
    await runWithDialogueRagTools(async () => {
      expect(
        await client.callTool('collection_create', {
          name: 'denied',
          scope: 'user',
        }),
      ).toMatchObject({ value: { isError: true } });
      for (const name of [
        'record_add',
        'record_update',
        'record_set_enabled',
      ]) {
        expect(
          await client.callTool(
            name,
            name === 'record_set_enabled'
              ? { collection: 'persistent', id: 'r', enabled: false }
              : { collection: 'persistent', record: 'r', text: 'text' },
          ),
        ).toMatchObject({ value: { isError: true } });
      }
      expect(
        await client.callTool('collection_create', {
          name: 'scratch',
        }),
      ).toMatchObject({ value: { structuredContent: { created: true } } });
      expect(
        await client.callTool('record_add', {
          collection: 'scratch',
          record: 'r',
          text: 'text',
        }),
      ).toMatchObject({ value: { structuredContent: { created: true } } });
      expect(
        await client.callTool('record_update', {
          collection: 'scratch',
          record: 'r',
          text: 'updated',
        }),
      ).toMatchObject({ value: { structuredContent: { updated: true } } });
      expect(
        await client.callTool('record_set_enabled', {
          collection: 'scratch',
          id: 'r',
          enabled: false,
        }),
      ).toMatchObject({ value: { content: expect.any(String) } });
    });
    expect(
      await client.callTool('record_add', {
        collection: 'persistent',
        text: 'user text',
      }),
    ).toMatchObject({ value: { structuredContent: { created: true } } });
  });
});

test('persistence creates target, copies verbatim, upserts ids and isolates source sessions and users', async () => {
  const { registry, client, inner } = setup();
  await inSession(async () => {
    const created = await client.callTool('collection_create', {
      name: 'scratch',
      scope: 'session',
    });
    const source = z
      .object({ collection: z.string() })
      .parse(
        created.ok ? JSON.parse(String(created.value.content)) : {},
      ).collection;
    await registry.addDocument(source, {
      id: 'r',
      text: '  Verbatim\ntext  ',
      metadata: { title: 'Title', custom: { x: 1 } },
    });
    await registry.addDocument(source, {
      id: 'disabled',
      text: 'hidden',
      metadata: { enabled: false },
    });
    const identity = { userId: 'alice', sessionId: 'dialogue-1', admin: false };
    const target = await persistRagRecords(
      registry,
      source,
      'saved',
      undefined,
      identity,
    );
    await persistRagRecords(registry, source, 'saved', undefined, identity);
    expect((await registry.listDocuments(target.collection))?.total).toBe(1);
    expect(await registry.getDocument(target.collection, 'r')).toMatchObject({
      text: '  Verbatim\ntext  ',
      metadata: {
        title: 'Title',
        custom: { x: 1 },
        persistenceProvenance: {
          sourceCollection: source,
          sourceRecord: 'r',
          timestamp: expect.any(String),
        },
      },
    });
    for (const other of [
      { ...identity, sessionId: 'other' },
      { ...identity, userId: 'bob', admin: true },
    ])
      await expect(
        persistRagRecords(registry, source, 'saved', undefined, other),
      ).rejects.toThrow('Session collection not found');
    const coordinator = new LocalRagMcpClient(inner, () => registry, true);
    expect(
      await coordinator.callTool('rag_persist', {
        from: { scope: 'session', collection: 'scratch' },
        to: { scope: 'user', collection: 'saved' },
        records: ['r'],
      }),
    ).toMatchObject({ value: { content: expect.stringContaining('saved') } });
  });
});

test.each([
  { name: 'checker', result: 'verdict' as const, policy: 'all' as const },
  { name: 'analyst', result: 'report' as const, policy: 'read-only' as const },
])(
  '$name knowledge writes require an active dialogue worker and its own session',
  async ({ result, policy }) => {
    const { client, local, registry } = setup();
    const catalogue = ragToolNames.map((name) => ({
      name,
      effect: ragToolEffect(name),
    }));
    const permissions = () =>
      effectiveProfileTools({
        catalogue,
        grants: new Set(ragToolNames),
        result,
        policy,
      });
    const mutations = [
      ['collection_delete', { collection: 'persistent' }],
      [
        'record_add',
        { collection: 'persistent', record: 'r', text: 'changed' },
      ],
      ['record_delete', { collection: 'persistent', id: 'r' }],
    ] as const;
    await inSession(async () => {
      await client.callTool('collection_create', {
        name: 'persistent',
        scope: 'user',
      });
      await client.callTool('record_add', {
        collection: 'persistent',
        record: 'r',
        text: 'original',
      });
      const plain = permissions();
      await runWithProfileTools(plain, () =>
        runWithReadOnlyTools(async () => {
          const listed = await client.listTools();
          for (const [name, args] of mutations) {
            expect(plain.allows(name)).toBe(false);
            expect(
              listed.ok && listed.value.some((tool) => tool.name === name),
            ).toBe(false);
            expect(await client.callTool(name, args)).toMatchObject({
              value: { isError: true },
            });
          }
        }),
      );
      // Reuse permissions captured in a dialogue to bypass list filtering and
      // prove that the local execution guard rejects a lost worker context.
      const stale = runWithDialogueRagTools(permissions);
      await runWithProfileTools(stale, () =>
        runWithReadOnlyTools(async () => {
          for (const [name, args] of mutations)
            expect(await local.callTool(name, args)).toMatchObject({
              value: {
                isError: true,
                structuredContent: { error: { code: 'TOOL_FORBIDDEN' } },
              },
            });
        }),
      );
      await runWithDialogueRagTools(() =>
        runWithProfileTools(permissions(), () =>
          runWithReadOnlyTools(async () => {
            const listed = await client.listTools();
            expect(
              listed.ok &&
                listed.value.some((tool) => tool.name === 'record_add'),
            ).toBe(true);
            for (const [name, args] of mutations)
              expect(await local.callTool(name, args)).toMatchObject({
                value: { isError: true },
              });
            expect(
              await client.callTool('collection_create', {
                name: 'scratch',
              }),
            ).toMatchObject({
              value: { structuredContent: { created: true } },
            });
            expect(
              await client.callTool('record_add', {
                collection: 'scratch',
                record: 'r',
                text: 'initial',
              }),
            ).toMatchObject({
              value: { structuredContent: { created: true } },
            });
            expect(
              await client.callTool('record_update', {
                collection: 'scratch',
                record: 'r',
                text: 'updated',
              }),
            ).toMatchObject({
              value: { structuredContent: { updated: true } },
            });
            expect(
              await client.callTool('collection_create', {
                name: 'denied',
                scope: 'user',
              }),
            ).toMatchObject({ value: { isError: true } });
          }),
        ),
      );
      const persistent = (await registry.listCollections('alice')).find(
        (collection) => collection.logicalId === 'persistent',
      );
      if (!persistent) throw new Error('Persistent collection was deleted');
      expect(await registry.getDocument(persistent.id, 'r')).toMatchObject({
        text: 'original',
      });
    });
  },
);

test('worker schemas omit scope and forbidden mutations; external schemas retain scope', async () => {
  expect(
    localRagTools().find((t) => t.name === 'collection_create')?.inputSchema,
  ).toHaveProperty('properties.scope');
  runWithDialogueRagTools(() => {
    const tools = localRagTools();
    expect(
      tools.find((t) => t.name === 'collection_create')?.inputSchema,
    ).not.toHaveProperty('properties.scope');
    expect(tools.map((t) => t.name)).not.toContain('collection_delete');
    expect(tools.map((t) => t.name)).not.toContain('record_set_trust');
  });
});

test('explicit coordinator addresses do not shadow, persistence accepts equal names, and missing scopes list only owned candidates', async () => {
  const { registry, client, inner } = setup();
  const coordinator = new LocalRagMcpClient(inner, () => registry, true);
  await inSession(async () => {
    for (const scope of ['user', 'session']) {
      expect(
        await client.callTool('collection_create', { name: 'shared', scope }),
      ).toMatchObject({ value: { structuredContent: { created: true } } });
      const id =
        scope === 'user'
          ? userCollectionId('shared', 'alice')
          : sessionCollectionId(
              'shared',
              'alice',
              liveSession('alice', 'dialogue-1'),
            );
      await client.callTool('record_add', {
        collection: id,
        record: 'r',
        text: scope,
      });
    }
    for (const scope of ['user', 'session']) {
      const result = await coordinator.callTool('rag_read', {
        collection: { scope, collection: 'shared' },
        id: 'r',
      });
      expect(result).toMatchObject({
        value: { content: expect.stringContaining(`"text":"${scope}"`) },
      });
    }
    expect(
      await coordinator.callTool('rag_persist', {
        from: { scope: 'session', collection: 'shared' },
        to: { scope: 'user', collection: 'shared' },
      }),
    ).toMatchObject({ value: { content: expect.stringContaining('shared') } });
    expect(
      await registry.getDocument(userCollectionId('shared', 'alice'), 'r'),
    ).toMatchObject({ text: 'session' });
    for (const scope of ['session', 'user']) {
      const result = await coordinator.callTool('rag_read', {
        collection: { scope, collection: 'missing' },
        id: 'r',
      });
      expect(result).toMatchObject({
        value: {
          isError: true,
          content: expect.stringContaining(`${scope}/missing`),
        },
      });
      expect(result).toMatchObject({
        value: { content: expect.stringContaining(`${scope}/shared`) },
      });
    }
    const listed = await coordinator.callTool('collections_list', {});
    expect(listed).toMatchObject({
      value: {
        content: expect.stringContaining(
          '"collection":"shared","records":1,"enabled":true',
        ),
      },
    });
    expect(listed.ok && listed.value.content).not.toContain('__');
  });
});

test('worker writes never fall back to user collections and read results label their scopes', async () => {
  const { registry, client } = setup();
  await inSession(async () => {
    await client.callTool('collection_create', {
      name: 'shared',
      scope: 'user',
    });
    await client.callTool('record_add', {
      collection: 'shared',
      record: 'r',
      text: 'user',
    });
    await runWithDialogueRagTools(async () => {
      expect(
        await client.callTool('record_add', {
          collection: 'shared',
          record: 'r',
          text: 'worker',
        }),
      ).toMatchObject({
        value: {
          isError: true,
          content: expect.stringContaining('session/shared'),
        },
      });
      await client.callTool('collection_create', { name: 'shared' });
      expect(
        await client.callTool('record_add', {
          collection: 'shared',
          record: 'r',
          text: 'worker',
        }),
      ).toMatchObject({ value: { structuredContent: { created: true } } });
      expect(
        await client.callTool('rag_read', { collection: 'shared', id: 'r' }),
      ).toMatchObject({
        value: {
          content: expect.stringContaining('"collection":"session/shared"'),
        },
      });
    });
    expect(
      await registry.getDocument(userCollectionId('shared', 'alice'), 'r'),
    ).toMatchObject({ text: 'user' });
  });
});

test('dialogue addresses cannot reach another user or session, even with physical ids', async () => {
  const { registry, client, inner } = setup();
  const coordinator = new LocalRagMcpClient(inner, () => registry, true);
  await runWithSessionId(
    liveSession('bob', 'other'),
    async () => {
      await client.callTool('collection_create', {
        name: 'foreign',
        scope: 'user',
      });
    },
    [],
    'bob',
  );
  await runWithSessionId(
    liveSession('alice', 'other'),
    async () => {
      await client.callTool('collection_create', {
        name: 'foreign',
        scope: 'session',
      });
    },
    [],
    'alice',
  );
  await inSession(async () => {
    for (const scope of ['user', 'session']) {
      const result = await coordinator.callTool('collection_records', {
        collection: { scope, collection: 'foreign' },
      });
      expect(result).toMatchObject({
        value: {
          isError: true,
          content: expect.stringContaining('Candidates: (none)'),
        },
      });
    }
    for (const collection of [
      userCollectionId('foreign', 'bob'),
      sessionCollectionId('foreign', 'alice', liveSession('alice', 'other')),
    ]) {
      expect(
        await coordinator.callTool('rag_read', {
          collection: { scope: 'user', collection },
          id: 'r',
        }),
      ).toMatchObject({ value: { isError: true } });
      await runWithDialogueRagTools(async () => {
        expect(
          await client.callTool('record_add', {
            collection,
            text: 'forbidden',
          }),
        ).toMatchObject({ value: { isError: true } });
      });
    }
  });
});

test('coordinator reads global knowledge without private shadowing', async () => {
  const { registry, client, inner } = setup();
  const coordinator = new LocalRagMcpClient(inner, () => registry, true);
  await registry.createCollection({
    id: 'shared',
    logicalId: 'shared',
    displayName: 'Global',
    description: '',
    scope: 'global',
  });
  await registry.addDocument('shared', {
    id: 'r',
    text: 'global',
    metadata: {},
  });
  await inSession(async () => {
    await client.callTool('collection_create', {
      name: 'shared',
      scope: 'session',
    });
    await client.callTool('record_add', {
      collection: 'shared',
      record: 'r',
      text: 'session',
    });
    expect(
      await coordinator.callTool('rag_read', {
        collection: { scope: 'global', collection: 'shared' },
        id: 'r',
      }),
    ).toMatchObject({
      value: { content: expect.stringContaining('"text":"global"') },
    });
    for (const scope of ['global', 'session']) {
      expect(
        await coordinator.callTool('rag_search', {
          query: scope,
          collections: [{ scope, collection: 'shared' }],
        }),
      ).toMatchObject({
        value: {
          content: expect.stringContaining(`"collection":"${scope}/shared"`),
        },
      });
    }
    expect(
      await coordinator.callTool('rag_search', {
        query: 'knowledge',
        collections: [{ scope: 'global', collection: '@skills' }],
      }),
    ).not.toMatchObject({ value: { isError: true } });
    expect(
      await coordinator.callTool('collection_records', {
        collection: { scope: 'global', collection: '@skills' },
      }),
    ).toMatchObject({
      value: { content: expect.stringContaining('global/@skills') },
    });
  });
});

test('external schemas and descriptions remain canonical after role-specific discovery', () => {
  runWithDialogueRagTools(() => {
    for (const tool of localRagTools()) {
      if (
        [
          'collection_create',
          'record_add',
          'record_update',
          'record_set_enabled',
        ].includes(tool.name)
      ) {
        expect(tool.inputSchema).not.toHaveProperty('properties.scope');
        expect(tool.inputSchema).not.toHaveProperty('properties.session');
        expect(tool.inputSchema).toHaveProperty('additionalProperties', false);
      }
    }
    expect(localRagTools().map((tool) => tool.name)).toEqual([
      'collection_create',
      'record_add',
      'record_update',
      'rag_search',
      'rag_read',
      'collections_list',
      'collection_records',
      'record_set_enabled',
    ]);
  });
  expect(buildRagToolSchemas()).toEqual(
    ragToolNames
      .filter((name) => name !== 'rag_persist')
      .map((name) => ({
        type: 'function',
        function: {
          name,
          description: ragDescriptions[name],
          parameters: z.toJSONSchema(ragMcpSchemas[name], { io: 'input' }),
        },
      })),
  );
});
