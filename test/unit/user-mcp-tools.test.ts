import {
  type IRag,
  type IRetrievalEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { parseExternalMcp } from '../../srv/lib/external-mcp';
import { LongSessionRegistry } from '../../srv/lib/long-session';
import { buildEmbedding } from '../../srv/lib/providers';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';
import {
  journalOutcome,
  journalSnapshotSchema,
  writeActions,
} from '../../srv/lib/tool-journal';
import {
  assertToolSearchHealthy,
  toolSearchFailure,
  withToolSearchHealth,
} from '../../srv/lib/tool-search-health';
import { resolverFor } from '../../srv/lib/trust-resolver';
import {
  UserMcpBridge,
  type UserMcpCall,
  userMcpRegistration,
} from '../../srv/lib/user-mcp-bridge';
import {
  userMcpClient,
  userMcpToolTrust,
  withUserMcpToolsRag,
} from '../../srv/lib/user-mcp-tools';
import {
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithSessionId,
} from '../../srv/request-session';

const read = {
  name: 'read',
  description: 'Read documentation',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};
const write = {
  name: 'write',
  description: 'Change a record',
  inputSchema: { type: 'object' },
};
const destructive = {
  ...read,
  name: 'destructive',
  annotations: { readOnlyHint: true, destructiveHint: true },
};
const documents = { name: 'documents', transport: 'browser', tools: [read] };
const catalogue = userMcpRegistration.parse({
  servers: [
    { ...documents, tools: [read, write, destructive] },
    {
      name: 'records',
      transport: 'companion',
      roles: ['analyst', 'executor'],
      writes: true,
      tools: [read, write, destructive],
    },
  ],
});

function openSessions() {
  const registry = new LongSessionRegistry(
    { ttlMs: 100, maxSessions: 3, maxPerUser: 2, queueLength: 0 },
    { onClose: async () => {} },
  );
  const session = registry.open('alice', { key: 'session' });
  const other = registry.open('alice', { key: 'other' });
  const bob = registry.open('bob', { key: 'session' });
  if ('refused' in session || 'refused' in other || 'refused' in bob)
    throw new Error('Could not open sessions');
  const bridge = new UserMcpBridge();
  bridge.register(catalogue.servers);
  session.userMcp = bridge;
  const scope = <T>(fn: () => T) =>
    runWithSessionId(session.key, fn, [], session.userId, {
      channel: 'openai',
      admin: false,
      userMcpSession: session,
    });
  return { registry, session, other, bob, bridge, scope };
}

test('role filtering, default read-only, write opt-in and profile ceilings apply to listing and dispatch', async () => {
  const { scope, bridge } = openSessions();
  const client = userMcpClient('executor');
  const list = (role: string) =>
    scope(async () => {
      const result = await userMcpClient(role).listTools();
      if (!result.ok) throw result.error;
      return result.value.map((tool) => tool.name);
    });
  for (const role of ['planner', 'planner-author', 'coordinator', 'custom'])
    expect(await list(role)).toEqual([]);
  expect(await list('checker')).toEqual(['user__documents__read']);
  for (const role of ['executor', 'analyst'])
    expect(await list(role)).toEqual([
      'user__documents__read',
      'user__records__read',
      'user__records__write',
      'user__records__destructive',
    ]);
  const send = jest.fn(() => true);
  bridge.subscribe('browser', ['documents'], {
    executorId: 'browser-a',
    send,
    close: () => {},
  });
  bridge.subscribe('companion', ['records'], {
    executorId: 'companion-a',
    send,
    close: () => {},
  });
  const checkForbidden = (result: ReturnType<typeof client.callTool>) =>
    expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOOL_FORBIDDEN' },
    });
  await scope(async () => {
    for (const role of ['planner', 'planner-author', 'coordinator'])
      await checkForbidden(
        userMcpClient(role).callTool('user__documents__read', {}),
      );
    await checkForbidden(client.callTool('user__documents__write', {}));
    await checkForbidden(
      userMcpClient('checker').callTool('user__records__read', {}),
    );
    await runWithReadOnlyTools(() =>
      checkForbidden(client.callTool('user__records__destructive', {})),
    );
    await runWithProfileTools(new AgentToolPermissions([]), () =>
      checkForbidden(client.callTool('user__records__read', {})),
    );
  });
  expect(send).not.toHaveBeenCalled();
});

