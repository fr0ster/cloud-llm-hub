jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { CollectionRegistry } from '../../srv/rag-collections';

test('sweepExpiredSessions deletes only expired session collections', () => {
  const reg = new CollectionRegistry();
  (reg as any).collections.set('a__s_x', {
    meta: {
      id: 'a__s_x',
      logicalId: 'a',
      scope: 'session',
      owner: 'alice',
      sessionId: 'x',
      expiresAt: Date.now() - 1,
      displayName: 'a',
      description: '',
      createdAt: '',
    },
    documents: new Map(),
    rag: (reg as any).createRagStore(),
  });
  (reg as any).collections.set('b__u_k', {
    meta: {
      id: 'b__u_k',
      logicalId: 'b',
      scope: 'user',
      owner: 'alice',
      displayName: 'b',
      description: '',
      createdAt: '',
    },
    documents: new Map(),
    rag: (reg as any).createRagStore(),
  });
  reg.sweepExpiredSessions();
  expect(reg.getCollection('a__s_x')).toBeNull(); // expired session gone
  expect(reg.getCollection('b__u_k')).not.toBeNull(); // user untouched
});

test('deleteSessionCollections removes only matching owner+sessionId', () => {
  const reg = new CollectionRegistry();
  // alice's session 'sess1'
  (reg as any).collections.set('x__s_alicesess1', {
    meta: {
      id: 'x__s_alicesess1',
      logicalId: 'x',
      scope: 'session',
      owner: 'alice',
      sessionId: 'sess1',
      expiresAt: Date.now() + 999999,
      displayName: 'x',
      description: '',
      createdAt: '',
    },
    documents: new Map(),
    rag: (reg as any).createRagStore(),
  });
  // bob's collection with the same raw sessionId 'sess1' (different owner)
  (reg as any).collections.set('x__s_bobsess1', {
    meta: {
      id: 'x__s_bobsess1',
      logicalId: 'x',
      scope: 'session',
      owner: 'bob',
      sessionId: 'sess1',
      expiresAt: Date.now() + 999999,
      displayName: 'x',
      description: '',
      createdAt: '',
    },
    documents: new Map(),
    rag: (reg as any).createRagStore(),
  });
  // alice's user-scoped collection (must not be touched)
  (reg as any).collections.set('y__u_alice', {
    meta: {
      id: 'y__u_alice',
      logicalId: 'y',
      scope: 'user',
      owner: 'alice',
      displayName: 'y',
      description: '',
      createdAt: '',
    },
    documents: new Map(),
    rag: (reg as any).createRagStore(),
  });

  reg.deleteSessionCollections('alice', 'sess1');

  expect(reg.getCollection('x__s_alicesess1')).toBeNull(); // alice's session removed
  expect(reg.getCollection('x__s_bobsess1')).not.toBeNull(); // bob's session NOT removed
  expect(reg.getCollection('y__u_alice')).not.toBeNull(); // alice's user collection untouched
});
