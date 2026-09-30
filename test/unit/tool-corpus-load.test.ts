jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);
// No destination service: the request path below must fail on the corpus alone.
jest.mock('../../srv/lib/btp-destinations', () => ({
  getAvailableDestinations: async () => [],
}));

import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import {
  getSmartAgent,
  initProviders,
  loadToolCorpus,
  resetToolCorpusReadersForTest,
  setBundleReaderForTest,
  setCatalogReaderForTest,
  ToolCorpusMissingError,
} from '../../srv/agent-manager';
import { corpusByRole, toolRecordAttributes } from '../../srv/lib/tool-corpus';

const docs = [
  {
    id: 'tool:ReadClass',
    name: 'ReadClass',
    text: 'read a class',
    exposition: 'read',
    cached: true,
  },
  {
    id: 'tool:CreateClass',
    name: 'CreateClass',
    text: 'create a class',
    exposition: 'high',
    cached: true,
  },
];

type FakeP = {
  __bundle?: unknown;
  __records?: Record<string, unknown>;
  __qdrantDown?: boolean;
};
// The most recently built fake: the bundle seam receives only a file name, so
// it reads the bundle of the providers the test just built.
let lastP: FakeP | undefined;

function fakeProviders(
  backend: 'in-memory' | 'vector' | 'qdrant',
  opts: {
    bundle?: unknown;
    records?: Record<string, unknown>;
    qdrantDown?: boolean;
  } = {},
) {
  const embedCalls: string[] = [];
  const embedder = {
    embed: async (t: string) => {
      embedCalls.push(t);
      return { vector: [1, 0] };
    },
  };
  const p = {
    embedding:
      backend === 'in-memory'
        ? null
        : {
            embedder,
            breaker: {},
            fingerprint: {
              provider: 'ollama',
              embeddingModel: 'bge-m3',
              baseURL: 'http://localhost:11434',
            },
          },
    stores: {
      backendOf: () => backend,
      create: () => new InMemoryRag(),
      createLocal: () => new InMemoryRag(),
      qdrantCollection: (n: string) => `hub-${n}`,
      listStores: async () => ({ ok: true, value: [] }),
      countPoints: async () => ({ ok: true, value: 1 }),
      deleteStore: async () => ({ ok: true, value: undefined }),
    },
    destinations: { list: async () => [], clearCache() {} },
    __bundle: opts.bundle,
    __records: opts.records,
    __qdrantDown: opts.qdrantDown,
  };
  lastP = p;
  return { embedCalls, p };
}

beforeEach(() => {
  lastP = undefined;
  setBundleReaderForTest(() => (lastP?.__bundle ?? null) as never);
  setCatalogReaderForTest(async (p) => {
    const f = p as unknown as FakeP;
    if (f.__qdrantDown)
      throw new Error('Qdrant catalog unreachable at http://localhost:6433');
    return new Map(Object.entries(f.__records ?? {}));
  });
});

afterEach(() => resetToolCorpusReadersForTest());

