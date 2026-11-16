import type { Server } from 'node:http';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  InMemoryRag,
  type IRag,
  QueryEmbedding,
  RagError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import express from 'express';
import {
  ExpositionFilteringRag,
  getSmartAgent,
  isAgentReady,
} from '../../srv/agent-manager';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { withDialogueRagTools } from '../../srv/lib/dialogue-rag-tools';
import { ExternalMcp, parseExternalMcp } from '../../srv/lib/external-mcp';
import {
  agentQueryEmbedder,
  buildEmbedding,
  type Embedding,
} from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';
import {
  assertToolSearchHealthy,
  queryToolCorpus,
  toolSearchFailure,
  toolSearchReadinessGuard,
  withToolSearchHealth,
} from '../../srv/lib/tool-search-health';
import { handleChatCompletions } from '../../srv/openai-handler';

let recover: () => void = () => {};
afterEach(async () => {
  recover();
  await assertToolSearchHealthy();
  jest.restoreAllMocks();
});

function failingStore() {
  let failed = true;
  let thrown = false;
  const error = new RagError('private backend response', 'QUERY_ERROR');
  const store = new InMemoryRag();
  const query = jest.spyOn(store, 'query').mockImplementation(async () => {
    if (thrown) throw error;
    return failed ? { ok: false, error } : { ok: true, value: [] };
  });
  const repair = () => {
    failed = false;
    thrown = false;
  };
  return {
    store,
    query,
    error,
    repair,
    throwError: () => {
      thrown = true;
    },
  };
}

test('tool corpus errors survive docs and dialogue wrappers, set health DOWN, and refuse all destinations and models', async () => {
  const backend = failingStore();
  recover = backend.repair;
  const docs = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    async () => ({
      listTools: async () => ({
        ok: true,
        value: [{ name: 'docs_search', description: 'docs', inputSchema: {} }],
      }),
      callTool: async () => ({ ok: true, value: { content: 'docs' } }),
    }),
  );
  await docs.clients('executor');
  const rag = withDialogueRagTools(
    docs.withToolsRag(new ExpositionFilteringRag(backend.store), 'executor'),
  );
  const result = await rag.query(new TextOnlyEmbedding('read class'), 5);
  expect(result).toEqual({ ok: false, error: backend.error });
  expect(isAgentReady()).toBe(false);
  expect(withToolSearchHealth({ status: 200, body: { status: 'UP' } })).toEqual(
    {
      status: 503,
      body: {
        status: 'DOWN',
        toolSearch: {
          error: expect.stringMatching(
            /reader tool corpus.*backend or embedder failed/,
          ),
        },
      },
    },
  );
  expect(toolSearchFailure()).not.toContain('private');
  for (const destination of [undefined, 'SAP_A', 'SAP_B']) {
    await expect(
      getSmartAgent('request-model', destination),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'tool_search_unavailable',
      message: expect.stringContaining('reader tool corpus'),
    });
  }
  backend.repair();
  await assertToolSearchHealthy();
  expect(withToolSearchHealth({ status: 200, body: { status: 'UP' } })).toEqual(
    { status: 200, body: { status: 'UP' } },
  );
});

test.each(['writer', 'skills'] as const)(
  'a %s search failure is global and requires that store to recover',
  async (role) => {
    const backend = failingStore();
    recover = backend.repair;
    const rag = new ExpositionFilteringRag(
      new InMemoryRag(),
      role === 'writer' ? backend.store : undefined,
      role === 'skills' ? backend.store : undefined,
    );
    expect(
      (
        await rag.query(new TextOnlyEmbedding('read'), 5, {
          ragFilter: { exposition: ['high'] },
        })
      ).ok,
    ).toBe(false);
    await expect(assertToolSearchHealthy()).rejects.toThrow(
      `${role} tool corpus`,
    );
    backend.repair();
    await assertToolSearchHealthy();
    expect(toolSearchFailure()).toBeUndefined();
  },
);

test('thrown backend failures also become an explicit Result error and mark health DOWN', async () => {
  const backend = failingStore();
  recover = backend.repair;
  backend.throwError();
  const result = await new ExpositionFilteringRag(backend.store).query(
    new TextOnlyEmbedding('read'),
    5,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'TOOL_SEARCH_UNAVAILABLE' },
  });
  await expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
});

