/**
 * The tool-corpus build step against a real, throwaway Qdrant (spec §4.4).
 *
 * Skipped unless LLM_AGENT_QDRANT_URL is set. Never point it at a shared
 * Qdrant: port 6333 is refused. Run with:
 *   LLM_AGENT_QDRANT_URL=http://localhost:6433 \
 *     npx jest --testMatch='**' test/integration/tool-generation.qdrant.test.ts
 *
 * No real embedding endpoint is called: `LLM_AGENT_EMBEDDER=openai` selects
 * `resolveEmbedder`, which is mocked to a deterministic 8-dim embedder derived
 * from the text hash, so `startProviders` builds the real Qdrant stores around
 * a fake embedder.
 */
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

const mockEmbedCalls: string[] = [];
jest.mock('@mcp-abap-adt/llm-agent-rag', () => {
  const { createHash } = jest.requireActual('node:crypto');
  return {
    ...jest.requireActual('@mcp-abap-adt/llm-agent-rag'),
    prefetchEmbedderFactories: async () => {},
    resolveEmbedder: () => ({
      embed: async (text: string) => {
        mockEmbedCalls.push(text);
        const h: Buffer = createHash('sha256').update(text).digest();
        return { vector: [...h.subarray(0, 8)].map((b) => b / 255 + 0.01) };
      },
    }),
  };
});

import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import {
  getSharedCorpusDocs,
  loadToolCorpus,
  ToolCorpusMissingError,
} from '../../srv/agent-manager';
import { type Providers, startProviders } from '../../srv/lib/providers';
import { toolCatalogProvider } from '../../srv/lib/rag-store-factory';
import {
  corpusByRole,
  corpusHash,
  fingerprintHash,
  type SharedCorpusDoc,
  toolStoreName,
} from '../../srv/lib/tool-corpus';
import {
  buildQdrantStores,
  decideToolBuild,
} from '../../tools/generate-tool-embeddings';

const QDRANT = process.env.LLM_AGENT_QDRANT_URL;
if (QDRANT && /:6333\b/.test(QDRANT))
  throw new Error('use an isolated Qdrant port');
const d = QDRANT ? describe : describe.skip;

jest.setTimeout(300_000);

const PREFIX = `clh-t9-${Date.now().toString(36)}`;
const quiet = { throttleMs: 0, log: () => {} };