describe('loadToolCorpus', () => {
  it('in-memory: loads texts, embeds nothing', async () => {
    const { p, embedCalls } = fakeProviders('in-memory');
    const r = await loadToolCorpus(p as never, docs);
    expect(r.count).toBe(2);
    expect(embedCalls).toEqual([]);
  });

  it('vector without a matching bundle: explicit error naming the build step, nothing embedded', async () => {
    const { p, embedCalls } = fakeProviders('vector', { bundle: null });
    await expect(loadToolCorpus(p as never, docs)).rejects.toThrow(
      ToolCorpusMissingError,
    );
    await expect(loadToolCorpus(p as never, docs)).rejects.toThrow(
      /generate-tool-embeddings/,
    );
    expect(embedCalls).toEqual([]);
  });

  it('qdrant without completion records: explicit error; Qdrant down: explicit error naming Qdrant', async () => {
    await expect(
      loadToolCorpus(fakeProviders('qdrant', { records: {} }).p as never, docs),
    ).rejects.toThrow(ToolCorpusMissingError);
    await expect(
      loadToolCorpus(
        fakeProviders('qdrant', { qdrantDown: true }).p as never,
        docs,
      ),
    ).rejects.toThrow(/Qdrant/);
  });

  it('qdrant: loads the fixed role stores when both records carry the current hashes', async () => {
    const fp = {
      provider: 'ollama',
      embeddingModel: 'bge-m3',
      baseURL: 'http://localhost:11434',
    };
    const roles = corpusByRole(docs);
    const rec = (role: 'reader' | 'writer') =>
      toolRecordAttributes(role, fp, roles[role]);
    const { p, embedCalls } = fakeProviders('qdrant', {
      records: {
        'hub-tools-reader': rec('reader'),
        'hub-tools-writer': rec('writer'),
      },
    });
    expect((await loadToolCorpus(p as never, docs)).count).toBe(2);
    expect(embedCalls).toEqual([]);

    // A stale writer record (built for another corpus): explicit, per role.
    const stale = fakeProviders('qdrant', {
      records: {
        'hub-tools-reader': rec('reader'),
        'hub-tools-writer': { ...rec('writer'), corpus: '000000000000' },
      },
    }).p;
    await expect(loadToolCorpus(stale as never, docs)).rejects.toThrow(
      /writer: record is stale/,
    );
    // Another embedder's record is stale too.
    const otherFp = fakeProviders('qdrant', {
      records: {
        'hub-tools-reader': { ...rec('reader'), fingerprint: 'ffffffffffff' },
        'hub-tools-writer': rec('writer'),
      },
    }).p;
    await expect(loadToolCorpus(otherFp as never, docs)).rejects.toThrow(
      /reader: record is stale/,
    );
    // No record at all.
    const missing = fakeProviders('qdrant', {
      records: { 'hub-tools-reader': rec('reader') },
    }).p;
    const err = await loadToolCorpus(missing as never, docs).catch((e) => e);
    expect(err).toBeInstanceOf(ToolCorpusMissingError);
    expect(err.message).toMatch(/writer: no record/);
    expect(err.message).toMatch(/generate-tool-embeddings/);
  });

  it('qdrant: a skill upsert never reaches the build-owned role stores, and is still found', async () => {
    const fp = {
      provider: 'ollama',
      embeddingModel: 'bge-m3',
      baseURL: 'http://localhost:11434',
    };
    const roles = corpusByRole(docs);
    const { p } = fakeProviders('qdrant', {
      records: {
        'hub-tools-reader': toolRecordAttributes('reader', fp, roles.reader),
        'hub-tools-writer': toolRecordAttributes('writer', fp, roles.writer),
      },
    });
    // The Qdrant role stores: any write reaching them is the defect.
    const roleWrites: string[] = [];
    const roleStore = () => {
      const rag = new InMemoryRag();
      const w = rag.writer();
      return Object.assign(rag, {
        writer: () => ({
          ...w,
          upsertRaw: async (id: string, ...rest: unknown[]) => {
            roleWrites.push(id);
            return (w.upsertRaw as (...a: unknown[]) => unknown)(id, ...rest);
          },
        }),
      });
    };
    Object.assign(p.stores, { create: roleStore });
    const { store } = await loadToolCorpus(p as never, docs);
    const text = 'Skill: creating-domain\nCreate an ABAP domain';
    const w = store.writer();
    if (!w) throw new Error('store is not writable');
    expect((await w.upsertRaw('skill:creating-domain', text, {})).ok).toBe(
      true,
    );
    expect(
      (await store.upsert(text, { id: 'skill:creating-domain-2' })).ok,
    ).toBe(true);
    expect(roleWrites).toEqual([]);

    const res = await store.query({ text: 'creating domain' } as never, 5, {
      ragFilter: { exposition: ['read'] },
    });
    if (!res.ok) throw res.error;
    expect(res.value.map((r) => r.metadata.id)).toEqual(
      expect.arrayContaining(['skill:creating-domain']),
    );
  });

  it('uncached tools: explicit error, no LLM enrichment', async () => {
    const { p } = fakeProviders('in-memory');
    await expect(
      loadToolCorpus(p as never, [{ ...docs[0], cached: false }]),
    ).rejects.toThrow(ToolCorpusMissingError);
  });
});

