import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  InMemoryRag,
  RagError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  ExpositionFilteringRag,
  loadToolCorpus,
  resetToolCorpusReadersForTest,
  setCatalogReaderForTest,
  ToolCorpusMissingError,
} from '../../srv/agent-manager';
import type { Providers } from '../../srv/lib/providers';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';
import {
  corpusByRole,
  type SharedCorpusDoc,
  toolRecordAttributes,
} from '../../srv/lib/tool-corpus';
import {
  assertToolSearchHealthy,
  toolSearchFailure,
} from '../../srv/lib/tool-search-health';
import {
  qdrantMultivectorConfig,
  qdrantQueryFetch,
} from './helpers/qdrant-fetch';

const docs: SharedCorpusDoc[] = [
  {
    id: 'tool:ReadA',
    name: 'ReadA',
    text: 'read A',
    readOnlyHint: true,
    cached: true,
  },
  {
    id: 'tool:ReadB',
    name: 'ReadB',
    text: 'read B',
    readOnlyHint: true,
    cached: true,
  },
  {
    id: 'tool:WriteA',
    name: 'WriteA',
    text: 'write A',
    readOnlyHint: false,
    cached: true,
  },
  {
    id: 'tool:WriteB',
    name: 'WriteB',
    text: 'write B',
    readOnlyHint: false,
    cached: true,
  },
];
const fingerprint = { provider: 'test', embeddingModel: 'test' };
const breaker = new CircuitBreaker();
const embedder = new CircuitBreakerEmbedder(
  { embed: async () => ({ vector: [1, 0] }) },
  breaker,
);

function providers(): Providers {
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: {
        tools: 'in-memory',
        session: 'in-memory',
        persistent: 'in-memory',
      },
    },
    null,
  );
  return {
    embedding: {
      embedder,
      breaker,
      retrieval: symmetricEmbedder(embedder),
      fingerprint,
    },
    stores: {
      ...stores,
      backendOf: () => 'qdrant',
      countPoints: async () => ({ ok: true, value: 2 }),
    },
    destinations: {
      list: async () => [],
      metadata: async () => undefined,
      refuse: () => null,
      clearCache() {},
    },
  };
}

beforeEach(() => {
  const roles = corpusByRole(docs);
  setCatalogReaderForTest(
    async (p) =>
      new Map([
        [
          p.stores.qdrantCollection('tools-reader'),
          toolRecordAttributes('reader', fingerprint, roles.reader),
        ],
        [
          p.stores.qdrantCollection('tools-writer'),
          toolRecordAttributes('writer', fingerprint, roles.writer),
        ],
      ]),
  );
});
afterEach(() => {
  resetToolCorpusReadersForTest();
  jest.restoreAllMocks();
});

test.each([
  ['reader', 1],
  ['writer', 1],
  ['writer', 3],
] as const)(
  'startup refuses a current catalog with %s collection count %i instead of 2',
  async (role, count) => {
    const p = providers();
    const counts = jest
      .spyOn(p.stores, 'countPoints')
      .mockImplementation(async (_cls, name) => ({
        ok: true,
        value: name.endsWith(role) ? count : 2,
      }));
    await expect(
      loadToolCorpus(p, docs, { translateQueries: false }),
    ).rejects.toThrow(ToolCorpusMissingError);
    await expect(
      loadToolCorpus(p, docs, { translateQueries: false }),
    ).rejects.toThrow(
      `${role}: cloud-llm-hub-tools-${role} has ${count} points; expected 2`,
    );
    expect(counts).toHaveBeenCalledWith('tools', `tools-${role}`);
  },
);

test.each(['reader', 'writer', 'both'])(
  'startup accepts an empty %s collection with warnings and searches return no tools',
  async (empty) => {
    const p = providers();
    jest
      .spyOn(p.stores, 'countPoints')
      .mockImplementation(async (_cls, name) => ({
        ok: true,
        value: empty === 'both' || name.endsWith(empty) ? 0 : 2,
      }));
    const warn = jest
      .spyOn(cds.log('tool-rag'), 'warn')
      .mockImplementation(() => {});
    const skills = jest.spyOn(p.stores, 'createLocalTools');
    const { store } = await loadToolCorpus(p, docs, {
      translateQueries: false,
      toolGate: 'off',
    });
    expect(skills).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(empty === 'both' ? 2 : 1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('is empty; no tools available'),
    );
    expect(
      await store.query(new TextOnlyEmbedding('read and write'), 5, {
        ragFilter: { exposition: ['high'] },
      }),
    ).toEqual({ ok: true, value: [] });
    expect(toolSearchFailure()).toBeUndefined();
  },
);

test('startup accepts exact counts in both role collections', async () => {
  const p = providers();
  const counts = jest.spyOn(p.stores, 'countPoints');
  expect(
    (await loadToolCorpus(p, docs, { translateQueries: false })).count,
  ).toBe(4);
  expect(counts.mock.calls).toEqual([
    ['tools', 'tools-reader'],
    ['tools', 'tools-writer'],
  ]);
});

test('a count backend failure is explicit and is not mistaken for a valid corpus', async () => {
  const p = providers();
  jest.spyOn(p.stores, 'countPoints').mockResolvedValue({
    ok: false,
    error: new RagError('Qdrant unavailable', 'RAG_COUNT_ERROR'),
  });
  await expect(
    loadToolCorpus(p, docs, { translateQueries: false }),
  ).rejects.toThrow('Qdrant unavailable');
});

test('a Qdrant tool-search outage marks health DOWN and recovers only after a successful backend query', async () => {
  const embedding = {
    embedder,
    breaker,
    retrieval: symmetricEmbedder(embedder),
    fingerprint,
  };
  const stores = createRagStoreFactory(
    {
      embedder: null,
      backends: { tools: 'qdrant', session: 'qdrant', persistent: 'qdrant' },
      qdrant: { url: 'http://qdrant.invalid', prefix: 'hub' },
    },
    embedding,
  );
  let offline = true;
  const query = jest.fn(() => {
    if (offline) throw new Error('Qdrant offline');
    return Response.json({ result: { points: [] } });
  });
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(qdrantQueryFetch(qdrantMultivectorConfig(2), query));
  const rag = new ExpositionFilteringRag(
    stores.create('tools', 'tools-reader'),
    undefined,
    undefined,
    3,
    undefined,
    embedding.retrieval,
    'off',
  );
  try {
    expect((await rag.query(new TextOnlyEmbedding('read'), 5)).ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(toolSearchFailure()).toBeDefined();
    await expect(assertToolSearchHealthy()).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(query).toHaveBeenCalledTimes(2);
    offline = false;
    await assertToolSearchHealthy();
    expect(query).toHaveBeenCalledTimes(3);
    expect(toolSearchFailure()).toBeUndefined();
    expect(await rag.query(new TextOnlyEmbedding('read'), 5)).toEqual({
      ok: true,
      value: [],
    });
    // An empty ordinary collection remains a successful, empty search.
    expect(
      await stores
        .create('persistent', 'empty')
        .query(new TextOnlyEmbedding('read'), 5),
    ).toEqual({ ok: true, value: [] });
  } finally {
    offline = false;
    await assertToolSearchHealthy();
  }
});

test('empty in-memory collections keep returning no results', async () => {
  expect(
    await new InMemoryRag().query(new TextOnlyEmbedding('read'), 5),
  ).toEqual({ ok: true, value: [] });
});