test('the recorder offers checker reads and blocks writes despite the server write opt-in', async () => {
  const { scope, bridge } = openSessions();
  bridge.register(
    userMcpRegistration.parse({
      servers: [{ ...documents, writes: true, tools: [read, destructive] }],
    }).servers,
  );
  const send = jest.fn((call: UserMcpCall) =>
    bridge.answer(call.callId, { result: { content: 'document' } }),
  );
  bridge.subscribe('browser', ['documents'], {
    executorId: 'browser-a',
    send,
    close: () => {},
  });
  const recorder = new RecordingMcpClient({
    listTools: async () => ({ ok: true, value: [] }),
    callTool: jest.fn(),
  }).includeClients([], userMcpClient('checker'));
  const options = { trace: { traceId: 'checker-read' } };
  await scope(() =>
    runWithReadOnlyTools(async () => {
      const listed = await recorder.listTools();
      if (!listed.ok) throw listed.error;
      expect(listed.value.map(({ name }) => name)).toEqual([
        'user__documents__read',
      ]);
      await expect(
        recorder.callTool('user__documents__destructive', {}, options),
      ).resolves.toMatchObject({ ok: true, value: { isError: true } });
      await expect(
        recorder.callTool('user__documents__read', {}, options),
      ).resolves.toMatchObject({ ok: true, value: { content: 'document' } });
    }),
  );
  expect(send).toHaveBeenCalledTimes(1);
  const entries = recorder.getToolJournal('checker-read');
  expect(entries).toMatchObject([{ system: 'user-mcp', write: false }]);
  expect(writeActions(entries)).toBeUndefined();
});

test.each([
  ['tool error', 'failed'],
  ['unknown reply', 'unconfirmed'],
  ['cancellation', 'unconfirmed'],
  ['session close', 'unconfirmed'],
] as const)(
  'records a user MCP write after %s as %s',
  async (settlement, outcome) => {
    const { scope, bridge } = openSessions();
    const sent: UserMcpCall[] = [];
    bridge.subscribe('companion', ['records'], {
      executorId: 'companion-a',
      send: (call) => {
        sent.push(call);
        return true;
      },
      close: () => {},
    });
    const recorder = new RecordingMcpClient({
      listTools: async () => ({ ok: true, value: [] }),
      callTool: jest.fn(),
    }).includeClients([], userMcpClient('executor'));
    const requestId = 'user-write';
    const signal = new AbortController();
    const pending = scope(() =>
      recorder.callTool(
        'user__records__write',
        {},
        {
          trace: { traceId: requestId },
          signal: signal.signal,
        },
      ),
    );
    expect(sent).toHaveLength(1);
    expect(journalOutcome(recorder.getToolJournal(requestId)[0])).toBe(
      'unconfirmed',
    );
    if (settlement === 'tool error')
      bridge.answer(sent[0].callId, { error: 'Write failed' });
    else if (settlement === 'unknown reply')
      bridge.answer(sent[0].callId, { outcome: 'unknown' });
    else if (settlement === 'cancellation') signal.abort();
    else bridge.close();
    const result = await pending;
    if (outcome === 'unconfirmed')
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'USER_MCP_OUTCOME_UNKNOWN' },
      });
    const entries = journalSnapshotSchema.parse({
      requestId,
      entries: recorder.getToolJournal(requestId),
    }).entries;
    expect(entries).toMatchObject([{ system: 'user-mcp', write: true }]);
    expect(writeActions(entries)).toContain(
      JSON.stringify({
        callId: entries[0].call.id,
        system: 'user-mcp',
        operation: 'user__records__write',
        targets: [],
        outcome,
      }),
    );
  },
);

