import { createHash } from 'node:crypto';
import {
  DuplicateCollectionError,
  InMemoryRag,
  type IRagProvider,
  OrphanStoreError,
  type RagCollectionRecord,
  RagError,
  validateRagAttributes,
} from '@mcp-abap-adt/llm-agent';
import {
  CollectionBackendError,
  createCollectionPersistence,
  decodeRecord,
  encodeAttributes,
  storeNameFor,
  unwrap,
  WRITTEN_BY,
} from '../../srv/lib/collection-persistence';
import type { CollectionMeta } from '../../srv/rag-collections';

const userMeta: CollectionMeta = {
  id: 'notes__u_0123456789abcdef',
  logicalId: 'notes',
  displayName: 'Notes',
  description: 'my notes',
  scope: 'user',
  owner: 'alice@example.com',
  createdAt: '2026-10-19T10:00:00.000Z',
  documentCount: 0,
  sourceCount: 0,
};

const sessionMeta: CollectionMeta = {
  ...userMeta,
  id: 'notes__s_fedcba9876543210',
  scope: 'session',
  sessionId: 'sess-1',
  expiresAt: 1_800_000_000_000,
};

/** The record a provider would give back for what `create` sent. */
function recordFor(meta: CollectionMeta, enabled = true): RagCollectionRecord {
  const attributes = encodeAttributes(meta, enabled, 'fp-1') as never;
  return meta.scope === 'session'
    ? {
        storeName: storeNameFor(meta.id),
        name: meta.id,
        scope: 'session',
        sessionId: meta.sessionId ?? '',
        attributes,
      }
    : {
        storeName: storeNameFor(meta.id),
        name: meta.id,
        scope: 'user',
        userId: meta.owner ?? '',
        attributes,
      };
}

