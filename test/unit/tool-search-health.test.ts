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
import { buildEmbedding, type Embedding } from '../../srv/lib/providers';
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
