import type { RagConfig } from '../../srv/agent-config';
import type { Embedding } from '../../srv/lib/providers';
import {
  createCollectionProvider,
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
