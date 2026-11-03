import type {
  IMcpClient,
  IRag,
  IRetrievalEmbedder,
  McpTool,
} from '@mcp-abap-adt/llm-agent';
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { ExternalMcp, parseExternalMcp } from '../../srv/lib/external-mcp';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { runWithProfileTools } from '../../srv/request-session';

const corpus: IRag = {
  query: async () => ({
    ok: true,
    value: [
      {
        text: 'corpus',
        metadata: { id: 'tool:corpus', exposition: 'low' },
        score: 0.5,
      },
    ],
  }),
  getById: async () => ({ ok: true, value: null }),
  healthCheck: async () => ({ ok: true, value: undefined }),
};
const tools: McpTool[] = ['search_cds', 'search_ui'].map((name) => ({
  name,
  description: name,
  inputSchema: {},
}));
const embedder: IRetrievalEmbedder = {
  embedDocument: async (text) => ({
    vector: text.includes('cds') ? [1, 0] : [0, 1],
  }),
  embedQuery: async (text) => ({
    vector: text.includes('cds') ? [1, 0] : [0, 1],
  }),
};
function setup(mode = 'direct', max = '12') {
  let now = 0;
  let listed = tools;
  const client: IMcpClient = {
    listTools: async () => ({ ok: true, value: listed }),
    callTool: async () => ({ ok: true, value: { content: 'docs' } }),
  };
  const docs = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_EXECUTOR_MCP: 'DOCS',
      LLM_AGENT_MCP_SELECTION: `DOCS=${mode}`,
      LLM_AGENT_MCP_DIRECT_MAX: max,
    }),
    () => [],
    async () => client,
    jest.fn(),
    () => now,
    () => embedder,
  );
  return {
    docs,
    refresh: async (next: McpTool[]) => {
      listed = next;
      now += 30001;
      await docs.clients('executor');
      // Cached clients return before the background refresh finishes indexing.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
async function names(rag: IRag, text = 'cds', k = 1) {
  const result = await rag.query(new TextOnlyEmbedding(text), k);
  if (!result.ok) throw result.error;
  return result.value.map((row) => row.metadata.id);
}

test.each(['rejected', 'empty'])(
  '%s query embedding preserves corpus hits and direct candidates',
  async (failure) => {
    const warn = jest.fn();
    const embedQuery = jest.fn<
      ReturnType<IRetrievalEmbedder['embedQuery']>,
      Parameters<IRetrievalEmbedder['embedQuery']>
    >(async () => {
      if (failure === 'rejected') throw new Error('private query content');
      return { vector: [] };
    });
    const docs = new ExternalMcp(
      parseExternalMcp({
        LLM_AGENT_EXECUTOR_MCP: 'DIRECT,RAG',
        LLM_AGENT_MCP_SELECTION: 'DIRECT=direct,RAG=rag',
      }),
      () => [],
      async (destination) => ({
        listTools: async () => ({
          ok: true,
          value: [destination === 'DIRECT' ? tools[0] : tools[1]],
        }),
        callTool: async () => ({ ok: true, value: { content: 'docs' } }),
      }),
      warn,
      Date.now,
      () => ({ ...embedder, embedQuery }),
    );
    await docs.clients('executor');
    const options: Parameters<IRag['query']>[2] = {
      signal: new AbortController().signal,
    };
    const result = await docs
      .withToolsRag(corpus, 'executor')
      .query(new TextOnlyEmbedding('cds'), 1, options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.map((row) => row.metadata.id)).toEqual([
      'tool:corpus',
      'tool:DIRECT__search_cds',
    ]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery.mock.calls[0][1]).toBe(options);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'External docs MCP query embedding unavailable; no RAG docs hits',
    );
  },
);

test('the safety net aborts hung indexing and preserves the MCP connection', async () => {
  jest.useFakeTimers();
  try {
    const warn = jest.fn();
    const disconnect = jest.fn(async () => {});
    let finish: (value: { vector: number[] }) => void = () => {};
    const embedDocument = jest.fn<
      ReturnType<IRetrievalEmbedder['embedDocument']>,
      Parameters<IRetrievalEmbedder['embedDocument']>
    >(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const embedQuery = jest.fn(embedder.embedQuery);
    const docs = new ExternalMcp(
      parseExternalMcp({
        LLM_AGENT_EXECUTOR_MCP: 'DOCS',
        LLM_AGENT_MCP_SELECTION: 'DOCS=rag',
      }),
      () => [],
      async () => ({
        listTools: async () => ({ ok: true, value: [tools[0]] }),
        callTool: async () => ({ ok: true, value: { content: 'docs' } }),
        disconnect,
      }),
      warn,
      Date.now,
      () => ({ embedDocument, embedQuery }),
    );
    let resolved = false;
    const ready = docs.clients('executor').then((clients) => {
      resolved = true;
      return clients;
    });
    await jest.advanceTimersByTimeAsync(599_999);
    expect(resolved).toBe(false);
    expect(embedDocument).toHaveBeenCalledTimes(1);
    const signal = embedDocument.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    const clients = await ready;
    expect(clients).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'External docs MCP indexing unavailable; no docs hits',
      { destination: 'DOCS' },
    );
    expect(disconnect).not.toHaveBeenCalled();
    expect(await clients[0].callTool('search_cds', {})).toMatchObject({
      ok: true,
    });
    expect(await names(docs.withToolsRag(corpus, 'executor'))).toEqual([
      'tool:corpus',
    ]);
    expect(embedQuery).not.toHaveBeenCalled();
    // An embedder ignoring cancellation must not publish late vectors.
    finish({ vector: [1, 0] });
    await jest.advanceTimersByTimeAsync(0);
    expect(await names(docs.withToolsRag(corpus, 'executor'))).toEqual([
      'tool:corpus',
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test.each(['direct', 'rag'])(
  'indexing failure keeps a %s connection usable',
  async (mode) => {
    const warn = jest.fn();
    const disconnect = jest.fn(async () => {});
    const docs = new ExternalMcp(
      parseExternalMcp({
        LLM_AGENT_EXECUTOR_MCP: 'DOCS',
        LLM_AGENT_MCP_SELECTION: `DOCS=${mode}`,
      }),
      () => [],
      async () => ({
        listTools: async () => ({ ok: true, value: tools }),
        callTool: async () => ({ ok: true, value: { content: 'docs' } }),
        disconnect,
      }),
      warn,
      Date.now,
      () => ({
        ...embedder,
        embedDocument: async () => {
          throw new Error('offline');
        },
      }),
    );
    const clients = await docs.clients('executor');
    expect(clients).toHaveLength(1);
    expect(await clients[0].callTool('search_cds', {})).toMatchObject({
      ok: true,
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(mode === 'rag' ? 1 : 0);
    expect(await names(docs.withToolsRag(corpus, 'executor'))).toEqual(
      mode === 'rag'
        ? ['tool:corpus']
        : ['tool:corpus', 'tool:search_cds', 'tool:search_ui'],
    );
  },
);

test('selection configuration validates modes and defaults', () => {
  expect(parseExternalMcp({})).toMatchObject({ selection: {}, directMax: 12 });
  expect(
    parseExternalMcp({
      LLM_AGENT_MCP_SELECTION: '',
      LLM_AGENT_MCP_DIRECT_MAX: '',
    }),
  ).toMatchObject({ selection: {}, directMax: 12 });
  expect(
    parseExternalMcp({
      LLM_AGENT_MCP_SELECTION: ' A=rag, B=direct,C=auto ',
      LLM_AGENT_MCP_DIRECT_MAX: '3',
    }),
  ).toMatchObject({
    selection: { A: 'rag', B: 'direct', C: 'auto' },
    directMax: 3,
  });
  for (const entry of ['A=no', '=direct', 'A=rag=x', 'A='])
    expect(() => parseExternalMcp({ LLM_AGENT_MCP_SELECTION: entry })).toThrow(
      'LLM_AGENT_MCP_SELECTION',
    );
  const warn = jest
    .spyOn(cds.log('external-mcp'), 'warn')
    .mockImplementation(() => {});
  try {
    for (const value of ['0', '-1', '1.5', 'oops', 'Infinity'])
      expect(
        parseExternalMcp({ LLM_AGENT_MCP_DIRECT_MAX: value }).directMax,
      ).toBe(12);
    expect(warn).toHaveBeenCalledTimes(5);
  } finally {
    warn.mockRestore();
  }
});

test('direct tools survive corpus selection and exposition filtering, scoped by role and profile policy', async () => {
  const { docs } = setup();
  await docs.clients('executor');
  const rag = docs.withToolsRag(new ExpositionFilteringRag(corpus), 'executor');
  expect(await names(rag)).toEqual(
    expect.arrayContaining(['tool:search_cds', 'tool:search_ui']),
  );
  expect(await names(docs.withToolsRag(corpus, 'checker'))).toEqual([
    'tool:corpus',
  ]);
  expect(
    await runWithProfileTools(
      new AgentToolPermissions(['search_cds', 'corpus']),
      () => names(rag),
    ),
  ).toContain('tool:search_cds');
  expect(
    await runWithProfileTools(
      new AgentToolPermissions(['search_cds', 'corpus']),
      () => names(rag),
    ),
  ).not.toContain('tool:search_ui');
});

test('RAG uses relevant runtime tools and replaces refreshed entries', async () => {
  const { docs, refresh } = setup('rag');
  await docs.clients('executor');
  const rag = docs.withToolsRag(corpus, 'executor');
  expect(await names(rag)).toEqual(['tool:corpus', 'tool:search_cds']);
  expect(await names(rag, 'ui')).toEqual(['tool:corpus', 'tool:search_ui']);
  expect(await names(docs.withToolsRag(corpus, 'checker'))).toEqual([
    'tool:corpus',
  ]);
  await refresh([tools[1]]);
  expect(await names(rag)).not.toContain('tool:search_cds');
});

test('refresh replaces only the changed destination index and offline tools disappear', async () => {
  let now = 0;
  let first = tools;
  let offline = false;
  const document = jest.fn(embedder.embedDocument);
  const docs = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_EXECUTOR_MCP: 'A,B',
      LLM_AGENT_CHECKER_MCP: 'B',
      LLM_AGENT_MCP_SELECTION: 'A=rag,B=rag',
    }),
    () => [],
    async (destination) => ({
      listTools: async () => ({
        ok: true,
        value: destination === 'A' ? first : tools,
      }),
      callTool: async () => {
        if (offline) throw new Error('offline');
        return { ok: true, value: { content: 'docs' } };
      },
    }),
    jest.fn(),
    () => now,
    () => ({ ...embedder, embedDocument: document }),
  );
  const clients = await docs.clients('executor');
  expect(document).toHaveBeenCalledTimes(4);
  first = [tools[1]];
  now = 30001;
  await docs.clients('executor');
  expect(document).toHaveBeenCalledTimes(5);
  expect(await names(docs.withToolsRag(corpus, 'checker'))).toEqual([
    'tool:corpus',
    'tool:B__search_cds',
  ]);
  expect(
    await names(docs.withToolsRag(corpus, 'executor'), 'cds', 4),
  ).not.toContain('tool:A__search_cds');
  offline = true;
  await clients[1].callTool('B__search_cds', {});
  expect(docs.toolNames('checker')).toEqual([]);
  expect(await names(docs.withToolsRag(corpus, 'checker'))).toEqual([
    'tool:corpus',
  ]);
});

test('auto resolves at the inclusive count boundary and logs once per discovery', async () => {
  const info = jest
    .spyOn(cds.log('external-mcp'), 'info')
    .mockImplementation(() => {});
  try {
    const { docs, refresh } = setup('auto', '2');
    await docs.clients('executor');
    await docs.clients('executor');
    expect(docs.mode('DOCS')).toBe('direct');
    expect(info).toHaveBeenCalledWith('External docs MCP connected', {
      destination: 'DOCS',
      mode: 'direct',
      tools: ['search_cds', 'search_ui'],
    });
    expect(info).toHaveBeenCalledTimes(1);
    await refresh([
      ...tools,
      { name: 'third', description: 'other', inputSchema: {} },
    ]);
    expect(docs.mode('DOCS')).toBe('rag');
    expect(info).toHaveBeenCalledTimes(2);
  } finally {
    info.mockRestore();
  }
});

test('planner descriptions mention docs only for connected roles', async () => {
  const { docs } = setup();
  const workers = [
    { name: 'executor', description: 'Execute', result: 'report' as const },
    { name: 'checker', description: 'Check', result: 'report' as const },
  ];
  expect(docs.describeWorkers(workers)).toEqual(workers);
  await docs.clients('executor');
  const described = docs.describeWorkers(workers);
  expect(described[0].description).toContain(
    'external documentation (search_cds, search_ui)',
  );
  expect(described[1]).toEqual(workers[1]);
});

test('skills default to system and correction while collection classes stay informational', async () => {
  const resolver = new TrustResolver(
    undefined,
    undefined,
    parseTrustDefaults(undefined),
  );
  expect(await resolver.skill('base')).toBe(4.8);
  expect(await resolver.skill('override', false, 'correction')).toBe(4.9);
  expect(
    ['global', 'user', 'session'].map((scope) =>
      resolver.classDefault(
        scope === 'global' ? 'global' : scope === 'user' ? 'user' : 'session',
      ),
    ),
  ).toEqual([3, 3.5, 4]);
});
