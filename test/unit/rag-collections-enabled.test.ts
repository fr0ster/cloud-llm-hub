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