const FP = {
  provider: 'ollama',
  embeddingModel: 'bge-m3',
  baseURL: 'http://localhost:11434',
};

/** A tools backend whose writer records precomputed writes and answers with `result`. */
function spyStore(
  writes: string[],
  result: () => { ok: boolean; error?: { message: string } },
) {
  const writer = {
    upsertRaw: async () => ({ ok: true, value: undefined }),
    deleteByIdRaw: async () => ({ ok: true, value: false }),
    upsertPrecomputedRaw: async (id: string) => {
      writes.push(id);
      const r = result();
      return r.ok ? { ok: true, value: undefined } : r;
    },
  };
  return {
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    writer: () => writer,
  };
}

const matchingBundle = {
  header: { embedderFingerprint: FP, embeddingDim: 2 },
  entries: docs.map((d) => ({ ...d, vector: [1, 0] })),
};

describe('loadToolCorpus, vector backend with a matching bundle', () => {
  it('loads every entry from the bundle, embeds nothing', async () => {
    const { p, embedCalls } = fakeProviders('vector', {
      bundle: matchingBundle,
    });
    const writes: string[] = [];
    p.stores.create = (() => spyStore(writes, () => ({ ok: true }))) as never;
    const r = await loadToolCorpus(p as never, docs);
    expect(r.count).toBe(docs.length);
    expect(embedCalls).toEqual([]);
    expect(writes.sort()).toEqual(docs.map((d) => d.id).sort());
  });

  it('translates queries by default; translateQueries:false builds the store without a preprocessor', async () => {
    const seen: unknown[] = [];
    const build = async (opts?: { translateQueries?: boolean }) => {
      const { p } = fakeProviders('vector', { bundle: matchingBundle });
      p.stores.create = ((_c: string, _n: string, o?: unknown) => {
        seen.push(
          (o as { queryPreprocessors?: unknown[] })?.queryPreprocessors,
        );
        return spyStore([], () => ({ ok: true }));
      }) as never;
      await loadToolCorpus(p as never, docs, opts);
    };
    await build();
    expect(seen).toHaveLength(2);
    for (const pre of seen) expect(pre).toHaveLength(1);
    seen.length = 0;
    await build({ translateQueries: false });
    expect(seen).toEqual([undefined, undefined]);
  });

  it('a failed write rejects the load, naming the tool', async () => {
    const { p } = fakeProviders('vector', { bundle: matchingBundle });
    const writes: string[] = [];
    p.stores.create = (() =>
      spyStore(writes, () => ({
        ok: false,
        error: { message: 'store down' },
      }))) as never;
    await expect(loadToolCorpus(p as never, docs)).rejects.toThrow(
      /tool:ReadClass: store down/,
    );
  });
});

describe('a request that needs tools when the corpus is missing', () => {
  const prevWait = process.env.LLM_AGENT_DESTINATION_INIT_WAIT_MS;
  beforeAll(() => {
    process.env.LLM_AGENT_DESTINATION_INIT_WAIT_MS = '50';
  });
  afterAll(() => {
    if (prevWait === undefined)
      delete process.env.LLM_AGENT_DESTINATION_INIT_WAIT_MS;
    else process.env.LLM_AGENT_DESTINATION_INIT_WAIT_MS = prevWait;
  });

  it('gets a 503 naming the missing corpus and the build step, not "still initializing"', async () => {
    const { p, embedCalls } = fakeProviders('vector', { bundle: null });
    initProviders(p as never);
    const err = (await getSmartAgent(undefined, 'SAP_DEV').catch(
      (e: unknown) => e,
    )) as Error & { statusCode?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/were not built/);
    expect(err.message).toMatch(/generate-tool-embeddings/);
    expect(err.message).not.toMatch(/still initializing/);
    expect(embedCalls).toEqual([]);
  });

  it('gets a 503 naming Qdrant when the Qdrant catalog is unreachable', async () => {
    const { p } = fakeProviders('qdrant', { qdrantDown: true });
    initProviders(p as never);
    const err = (await getSmartAgent(undefined, 'SAP_DEV').catch(
      (e: unknown) => e,
    )) as Error & { statusCode?: number };
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/Qdrant catalog unreachable/);
  });
});