test('caller cancellation never marks the hub unhealthy', async () => {
  const backend = failingStore();
  recover = backend.repair;
  const controller = new AbortController();
  controller.abort();
  const result = await new ExpositionFilteringRag(backend.store).query(
    new TextOnlyEmbedding('read'),
    5,
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  expect(toolSearchFailure()).toBeUndefined();
});

test('every failed store must recover before the hub becomes healthy', async () => {
  const reader = failingStore();
  const writer = failingStore();
  recover = () => {
    reader.repair();
    writer.repair();
  };
  const rag = new ExpositionFilteringRag(reader.store, writer.store);
  await rag.query(new TextOnlyEmbedding('read and write'), 5, {
    ragFilter: { exposition: ['high'] },
  });
  reader.repair();
  await expect(assertToolSearchHealthy()).rejects.toThrow('writer tool corpus');
  expect(toolSearchFailure()).not.toContain('reader tool corpus');
  writer.repair();
  await assertToolSearchHealthy();
  expect(toolSearchFailure()).toBeUndefined();
});

test('docs MCP failures alone leave tool-search health UP', async () => {
  const docs = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    async () => {
      throw new Error('docs offline');
    },
    () => {},
  );
  await docs.clients('executor');
  const rag = withDialogueRagTools(
    docs.withToolsRag(
      new ExpositionFilteringRag(new InMemoryRag()),
      'executor',
    ),
  );
  expect((await rag.query(new TextOnlyEmbedding('read'), 5)).ok).toBe(true);
  expect(toolSearchFailure()).toBeUndefined();
});

test('concurrent requests share a probe and an older successful probe cannot clear a new failure', async () => {
  const store = {};
  let finish: (result: Awaited<ReturnType<IRag['query']>>) => void = () => {};
  const probe = jest.fn(
    () =>
      new Promise<Awaited<ReturnType<IRag['query']>>>((resolve) => {
        finish = resolve;
      }),
  );
  const fail = async () => ({
    ok: false as const,
    error: new RagError('offline'),
  });
  const success = async () => ({ ok: true as const, value: [] });
  await queryToolCorpus(store, 'reader (qdrant)', fail, probe);
  const first = expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  const second = expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(probe).toHaveBeenCalledTimes(1);
  await queryToolCorpus(store, 'reader (qdrant)', fail, success);
  finish({ ok: true, value: [] });
  await Promise.all([first, second]);
  await assertToolSearchHealthy();
  expect(toolSearchFailure()).toBeUndefined();
});

