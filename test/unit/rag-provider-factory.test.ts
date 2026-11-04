import type { RagConfig } from '../../srv/agent-config';
import type { Embedding } from '../../srv/lib/providers';
import {
  createCollectionProvider,
  providerVectorDimension,
  type RagCtors,
} from '../../srv/lib/rag-provider-factory';
import { createRagStoreFactory } from '../../srv/lib/rag-store-factory';

const retrieval = { id: 'retrieval' };
const embedding = { retrieval } as unknown as Embedding;
const env = {
  VCAP_SERVICES: JSON.stringify({
    hana: [
      {
        name: 'hdi',
        credentials: {
          host: 'h',
          port: '443',
          schema: 'SCH',
          user: 'RT',
          password: 'SECRET',
        },
      },
    ],
  }),
};

type Args = Record<string, any>;

function fakes() {
  const calls: Record<string, Args[]> = {};
  const mk = (k: string) =>
    class {
      constructor(cfg: Args) {
        calls[k] = [...(calls[k] ?? []), cfg];
      }
    };
  const ctors = {
    HanaVectorRagProvider: mk('hanaProvider'),
    PgVectorRagProvider: mk('pgProvider'),
    QdrantRagProvider: mk('qdrantProvider'),
  } as unknown as RagCtors;
  return { calls, ctors };
}

const cfg = (
  kind: string,
  extra: Partial<RagConfig> = {},
  session = 'in-memory',
): RagConfig =>
  ({
    embedder: null,
    backends: { tools: 'in-memory', session, persistent: kind },
    ...extra,
  }) as RagConfig;

describe('createCollectionProvider', () => {
  it.each(['in-memory', 'vector'])('is null for %s', (k) => {
    const { ctors, calls } = fakes();
    expect(createCollectionProvider(cfg(k), embedding, env, ctors)).toBeNull();
    expect(calls).toEqual({});
  });

  it('hana-vector: shared layout, binding connection, login credential', async () => {
    const { ctors, calls } = fakes();
    createCollectionProvider(
      cfg('hana-vector', { hana: { serviceName: 'hdi' } }),
      embedding,
      env,
      ctors,
    );
    const a = calls.hanaProvider[0];
    expect(a.name).toBe('hub-collections');
    expect(a.embedder).toBe(retrieval);
    expect(a.layout).toBe('shared');
    expect(a.autoCreateSchema).toBeUndefined();
    expect(a.connection).toMatchObject({
      host: 'h',
      port: 443,
      schema: 'SCH',
      layout: 'shared',
    });
    expect(a.connection.credential.principal).toBe('RT');
    expect(await a.connection.credential.secret()).toBe('SECRET');
  });

  it('hana-vector without a binding throws naming VCAP_SERVICES only', () => {
    const { ctors } = fakes();
    expect(() =>
      createCollectionProvider(cfg('hana-vector'), embedding, {}, ctors),
    ).toThrow(/VCAP_SERVICES/);
  });

  it('pg-vector: shared layout with schema and login', async () => {
    const { ctors, calls } = fakes();
    createCollectionProvider(
      cfg('pg-vector', {
        pg: {
          url: 'postgres://db:5432/x',
          user: 'u',
          password: 'p',
          schema: 's',
        },
      }),
      embedding,
      env,
      ctors,
    );
    const a = calls.pgProvider[0];
    expect(a.layout).toBe('shared');
    expect(a.embedder).toBe(retrieval);
    expect(a.connection).toMatchObject({
      connectionString: 'postgres://db:5432/x',
      schema: 's',
      layout: 'shared',
    });
    expect(a.connection.credential.principal).toBe('u');
    expect(await a.connection.credential.secret()).toBe('p');
  });

  it('pg-vector without a password sends no credential', () => {
    const { ctors, calls } = fakes();
    createCollectionProvider(
      cfg('pg-vector', { pg: { url: 'postgres://db:5432/x', user: 'u' } }),
      embedding,
      env,
      ctors,
    );
    expect(calls.pgProvider[0].connection).not.toHaveProperty('credential');
  });

  it('qdrant: catalog collection from the prefix', () => {
    const { ctors, calls } = fakes();
    createCollectionProvider(
      cfg('qdrant', { qdrant: { url: 'http://q:6333', prefix: 'pfx' } }),
      embedding,
      env,
      ctors,
    );
    expect(calls.qdrantProvider[0]).toMatchObject({
      name: 'hub-collections',
      url: 'http://q:6333',
      embedder: retrieval,
      catalogCollection: 'pfx-collections-catalog',
    });
  });
});