async function qdrant(path: string, init?: RequestInit) {
  const res = await fetch(`${QDRANT}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { result: any };
}

/** storeName of every catalog record. */
async function records(): Promise<string[]> {
  const r = await qdrant(`/collections/${PREFIX}-catalog/points/scroll`, {
    method: 'POST',
    body: JSON.stringify({ limit: 100, with_payload: true }),
  });
  return r.result.points.map((x: any) => x.payload.store_name).sort();
}

/** Every collection this run's prefix owns, catalog excluded. */
async function ownCollections(): Promise<string[]> {
  const r = await qdrant('/collections');
  return (r.result.collections as { name: string }[])
    .map((c) => c.name)
    .filter((n) => n.startsWith(`${PREFIX}-`) && n !== `${PREFIX}-catalog`)
    .sort();
}

d('tool-corpus build step on Qdrant', () => {
  const saved = { ...process.env };
  let p: Providers;
  let docs: SharedCorpusDoc[];
  let changed: SharedCorpusDoc[];
  let collections: { reader: string; writer: string };
  let config: ReturnType<typeof loadAgentConfig>;

  const embedding = () => {
    if (!p.embedding) throw new Error('expected an embedder');
    return p.embedding;
  };
  /** Catalog records: collection → attributes. */
  const catalog = async () => {
    const q = config.rag.qdrant;
    if (!q) throw new Error('expected a Qdrant config');
    const r = await toolCatalogProvider(
      q,
      embedding().embedder,
    ).describeCollections();
    if (!r.ok) throw r.error;
    return new Map(r.value.records.map((x) => [x.storeName, x.attributes]));
  };

  beforeAll(async () => {
    delete process.env.LLM_AGENT_RAG_TYPE;
    process.env.LLM_AGENT_TOOLS_RAG_BACKEND = 'qdrant';
    process.env.LLM_AGENT_EMBEDDER = 'openai';
    process.env.LLM_AGENT_EMBEDDER_API_KEY = 'unused-fake';
    process.env.LLM_AGENT_QDRANT_PREFIX = PREFIX;
    clearAgentConfig();
    config = loadAgentConfig();
    p = await startProviders(config);
    docs = getSharedCorpusDocs();
    // The same corpus with one reader tool's enriched text changed.
    const firstReader = corpusByRole(docs).reader[0];
    changed = docs.map((x) =>
      x.id === firstReader.id ? { ...x, text: `${x.text} (changed)` } : x,
    );
    collections = {
      reader: p.stores.qdrantCollection(toolStoreName('reader')),
      writer: p.stores.qdrantCollection(toolStoreName('writer')),
    };
  });

  afterAll(async () => {
    const r = await qdrant('/collections');
    for (const c of r.result.collections as { name: string }[])
      if (c.name.startsWith(`${PREFIX}-`))
        await qdrant(`/collections/${c.name}`, { method: 'DELETE' });
    process.env = { ...saved };
    clearAgentConfig();
  });

  beforeEach(() => {
    mockEmbedCalls.length = 0;
  });

  it('decides to build on Qdrant', () => {
    expect(
      decideToolBuild(config, embedding().fingerprint, docs, () => null),
    ).toEqual({ action: 'build-qdrant' });
  });

  it('first run writes both fixed-name role stores and records their hashes', async () => {
    const built = await buildQdrantStores(config, p, docs, quiet);
    expect(built).toEqual(['reader', 'writer']);
    expect(mockEmbedCalls).toHaveLength(docs.length + 2); // + canary twice
    const roles = corpusByRole(docs);
    expect(await ownCollections()).toEqual(
      [collections.reader, collections.writer].sort(),
    );
    const cat = await catalog();
    for (const role of ['reader', 'writer'] as const) {
      expect(await p.stores.countPoints('tools', toolStoreName(role))).toEqual({
        ok: true,
        value: roles[role].length,
      });
      expect(cat.get(collections[role])).toEqual({
        kind: 'tool-corpus',
        role,
        fingerprint: fingerprintHash(embedding().fingerprint),
        corpus: corpusHash(roles[role]),
        count: roles[role].length,
      });
    }
  });

  it('a rerun with the same corpus skips with zero embed calls', async () => {
    const logs: string[] = [];
    const built = await buildQdrantStores(config, p, docs, {
      ...quiet,
      log: (l) => logs.push(l),
    });
    expect(built).toEqual([]);
    expect(mockEmbedCalls).toHaveLength(0);
    expect(logs).toEqual([
      'reader: current, skipped',
      'writer: current, skipped',
    ]);
  });

  it('startup loads the current stores with zero embed calls', async () => {
    clearAgentConfig(); // the catalog reader resolves Qdrant from this config
    const { count } = await loadToolCorpus(p, docs);
    expect(count).toBe(docs.length);
    expect(mockEmbedCalls).toHaveLength(0);
  });

  it('a changed tool text replaces only that role, in place', async () => {
    const before = await catalog();
    const built = await buildQdrantStores(config, p, changed, quiet);
    expect(built).toEqual(['reader']);
    const roles = corpusByRole(changed);
    expect(mockEmbedCalls).toHaveLength(roles.reader.length + 2);
    // Still exactly one store per role, nothing left behind.
    expect(await ownCollections()).toEqual(
      [collections.reader, collections.writer].sort(),
    );
    expect(await p.stores.countPoints('tools', 'tools-reader')).toEqual({
      ok: true,
      value: roles.reader.length,
    });
    const after = await catalog();
    expect(after.get(collections.reader)).toEqual(
      expect.objectContaining({ corpus: corpusHash(roles.reader) }),
    );
    expect(after.get(collections.writer)).toEqual(
      before.get(collections.writer),
    );
  });

  it('startup rejects a stale record with ToolCorpusMissingError', async () => {
    clearAgentConfig();
    // The stores now hold `changed`; a runtime corpus of `docs` does not match.
    const err = await loadToolCorpus(p, docs).catch((e) => e);
    expect(err).toBeInstanceOf(ToolCorpusMissingError);
    expect(err.message).toMatch(/reader: record is stale/);
    expect(err.message).not.toMatch(/writer/);
    // And the current corpus loads, without embedding.
    expect((await loadToolCorpus(p, changed)).count).toBe(changed.length);
    expect(mockEmbedCalls).toHaveLength(0);
  });

  it('a store left without a record (interrupted build) is replaced', async () => {
    // Drop only the record: the store stays, as a build cut before its record.
    await qdrant(`/collections/${PREFIX}-catalog/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          must: [{ key: 'store_name', match: { value: collections.writer } }],
        },
      }),
    });
    expect((await catalog()).has(collections.writer)).toBe(false);
    const built = await buildQdrantStores(config, p, changed, quiet);
    expect(built).toEqual(['writer']);
    expect(await ownCollections()).toEqual(
      [collections.reader, collections.writer].sort(),
    );
    expect((await catalog()).has(collections.writer)).toBe(true);
  });
});