test.each(['missing', 'query', 'empty query', 'document'])(
  'ranked user MCP search fails on %s and stays down until its probe succeeds',
  async (failure) => {
    const { scope } = openSessions();
    const base: IRag = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({ ok: true, value: undefined }),
    };
    let broken = true;
    const embedder: IRetrievalEmbedder = {
      embedQuery: async () => {
        if (broken && failure === 'query') throw new Error('Private query');
        return { vector: broken && failure === 'empty query' ? [] : [1, 0] };
      },
      embedDocument: async () => {
        if (broken && failure === 'document')
          throw new Error('Private document');
        return { vector: [1, 0] };
      },
    };
    const config = parseExternalMcp({
      LLM_AGENT_MCP_SELECTION: 'user__records=rag,user__documents=direct',
    });
    const rag = withUserMcpToolsRag(base, 'executor', config, () =>
      broken && failure === 'missing' ? undefined : embedder,
    );
    const search = () =>
      scope(() => rag.query(new TextOnlyEmbedding('read'), 1));
    try {
      expect(await search()).toMatchObject({
        ok: false,
        error: { code: 'TOOL_SEARCH_UNAVAILABLE' },
      });
      expect(withToolSearchHealth({ status: 200, body: {} })).toMatchObject({
        status: 503,
        body: {
          status: 'DOWN',
          toolSearch: {
            error:
              'Tool search unavailable: user MCP (executor) backend or embedder failed',
          },
        },
      });
      await expect(assertToolSearchHealthy()).rejects.toMatchObject({
        statusCode: 503,
      });
      broken = false;
      await assertToolSearchHealthy();
      expect(toolSearchFailure()).toBeUndefined();
      expect(await search()).toMatchObject({
        ok: true,
        value: [
          { metadata: { id: 'tool:user__records__read' } },
          { metadata: { id: 'tool:user__documents__read' } },
        ],
      });
    } finally {
      broken = false;
      await assertToolSearchHealthy();
    }
  },
);

test.each([
  ['empty vector', []],
  ['non-finite vector', [NaN, 0]],
  ['wrong dimension', [1]],
  ['provider rejects the document', undefined],
] as const)(
  'isolates a private catalogue with %s',
  async (_failure, vector) => {
    const { bridge, bob, scope } = openSessions();
    bridge.register(
      userMcpRegistration.parse({
        servers: [
          {
            ...documents,
            tools: [{ ...read, description: 'Invalid document' }],
          },
        ],
      }).servers,
    );
    bob.userMcp = new UserMcpBridge();
    bob.userMcp.register(
      catalogue.servers.filter((server) => server.name === documents.name),
    );
    const base: IRag = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({ ok: true, value: undefined }),
    };
    const embedDocument = jest.fn(async (text: string) => {
      if (text.endsWith('Invalid document')) {
        if (!vector) throw new Error('Provider rejected private input');
        return { vector: [...vector] };
      }
      return { vector: [1, 0] };
    });
    const rag = withUserMcpToolsRag(
      base,
      'executor',
      parseExternalMcp({
        LLM_AGENT_MCP_SELECTION: 'user__documents=rag,user__records=direct',
      }),
      () => ({
        embedQuery: async () => ({ vector: [1, 0] }),
        embedDocument,
      }),
    );
    const search = () => rag.query(new TextOnlyEmbedding('read'), 1);
    expect(await scope(search)).toMatchObject({
      ok: false,
      error: {
        code: 'USER_MCP_CATALOGUE_INVALID',
        message: 'USER_MCP_CATALOGUE_INVALID: Could not index documents/read',
      },
    });
    expect(toolSearchFailure()).toBeUndefined();
    await assertToolSearchHealthy();
    const result = await runWithSessionId(bob.key, search, [], bob.userId, {
      channel: 'openai',
      admin: false,
      userMcpSession: bob,
    });
    expect(result).toMatchObject({
      ok: true,
      value: [{ metadata: { id: 'tool:user__documents__read' } }],
    });
    expect(embedDocument.mock.calls.map(([input]) => input)).toEqual([
      expect.stringContaining('Invalid document'),
      ...(vector ? [] : ['tool search readiness probe']),
      expect.stringContaining('Read documentation'),
    ]);
  },
);