describe('Qdrant collection dimensions', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shares a pending lookup and caches its successful result', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/collections')) {
        listCalls++;
        started();
        return pending;
      }
      return Response.json({}, { status: 404 });
    });
    const embedDocument = jest.fn().mockResolvedValue({ vector: [0, 0, 0] });
    const { ctors } = fakes();
    const describeCollections = jest.fn().mockResolvedValue({
      ok: true,
      value: { records: [] },
    });
    const provider = createCollectionProvider(
      cfg('qdrant', { qdrant: { url: 'http://q:6333', prefix: 'test' } }),
      { retrieval: { embedDocument } } as unknown as Embedding,
      env,
      {
        ...ctors,
        QdrantRagProvider: class {
          describeCollections = describeCollections;
        },
      } as unknown as RagCtors,
    )!;
    const dimension = providerVectorDimension(provider);
    const first = dimension('first');
    await lookupStarted;
    const second = dimension('second');
    // Allow the second target's 404 response to reach the shared lookup.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listCalls).toBe(1);
    release(Response.json({ result: { collections: [] } }));
    expect(await Promise.all([first, second])).toEqual([3, 3]);
    expect(await dimension('third')).toBe(3);
    expect(listCalls).toBe(1);
    expect(embedDocument).toHaveBeenCalledTimes(1);
  });

  it('uses each existing collection size after caching the configured size for new collections', async () => {
    const sizes = new Map<string, number>([['restored-task-results', 1536]]);
    const embedDocument = jest.fn();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const name = String(input).split('/').pop()!;
      const size = sizes.get(name);
      return size === undefined
        ? Response.json({}, { status: 404 })
        : Response.json({
            result: { config: { params: { vectors: { size } } } },
          });
    });
    const { ctors } = fakes();
    const provider = createCollectionProvider(
      cfg('qdrant', {
        qdrant: { url: 'http://q:6333', prefix: 'test' },
        embeddingDimension: 768,
      }),
      { retrieval: { embedDocument } } as unknown as Embedding,
      env,
      ctors,
    )!;
    const dimension = providerVectorDimension(provider);
    expect(
      await Promise.all([
        dimension('new-task-results'),
        dimension('concurrent-new-task-results'),
      ]),
    ).toEqual([768, 768]);
    sizes.set('new-task-results', 768);
    expect(await dimension('restored-task-results')).toBe(1536);
    expect(await dimension('new-task-results')).toBe(768);
    expect(await dimension('another-new-task-results')).toBe(768);
    expect(embedDocument).not.toHaveBeenCalled();
  });
});

describe('store factory for the new kinds', () => {
  it.each([
    ['hana-vector', { hana: {} }],
    ['pg-vector', { pg: { url: 'postgres://db/x' } }],
  ] as const)(
    '%s: no bare store, it must go through the provider',
    (kind, extra) => {
      const f = createRagStoreFactory(
        cfg('in-memory', extra as Partial<RagConfig>, kind),
        embedding,
      );
      expect(() => f.create('session', 'h_history')).toThrow(
        /opened through the collection provider/,
      );
    },
  );

  it('qdrant-only methods still throw for pg-vector', async () => {
    const f = createRagStoreFactory(
      cfg('in-memory', { pg: { url: 'postgres://db/x' } }, 'pg-vector'),
      embedding,
    );
    await expect(f.deleteStore('session', 'x')).rejects.toThrow(
      /not on qdrant/,
    );
  });
});
