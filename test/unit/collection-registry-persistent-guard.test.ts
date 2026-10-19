jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {},
    },
  }),
  { virtual: true },
);

import { getCollectionRegistry, initProviders } from '../../srv/agent-manager';

// A persistent kind with no collection provider must not quietly become an
// in-memory registry.
it('a persistent kind without a collection provider fails explicitly', () => {
  initProviders({
    embedding: null,
    stores: { backendOf: () => 'pg-vector' } as never,
    collections: null,
    destinations: {
      metadata: async () => undefined,
      list: async () => [],
      clearCache: () => {},
      refuse: () => null,
    },
  });
  expect(() => getCollectionRegistry()).toThrow(
    /"pg-vector" but no collection provider/,
  );
});
