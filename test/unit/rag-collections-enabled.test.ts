jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { CollectionRegistry } from '../../srv/rag-collections';

describe('per-user enabled state', () => {
  test('set/get enabled is keyed by (userId, physicalId) and persists in-memory', () => {
    const reg = new CollectionRegistry();
    reg.setEnabled('alice', 'result__u_x', false);
    expect(reg.getEnabled('alice', 'result__u_x')).toBe(false);
    expect(reg.getEnabled('bob', 'result__u_x')).toBeUndefined(); // independent per user
  });
});

import {
  collectionDefault,
  collectionEnabled,
  deleteCollectionOverrides,
  setCollectionOverride,
} from '../../srv/lib/collection-toggle';

test('session overrides isolate sessions and users, follow defaults until overridden, and clean up', async () => {
  const reg = new CollectionRegistry();
  const meta = await reg.createCollection({
    id: 'toggle',
    logicalId: 'toggle',
    scope: 'user',
    owner: 'alice',
    displayName: 'Toggle',
    description: '',
  });
  expect(collectionEnabled(reg, 'alice', 'one', meta)).toBe(true);
  setCollectionOverride('alice', 'one', meta.id, false);
  expect(collectionEnabled(reg, 'alice', 'one', meta)).toBe(false);
  expect(collectionEnabled(reg, 'alice', 'two', meta)).toBe(true);
  expect(collectionEnabled(reg, 'bob', 'one', meta)).toBe(true);
  expect(collectionEnabled(reg, 'alice', undefined, meta)).toBe(true);
  await reg.setEnabled('alice', meta.id, false);
  setCollectionOverride('alice', 'one', meta.id, true);
  expect(collectionDefault(reg, 'alice', meta)).toBe(false);
  expect(collectionEnabled(reg, 'alice', 'two', meta)).toBe(false);
  expect(collectionEnabled(reg, 'alice', 'one', meta)).toBe(true);
  deleteCollectionOverrides('alice', 'one');
  expect(collectionEnabled(reg, 'alice', 'one', meta)).toBe(false);
});