test('document outage recovery probes only infrastructure even after the owner replaces its catalogue', async () => {
  const { bridge, scope } = openSessions();
  bridge.register(
    userMcpRegistration.parse({
      servers: [
        {
          ...documents,
          tools: [{ ...read, description: 'Private description' }],
        },
      ],
    }).servers,
  );
  const base: IRag = {
    query: async () => ({ ok: true, value: [] }),
    getById: async () => ({ ok: true, value: null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
  let broken = true;
  const embedDocument = jest.fn(async (text: string) => {
    if (broken || text.endsWith('Private description'))
      throw new Error('Could not index document');
    return { vector: [1, 0] };
  });
  const rag = withUserMcpToolsRag(
    base,
    'executor',
    parseExternalMcp({ LLM_AGENT_MCP_SELECTION: 'user__documents=rag' }),
    () => ({
      embedQuery: async () => ({ vector: [1, 0] }),
      embedDocument,
    }),
  );
  try {
    expect(
      await scope(() => rag.query(new TextOnlyEmbedding('read'), 1)),
    ).toMatchObject({
      ok: false,
      error: { code: 'TOOL_SEARCH_UNAVAILABLE' },
    });
    bridge.register(catalogue.servers);
    embedDocument.mockClear();
    broken = false;
    await assertToolSearchHealthy();
    expect(embedDocument.mock.calls).toEqual([['tool search readiness probe']]);
    expect(toolSearchFailure()).toBeUndefined();
  } finally {
    broken = false;
    await assertToolSearchHealthy();
  }
});

test('private document rejections leave the production embedding breaker untouched', async () => {
  const { scope } = openSessions();
  const provider = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockImplementation(async (text) => {
      if (text.startsWith('Tool:'))
        throw new Error('Provider rejected private input');
      return { vector: [1, 0] };
    });
  try {
    const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
    if (!embedding) throw new Error('Embedding missing');
    const failures = jest.spyOn(embedding.breaker, 'recordFailure');
    const base: IRag = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({ ok: true, value: undefined }),
    };
    const rag = withUserMcpToolsRag(
      base,
      'executor',
      parseExternalMcp({ LLM_AGENT_MCP_SELECTION: 'user__documents=rag' }),
      () => embedding.userMcpToolSearchRetrieval,
    );
    await expect(
      scope(() => rag.query(new TextOnlyEmbedding('read'), 1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'USER_MCP_CATALOGUE_INVALID' },
    });
    expect(failures).not.toHaveBeenCalled();
    expect(toolSearchFailure()).toBeUndefined();
  } finally {
    provider.mockRestore();
  }
});

test('unregistering a write before delivery revokes it without an uncertain outcome', async () => {
  const { bridge, scope } = openSessions();
  const attempted: UserMcpCall[] = [];
  bridge.subscribe('companion', ['records'], {
    executorId: 'companion-a',
    send: (event) => {
      attempted.push(event);
      bridge.unregister();
      return false;
    },
    close: () => {},
  });
  await expect(
    scope(() => userMcpClient('executor').callTool('user__records__write', {})),
  ).resolves.toMatchObject({ ok: false, error: { code: 'USER_MCP_REVOKED' } });
  expect(attempted).toHaveLength(1);
  expect(
    bridge.answer(attempted[0].callId, { result: { content: 'late' } }),
  ).toBe(false);
  const send = jest.fn(() => true);
  bridge.subscribe('companion', ['records'], {
    executorId: 'companion-a',
    send,
    close: () => {},
  });
  expect(send).not.toHaveBeenCalled();
});

test('a write that could not be sent goes to the next executor as a first delivery', async () => {
  const { bridge, scope } = openSessions();
  const attempted: UserMcpCall[] = [];
  bridge.subscribe('companion', ['records'], {
    executorId: 'companion-a',
    send: (event) => {
      attempted.push(event);
      return false;
    },
    close: () => {},
  });
  const pending = scope(() =>
    userMcpClient('executor').callTool('user__records__write', { id: '1' }),
  );
  expect(attempted).toHaveLength(1);
  const [event] = attempted;
  const send = jest.fn((_event: UserMcpCall) => true);
  bridge.subscribe('companion', ['records'], {
    executorId: 'companion-b',
    send,
    close: () => {},
  });
  expect(send.mock.calls).toEqual([[event]]);
  const result = { content: 'stored' };
  expect(bridge.answer(event.callId, { result })).toBe(true);
  await expect(pending).resolves.toMatchObject({ ok: true, value: result });
});

test('a compatible replacement preserves replay until the read registration is removed', async () => {
  const { bridge, scope } = openSessions();
  const original: UserMcpCall[] = [];
  const detach = bridge.subscribe('browser', ['documents'], {
    executorId: 'browser-a',
    send: (event) => {
      original.push(event);
      return true;
    },
    close: () => {},
  });
  const pending = scope(() =>
    userMcpClient('executor').callTool('user__documents__read', {}),
  );
  detach();
  const [event] = original;
  expect(event).toBeDefined();
  bridge.register(catalogue.servers);
  const send = jest.fn((_event: UserMcpCall) => true);
  bridge.subscribe('browser', ['documents'], {
    executorId: 'browser-b',
    send,
    close: () => {},
  });
  expect(send).toHaveBeenCalledWith({ ...event, replay: true });
  bridge.unregister('documents');
  await expect(pending).resolves.toMatchObject({
    ok: false,
    error: { code: 'USER_MCP_REVOKED' },
  });
  expect(bridge.answer(event.callId, { result: { content: 'late' } })).toBe(
    false,
  );
});

test('one shared tool client isolates users, session instances and the agent MCP channel', async () => {
  const { scope, session, other, bob, registry } = openSessions();
  const client = userMcpClient('executor');
  expect(await scope(() => client.listTools())).toMatchObject({
    ok: true,
    value: expect.arrayContaining([{ ...read, name: 'user__documents__read' }]),
  });
  expect(scope(() => client.cacheable)).toBe(false);
  for (const [owner, channel] of [
    [other, 'openai'],
    [bob, 'anthropic'],
    [session, 'mcp-agent'],
  ] as const) {
    await runWithSessionId(
      owner.key,
      async () => {
        expect(await client.listTools()).toEqual({ ok: true, value: [] });
        expect(client.cacheable).toBe(true);
        await expect(
          client.callTool('user__documents__read', {}),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'TOOL_FORBIDDEN' },
        });
      },
      [],
      owner.userId,
      { channel, admin: false, userMcpSession: owner },
    );
  }
  await registry.close(session.userId, session.key, 'explicit');
  const replacement = registry.open(session.userId, {
    key: session.key,
    revived: true,
  });
  expect(replacement).not.toHaveProperty('userMcp');
  expect(await scope(() => client.listTools())).toEqual({
    ok: true,
    value: [],
  });
});

