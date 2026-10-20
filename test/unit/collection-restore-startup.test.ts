/**
 * Startup wiring of the collection restore (agent-manager): the retry loop is
 * started on the shared registry, and /health's status follows it.
 */
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

import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  collectionsRestoreStatus,
  getCollectionRegistry,
  initProviders,
  startCollectionRestore,
} from '../../srv/agent-manager';
import { restoreHealth } from '../../srv/lib/collection-persistence';

let catalogDown = true;
const collections = {
  name: 'hub-collections',
  kind: 'pg-vector',
  editable: true,
  supportedScopes: ['user', 'session'],
  async createCollection() {
    throw new Error('not used');
  },
  async describeCollections() {
    return catalogDown
      ? {
          ok: false as const,
          error: new RagError('connect ECONNREFUSED', 'CONNECTION_ERROR'),
        }
      : { ok: true as const, value: { records: [], rejected: [] } };
  },
  async openCollection() {
    throw new Error('not used');
  },
};

it('retries the restore in the background; health is 503 until it succeeds', async () => {
  initProviders({
    embedding: {
      retrieval: null,
      breaker: null,
      fingerprint: { provider: 'ollama', embeddingModel: 'bge-m3' },
    },
    stores: { backendOf: () => 'pg-vector' },
    collections,
    destinations: {
      metadata: async () => undefined,
      list: async () => [],
      clearCache: () => {},
      refuse: () => null,
    },
  } as never);
  expect(collectionsRestoreStatus()).toEqual({ state: 'pending' });

  const delays: number[] = [];
  let next: (() => void) | undefined;
  const done = startCollectionRestore({
    schedule: (run, ms) => {
      delays.push(ms);
      next = run;
    },
  });
  for (let i = 0; i < 100 && delays.length === 0; i++)
    await new Promise((r) => setImmediate(r));
  expect(delays).toEqual([30_000]);
  expect(restoreHealth(collectionsRestoreStatus())).toEqual({
    status: 503,
    body: {
      status: 'DOWN',
      collections: { state: 'failed', error: 'connect ECONNREFUSED' },
    },
  });
  await expect(
    getCollectionRegistry().listCollections('alice'),
  ).rejects.toThrow(/collections unavailable: connect ECONNREFUSED/);

  catalogDown = false;
  next?.();
  await done;
  expect(restoreHealth(collectionsRestoreStatus()).status).toBe(200);
  expect(await getCollectionRegistry().listCollections('alice')).toEqual([]);
});
