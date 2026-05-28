jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { sanitizeUserKey } from '../../srv/collection-ids';
import { CollectionRegistry } from '../../srv/rag-collections';

describe('migrateToUserNamespacing', () => {
  function seedFlat(
    reg: any,
    metas: Array<{ id: string; owner?: string; scope?: string }>,
  ) {
    for (const m of metas) {
      (reg as any).collections.set(m.id, {
        meta: {
          id: m.id,
          logicalId: m.id,
          displayName: m.id,
          description: '',
          scope: m.scope ?? 'user',
          owner: m.owner,
          createdAt: new Date().toISOString(),
          documentCount: 0,
        },
        documents: new Map(),
        rag: (reg as any).createRagStore(),
      });
    }
  }

  test('renames flat user collection to <logical>__u_<key>, drops facts, quarantines orphan', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [
      { id: 'book-catalog', owner: 'alice', scope: 'user' },
      { id: 'facts', scope: 'global' },
      { id: 'legacyOrphan', scope: 'user' }, // no owner
    ]);
    reg.migrateToUserNamespacing();
    expect(
      reg.getCollection(`book-catalog__u_${sanitizeUserKey('alice')}`),
    ).not.toBeNull();
    expect(reg.getCollection('book-catalog')).toBeNull();
    expect(reg.getCollection('facts')).toBeNull(); // facts removed
    // orphan quarantined under hashed key, not served in listForUser
    const served = reg.listCollections('alice').map((c: any) => c.id);
    expect(served.some((id: string) => id.startsWith('__orphan__'))).toBe(
      false,
    );
  });

  test('idempotent: a second run does not re-hash already-namespaced ids', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'book-catalog', owner: 'alice', scope: 'user' }]);
    reg.migrateToUserNamespacing();
    const id1 = `book-catalog__u_${sanitizeUserKey('alice')}`;
    expect(reg.getCollection(id1)).not.toBeNull();
    reg.migrateToUserNamespacing(); // second run
    expect(reg.getCollection(id1)).not.toBeNull(); // unchanged, not legacy-<hash>
  });

  test('stray legacy id with __ (not the migrated form) goes through legacy fallback', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'foo__bar', owner: 'alice', scope: 'user' }]); // not <logical>__u_<key>
    reg.migrateToUserNamespacing();
    expect(reg.getCollection('foo__bar')).toBeNull(); // not treated as final
    const served = reg.listCollections('alice');
    expect(served.some((c: any) => /legacy-[a-f0-9]{8}__u_/.test(c.id))).toBe(
      true,
    );
  });

  test('owner "anonymous" is quarantined, not migrated into a real namespace', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'leftover', owner: 'anonymous', scope: 'user' }]);
    reg.migrateToUserNamespacing();
    expect(
      reg.getCollection(`leftover__u_${sanitizeUserKey('anonymous')}`),
    ).toBeNull(); // NOT a real namespace
    const served = reg.listCollections('anonymous').map((c: any) => c.id);
    expect(served.some((id: string) => id.startsWith('__orphan__'))).toBe(
      false,
    ); // quarantined, not served
  });

  test('a single flat id gets NO suffix (no self-collision)', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'Book Catalog', owner: 'alice', scope: 'user' }]); // normalizes to book-catalog
    reg.migrateToUserNamespacing();
    expect(
      reg.getCollection(`book-catalog__u_${sanitizeUserKey('alice')}`),
    ).not.toBeNull();
    expect(
      reg.getCollection(`book-catalog-2__u_${sanitizeUserKey('alice')}`),
    ).toBeNull();
  });

  test('user-owned flat `facts` migrates, is NOT dropped (only the ownerless built-in is dropped)', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'facts', owner: 'alice', scope: 'user' }]); // user-owned facts
    reg.migrateToUserNamespacing();
    expect(reg.getCollection('facts')).toBeNull(); // flat id gone
    expect(
      reg.getCollection(`facts__u_${sanitizeUserKey('alice')}`),
    ).not.toBeNull(); // migrated, not deleted
  });

  test('3-way collision picks result-2, result-3 (no result-2-2 chain)', () => {
    const reg = new CollectionRegistry();
    const k = sanitizeUserKey('alice');
    seedFlat(reg, [
      { id: `result-2__u_${k}`, owner: 'alice', scope: 'user' }, // already-migrated, occupies result-2
      { id: 'result', owner: 'alice', scope: 'user' }, // flat
      { id: 'Result', owner: 'alice', scope: 'user' }, // flat, also normalizes to result
    ]);
    (reg as any).collections.get(`result-2__u_${k}`).meta.logicalId =
      'result-2';
    reg.migrateToUserNamespacing();
    expect(reg.getCollection(`result__u_${k}`)).not.toBeNull(); // first flat → base
    expect(reg.getCollection(`result-3__u_${k}`)).not.toBeNull(); // second flat skips taken result-2 → result-3
    expect(reg.getCollection(`result-2-2__u_${k}`)).toBeNull(); // never a -2-2 chain
  });

  test('enabled keys are re-pointed when a flat collection is renamed by migration', () => {
    const reg = new CollectionRegistry();
    seedFlat(reg, [{ id: 'result', owner: 'alice', scope: 'user' }]);
    reg.setEnabled('alice', 'result', false);
    reg.migrateToUserNamespacing();
    const newId = `result__u_${sanitizeUserKey('alice')}`;
    expect(reg.getEnabled('alice', newId)).toBe(false); // re-pointed to new physical id
    expect(reg.getEnabled('alice', 'result')).toBeUndefined(); // old key gone
  });

  test('flat id does not overwrite an already-migrated same-name collection', () => {
    const reg = new CollectionRegistry();
    const migrated = `result__u_${sanitizeUserKey('alice')}`;
    seedFlat(reg, [
      { id: migrated, owner: 'alice', scope: 'user' }, // already final
      { id: 'result', owner: 'alice', scope: 'user' }, // flat, same logical name
    ]);
    (reg as any).collections.get(migrated).meta.logicalId = 'result';
    (reg as any).collections.get(migrated).documents.set('keep', {
      id: 'keep',
      text: 'X',
      metadata: {},
      createdAt: '',
    });
    reg.migrateToUserNamespacing();
    expect((reg as any).collections.get(migrated).documents.has('keep')).toBe(
      true,
    ); // not overwritten
    const served = reg.listCollections('alice').map((c: any) => c.id);
    expect(served).toContain(migrated);
    expect(
      served.some(
        (id: string) => id === `result-2__u_${sanitizeUserKey('alice')}`,
      ),
    ).toBe(true); // flat suffixed
  });
});