describe('storeNameFor', () => {
  it('is c_ + the first 40 hex characters of sha256(collectionId)', () => {
    const hex = createHash('sha256').update(userMeta.id).digest('hex');
    expect(storeNameFor(userMeta.id)).toBe(`c_${hex.slice(0, 40)}`);
    expect(storeNameFor(userMeta.id)).toHaveLength(42);
    expect(storeNameFor(userMeta.id)).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it('is deterministic and tells collections apart', () => {
    expect(storeNameFor('a__u_1')).toBe(storeNameFor('a__u_1'));
    expect(storeNameFor('a__u_1')).not.toBe(storeNameFor('a__u_2'));
  });
});

describe('encodeAttributes', () => {
  it('carries the marker, ids, state, embedder and the hub owner', () => {
    expect(encodeAttributes(sessionMeta, false, 'fp-1')).toEqual({
      writtenBy: WRITTEN_BY,
      collectionId: sessionMeta.id,
      logicalId: 'notes',
      displayName: 'Notes',
      description: 'my notes',
      enabled: false,
      source: 'session',
      embedder: 'fp-1',
      createdAt: sessionMeta.createdAt,
      expiresAt: sessionMeta.expiresAt,
      hubOwner: { userId: 'alice@example.com', sessionId: 'sess-1' },
    });
  });

  it('is JSON-safe for the catalog (no undefined anywhere)', () => {
    const attrs = encodeAttributes(userMeta, true, 'fp-1');
    expect(validateRagAttributes(attrs).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(attrs))).toEqual(attrs);
    expect(attrs.hubOwner).toEqual({ userId: 'alice@example.com' });
    expect('expiresAt' in attrs).toBe(false);
  });
});

describe('decodeRecord', () => {
  it.each([
    ['user', userMeta],
    ['session', sessionMeta],
  ])('round-trips a %s collection', (_scope, meta) => {
    const decoded = decodeRecord(recordFor(meta, false));
    expect(decoded).toEqual({ meta, enabled: false, embedderFp: 'fp-1' });
  });

  it('treats records the hub did not write as foreign', () => {
    const own = recordFor(userMeta);
    const attrs = own.attributes as Record<string, never>;
    const foreign: RagCollectionRecord[] = [
      { ...own, attributes: undefined },
      { ...own, attributes: { ...attrs, writtenBy: 'llm-agent-live-check' } },
      { ...own, attributes: { ...attrs, collectionId: undefined } as never },
      { ...own, attributes: { ...attrs, hubOwner: {} } },
      { ...own, storeName: 'c_somethingelse' },
      {
        storeName: own.storeName,
        name: 'x',
        scope: 'global',
        attributes: attrs,
      },
      { ...own, attributes: ['not', 'an', 'object'] },
      // the catalog owner disagrees with hubOwner
      { ...own, scope: 'user', userId: 'mallory@example.com' },
    ];
    for (const rec of foreign)
      expect(decodeRecord(rec)).toEqual({ foreign: true });
  });
});

describe('createCollectionPersistence', () => {
  function provider(
    over: Partial<IRagProvider> & Record<string, unknown> = {},
  ) {
    const calls: Array<[string, ...unknown[]]> = [];
    const p = {
      name: 'fake',
      kind: 'vector',
      editable: true,
      supportedScopes: ['user', 'session'] as const,
      async createCollection(name: string, opts: unknown) {
        calls.push(['create', name, opts]);
        const rag = new InMemoryRag();
        return { ok: true as const, value: { rag, editor: rag as never } };
      },
      async deleteCollection(name: string) {
        calls.push(['delete', name]);
        return { ok: true as const, value: undefined };
      },
      async updateCollection(name: string, patch: unknown) {
        calls.push(['update', name, patch]);
        return { ok: true as const, value: undefined };
      },
      ...over,
    };
    return { p: p as unknown as IRagProvider, calls };
  }

  it('creates under the store name with the catalog owner and attributes', async () => {
    const { p, calls } = provider();
    const res = await createCollectionPersistence(p, 'fp-1').create(
      sessionMeta,
      true,
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      [
        'create',
        storeNameFor(sessionMeta.id),
        {
          scope: 'session',
          sessionId: 'sess-1',
          collectionName: sessionMeta.id,
          attributes: encodeAttributes(sessionMeta, true, 'fp-1'),
        },
      ],
    ]);
  });

  it('a user collection is owned by its user', async () => {
    const { p, calls } = provider();
    await createCollectionPersistence(p, 'fp-1').create(userMeta, true);
    expect(calls[0][2]).toMatchObject({
      scope: 'user',
      userId: 'alice@example.com',
    });
  });

  it('removes and updates by store name', async () => {
    const { p, calls } = provider();
    const persistence = createCollectionPersistence(p, 'fp-1');
    expect((await persistence.update(userMeta, false)).ok).toBe(true);
    expect((await persistence.remove(userMeta)).ok).toBe(true);
    expect(calls).toEqual([
      [
        'update',
        storeNameFor(userMeta.id),
        { attributes: encodeAttributes(userMeta, false, 'fp-1') },
      ],
      ['delete', storeNameFor(userMeta.id)],
    ]);
  });

  it('a throwing provider becomes an error Result, never a throw', async () => {
    const { p } = provider({
      createCollection: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await createCollectionPersistence(p, 'fp-1').create(
      userMeta,
      true,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/connection refused/);
  });

  it('refuses update without IRagCatalogUpdater, and delete without deleteCollection', async () => {
    const { p } = provider({
      updateCollection: undefined,
      deleteCollection: undefined,
    });
    const persistence = createCollectionPersistence(p, 'fp-1');
    expect((await persistence.update(userMeta, true)).ok).toBe(false);
    expect((await persistence.remove(userMeta)).ok).toBe(false);
  });

  it('a session record whose sessionId disagrees with hubOwner is foreign', () => {
    const own = recordFor(sessionMeta);
    expect(
      decodeRecord({ ...own, sessionId: 'other-session' } as never),
    ).toEqual({ foreign: true });
  });

  it('updateRecord serializes per collection: each snapshot sees the previous write applied', async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const sent: unknown[] = [];
    const { p } = provider({
      updateCollection: async (_name: string, patch: unknown) => {
        await held;
        sent.push(patch);
        return { ok: true as const, value: undefined };
      },
    });
    const persistence = createCollectionPersistence(p, 'fp-1');
    const live = { ...userMeta };
    let enabled = true;
    const first = persistence.updateRecord(
      live.id,
      () => ({ meta: { ...live, displayName: 'Renamed' }, enabled }),
      () => {
        live.displayName = 'Renamed';
      },
    );
    const second = persistence.updateRecord(
      live.id,
      () => ({ meta: { ...live }, enabled: false }),
      () => {
        enabled = false;
      },
    );
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(sent).toEqual([
      {
        attributes: encodeAttributes(
          { ...userMeta, displayName: 'Renamed' },
          true,
          'fp-1',
        ),
      },
      {
        attributes: encodeAttributes(
          { ...userMeta, displayName: 'Renamed' },
          false,
          'fp-1',
        ),
      },
    ]);
  });

  it('restore is not implemented yet and says so', async () => {
    const res = await createCollectionPersistence(
      provider().p,
      'fp-1',
    ).restore();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('CollectionBackendError', () => {
  it('409 for a taken name or an orphan store, 502 otherwise', () => {
    const status = (e: RagError) => {
      try {
        unwrap({ ok: false, error: e }, 'create collection');
      } catch (err) {
        expect(err).toBeInstanceOf(CollectionBackendError);
        return (err as CollectionBackendError).httpStatus;
      }
      throw new Error('unwrap did not throw');
    };
    expect(status(new DuplicateCollectionError('x'))).toBe(409);
    expect(status(new OrphanStoreError('x', 'rows without record'))).toBe(409);
    expect(status(new RagError('down', 'CONNECTION_ERROR'))).toBe(502);
  });
});