test.each(['auto', 'rag', 'direct'] as const)(
  'uses the external MCP %s selection mode in the session corpus',
  async (mode) => {
    const { scope } = openSessions();
    const base: IRag = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({ ok: true, value: undefined }),
    };
    const config = parseExternalMcp({
      LLM_AGENT_MCP_SELECTION: `user__records=${mode},user__documents=direct`,
      LLM_AGENT_MCP_DIRECT_MAX: '1',
    });
    const embedDocument = jest.fn(async (text: string) => ({
      vector: text.includes('read') ? [1, 0] : [0, 1],
    }));
    const rag = withUserMcpToolsRag(base, 'executor', config, () => ({
      embedDocument,
      embedQuery: async () => ({ vector: [1, 0] }),
    }));
    const query = new TextOnlyEmbedding('documentation');
    const result = await scope(() => rag.query(query, 1));
    if (!result.ok) throw result.error;
    expect(
      result.value.some(
        (hit) => hit.metadata.id === 'tool:user__documents__read',
      ),
    ).toBe(true);
    expect(
      result.value.some(
        (hit) => hit.metadata.id === 'tool:user__records__read',
      ),
    ).toBe(true);
    expect(
      result.value.some(
        (hit) => hit.metadata.id === 'tool:user__records__write',
      ),
    ).toBe(mode === 'direct');
    expect(embedDocument).toHaveBeenCalledTimes(mode === 'direct' ? 0 : 3);
    expect(await rag.query(query, 1)).toEqual({
      ok: true,
      value: [],
    });
  },
);

test('registered tool results have user MCP provenance below target and docs', () => {
  const { scope } = openSessions();
  const resolver = resolverFor({});
  expect(userMcpToolTrust('user__documents__read', resolver)).toBeUndefined();
  expect(
    scope(() => userMcpToolTrust('user__documents__unregistered', resolver)),
  ).toBeUndefined();
  const trust = scope(() =>
    userMcpToolTrust('user__documents__read', resolver),
  );
  expect(trust).toEqual({
    source: 'user-mcp:user__documents__read',
    trust: 4.1,
  });
  expect(trust?.trust).toBeLessThan(resolver.classDefault('target'));
  expect(trust?.trust).toBeLessThan(resolver.classDefault('docs'));
});