test('the HTTP health endpoint stays DOWN until an agent request probes successfully', async () => {
  const backend = failingStore();
  recover = backend.repair;
  await new ExpositionFilteringRag(backend.store).query(
    new TextOnlyEmbedding('read'),
    5,
  );
  const app = express();
  app.use(express.json());
  // Exercise the real channel entry points independently of server middleware.
  app.post('/openai', handleChatCompletions);
  app.post('/anthropic', handleAnthropicMessages);
  app.get('/health', (_req, res) => {
    const health = withToolSearchHealth({
      status: 200,
      body: { status: 'UP' },
    });
    res.status(health.status).json(health.body);
  });
  app.use('/agent', toolSearchReadinessGuard);
  app.post('/agent', (_req, res) => {
    res.json({ ok: true });
  });
  let server: Server | undefined;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${url}/health`)).status).toBe(503);
    const refused = await fetch(`${url}/agent`, { method: 'POST' });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('reader tool corpus');
    for (const path of ['/openai', '/anthropic']) {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('tool_search_unavailable');
    }
    backend.repair();
    expect((await fetch(`${url}/health`)).status).toBe(503);
    expect((await fetch(`${url}/agent`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  } finally {
    server?.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('vector tools fail with an open embedder breaker while non-tool stores retain keyword fallback', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const embedder = new CircuitBreakerEmbedder(
    { embed: async () => ({ vector: [1, 0] }) },
    breaker,
  );
  const embedding: Embedding = {
    embedder,
    breaker,
    retrieval: symmetricEmbedder(embedder),
    fingerprint: { provider: 'test', embeddingModel: 'test' },
  };
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: { tools: 'vector', session: 'vector', persistent: 'vector' },
    },
    embedding,
  );
  const tools = new ExpositionFilteringRag(stores.create('tools', 'reader'));
  breaker.recordFailure();
  recover = () => breaker.recordSuccess();
  expect((await tools.query(new TextOnlyEmbedding('read'), 5)).ok).toBe(false);
  expect(toolSearchFailure()).toBeDefined();
  expect(
    await stores
      .create('session', 'empty')
      .query(new TextOnlyEmbedding('read'), 5),
  ).toEqual({ ok: true, value: [] });
  breaker.recordSuccess();
  await assertToolSearchHealthy();
});

test.each([
  ['vector', 'reader'],
  ['vector', 'writer'],
  ['vector', 'skills'],
  ['qdrant', 'reader'],
  ['qdrant', 'writer'],
  ['qdrant', 'skills'],
] as const)(
  '%s %s production composition preserves the first HTTP 503 without retrying and recovers only after a successful probe',
  async (backend, role) => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ result: [] })),
      );
    const raw = jest
      .spyOn(SapAiCoreEmbedder.prototype, 'embed')
      .mockResolvedValue({ vector: [1, 0] })
      .mockRejectedValueOnce(
        Object.assign(new Error('HTTP 503'), { status: 503 }),
      );
    const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
    if (!embedding) throw new Error('Missing embedder');
    const stores = createRagStoreFactory(
      {
        embedder: null,
        backends: { tools: backend, session: 'vector', persistent: 'vector' },
        qdrant: { url: 'http://qdrant.invalid', prefix: 'hub' },
      },
      embedding,
    );
    const store =
      role === 'skills'
        ? stores.createLocalTools()
        : stores.create('tools', role);
    const rag = new ExpositionFilteringRag(
      role === 'reader' ? store : new InMemoryRag(),
      role === 'writer' ? store : undefined,
      role === 'skills' ? store : undefined,
      3,
      undefined,
      agentQueryEmbedder(embedding, 'tool-search'),
      'off',
      undefined,
      undefined,
      undefined,
      undefined,
      backend,
      embedding.probeQueryEmbedder,
    );
    const result = await rag.query(
      new QueryEmbedding('read tool', embedding.retrieval),
      5,
      { ragFilter: { exposition: ['high'] } },
    );
    expect(result.ok).toBe(false);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAgentReady()).toBe(false);
    expect(withToolSearchHealth({ status: 200, body: {} }).status).toBe(503);
    expect(toolSearchFailure()).toContain(`${role} tool corpus`);

    // An ordinary successful search must not clear the recorded outage.
    expect((await store.query(new TextOnlyEmbedding('read tool'), 1)).ok).toBe(
      true,
    );
    expect(raw).toHaveBeenCalledTimes(2);
    expect(withToolSearchHealth({ status: 200, body: {} }).status).toBe(503);

    raw.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 503'), { status: 503 }),
    );
    await expect(assertToolSearchHealthy()).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(raw).toHaveBeenCalledTimes(3);
    expect(toolSearchFailure()).toBeDefined();
    await assertToolSearchHealthy();
    expect(raw).toHaveBeenCalledTimes(4);
    expect(toolSearchFailure()).toBeUndefined();
    expect(withToolSearchHealth({ status: 200, body: {} }).status).toBe(200);
  },
);

test.each([
  Object.assign(new Error('HTTP 400'), { status: 400 }),
  Object.assign(new Error('HTTP 429'), { status: 429 }),
  Object.assign(new Error('HTTP 500'), { status: 500 }),
  Object.assign(new Error('HTTP 502'), { status: 502 }),
  Object.assign(new Error('HTTP 503'), { status: 503 }),
  Object.assign(new Error('HTTP 504'), { status: 504 }),
  new TypeError('fetch failed'),
])(
  'store-owned production tool embeddings propagate %s on the first call',
  async (error) => {
    const raw = jest
      .spyOn(SapAiCoreEmbedder.prototype, 'embed')
      .mockResolvedValue({ vector: [1, 0] })
      .mockRejectedValueOnce(error);
    const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
    if (!embedding) throw new Error('Missing embedder');
    const stores = createRagStoreFactory(
      {
        embedder: null,
        backends: { tools: 'vector', session: 'vector', persistent: 'vector' },
      },
      embedding,
    );
    const tools = new ExpositionFilteringRag(stores.create('tools', 'reader'));
    expect((await tools.query(new TextOnlyEmbedding('read tool'), 1)).ok).toBe(
      false,
    );
    expect(raw).toHaveBeenCalledTimes(1);
    expect(withToolSearchHealth({ status: 200, body: {} }).status).toBe(503);
    await assertToolSearchHealthy();
    expect(raw).toHaveBeenCalledTimes(2);
    expect(toolSearchFailure()).toBeUndefined();
  },
);

test.each(['session', 'persistent'] as const)(
  'non-tool %s queries retain the production composed retry after HTTP 503',
  async (cls) => {
    jest.useFakeTimers();
    try {
      const raw = jest
        .spyOn(SapAiCoreEmbedder.prototype, 'embed')
        .mockResolvedValue({ vector: [1, 0] })
        .mockRejectedValueOnce(
          Object.assign(new Error('HTTP 503'), { status: 503 }),
        );
      const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
      if (!embedding) throw new Error('Missing embedder');
      const stores = createRagStoreFactory(
        {
          embedder: null,
          backends: {
            tools: 'vector',
            session: 'vector',
            persistent: 'vector',
          },
        },
        embedding,
      );
      const result = stores
        .create(cls, 'empty')
        .query(new TextOnlyEmbedding('read'), 1);
      await jest.runAllTimersAsync();
      expect(await result).toEqual({ ok: true, value: [] });
      expect(raw).toHaveBeenCalledTimes(2);
      expect(toolSearchFailure()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  },
);

test('docs MCP production query embedding fails on the first HTTP 503 and stays unhealthy until a fresh probe succeeds', async () => {
  const embedQuery = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockResolvedValue({ vector: [1, 0] });
  const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
  if (!embedding) throw new Error('Missing embedder');
  const docs = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_EXECUTOR_MCP: 'DOCS',
      LLM_AGENT_MCP_SELECTION: 'DOCS=rag',
    }),
    () => [],
    async () => ({
      listTools: async () => ({
        ok: true,
        value: [{ name: 'search', description: 'docs', inputSchema: {} }],
      }),
      callTool: async () => ({ ok: true, value: { content: 'docs' } }),
    }),
    undefined,
    undefined,
    () => embedding.toolSearchRetrieval,
    () => embedding.probeQueryEmbedder,
  );
  await docs.clients('executor');
  embedQuery.mockClear();
  embedQuery.mockRejectedValueOnce(
    Object.assign(new Error('HTTP 503'), { status: 503 }),
  );
  const rag = docs.withToolsRag(new InMemoryRag(), 'executor');
  expect((await rag.query(new TextOnlyEmbedding('docs'), 1)).ok).toBe(false);
  expect(embedQuery).toHaveBeenCalledTimes(1);
  expect(isAgentReady()).toBe(false);
  expect(toolSearchFailure()).toContain('external docs MCP');
  expect((await rag.query(new TextOnlyEmbedding('docs'), 1)).ok).toBe(true);
  expect(embedQuery).toHaveBeenCalledTimes(2);
  expect(withToolSearchHealth({ status: 200, body: {} }).status).toBe(503);
  embedQuery.mockRejectedValueOnce(
    Object.assign(new Error('HTTP 503'), { status: 503 }),
  );
  await expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(embedQuery).toHaveBeenCalledTimes(3);
  await assertToolSearchHealthy();
  expect(embedQuery).toHaveBeenCalledTimes(4);
  expect(toolSearchFailure()).toBeUndefined();
});

test('the production embedder probe recovers an open breaker immediately without waiting for its recovery window', async () => {
  let failed = true;
  const raw = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockImplementation(async () => {
      if (failed) throw new Error('embedder offline');
      return { vector: [1, 0] };
    });
  const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
  if (!embedding || !embedding.probeQueryEmbedder)
    throw new Error('Missing embedder');
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: { tools: 'vector', session: 'vector', persistent: 'vector' },
    },
    embedding,
  );
  const rag = new ExpositionFilteringRag(
    stores.create('tools', 'reader'),
    undefined,
    undefined,
    3,
    undefined,
    embedding.retrieval,
    'off',
    undefined,
    undefined,
    undefined,
    undefined,
    'vector',
    embedding.probeQueryEmbedder,
  );
  for (let i = 0; i < 30; i++) embedding.breaker.recordFailure();
  expect(embedding.breaker.state).toBe('open');
  recover = () => {
    failed = false;
  };
  expect(
    (await rag.query(new QueryEmbedding('read', embedding.retrieval), 5)).ok,
  ).toBe(false);
  expect(raw).not.toHaveBeenCalled();
  await expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  failed = false;
  await assertToolSearchHealthy();
  expect(embedding.breaker.state).toBe('closed');
  expect(raw).toHaveBeenCalled();
  expect(toolSearchFailure()).toBeUndefined();
});

test('local skills fail with an open breaker and recover through the raw embedder probe', async () => {
  let failed = true;
  const raw = jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockImplementation(async () => {
      if (failed) throw new Error('embedder offline');
      return { vector: [1, 0] };
    });
  const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
  if (!embedding) throw new Error('Missing embedder');
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: { tools: 'qdrant', session: 'vector', persistent: 'vector' },
      qdrant: { url: 'http://qdrant.invalid', prefix: 'hub' },
    },
    embedding,
  );
  const rag = new ExpositionFilteringRag(
    new InMemoryRag(),
    undefined,
    stores.createLocalTools(),
    3,
    undefined,
    embedding.retrieval,
    'off',
    undefined,
    undefined,
    undefined,
    undefined,
    'qdrant',
    embedding.probeQueryEmbedder,
  );
  recover = () => {
    failed = false;
  };
  for (let i = 0; i < 30; i++) embedding.breaker.recordFailure();
  expect((await rag.query(new TextOnlyEmbedding('skill'), 5)).ok).toBe(false);
  expect(toolSearchFailure()).toContain('skills tool corpus (qdrant)');
  expect(raw).not.toHaveBeenCalled();
  await expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  failed = false;
  await assertToolSearchHealthy();
  expect(embedding.breaker.state).toBe('closed');
  expect(toolSearchFailure()).toBeUndefined();
  expect(await rag.query(new TextOnlyEmbedding('skill'), 5)).toEqual({
    ok: true,
    value: [],
  });
});

test('docs query probes bypass an open production embedder breaker', async () => {
  let failed = false;
  jest
    .spyOn(SapAiCoreEmbedder.prototype, 'embed')
    .mockImplementation(async () => {
      if (failed) throw new Error('embedder offline');
      return { vector: [1, 0] };
    });
  const embedding = buildEmbedding({ kind: 'sap-ai-core', model: 'test' });
  if (!embedding) throw new Error('Missing embedder');
  const docs = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_EXECUTOR_MCP: 'DOCS',
      LLM_AGENT_MCP_SELECTION: 'DOCS=rag',
    }),
    () => [],
    async () => ({
      listTools: async () => ({
        ok: true,
        value: [{ name: 'search', description: 'docs', inputSchema: {} }],
      }),
      callTool: async () => ({ ok: true, value: { content: 'docs' } }),
    }),
    undefined,
    undefined,
    () => embedding.retrieval,
    () => embedding.probeQueryEmbedder,
  );
  await docs.clients('executor');
  failed = true;
  recover = () => {
    failed = false;
  };
  for (let i = 0; i < 30; i++) embedding.breaker.recordFailure();
  const rag = docs.withToolsRag(new InMemoryRag(), 'executor');
  expect((await rag.query(new TextOnlyEmbedding('docs'), 1)).ok).toBe(false);
  await expect(assertToolSearchHealthy()).rejects.toMatchObject({
    statusCode: 503,
  });
  failed = false;
  await assertToolSearchHealthy();
  expect(embedding.breaker.state).toBe('closed');
  expect(toolSearchFailure()).toBeUndefined();
  expect((await rag.query(new TextOnlyEmbedding('docs'), 1)).ok).toBe(true);
});
