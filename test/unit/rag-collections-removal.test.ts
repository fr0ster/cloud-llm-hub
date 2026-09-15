jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { InMemoryRag, RagError } from '@mcp-abap-adt/llm-agent';
import {
  CollectionRegistry,
  collectionRemovalFailureCount,
  type RagBackend,
  resetCollectionRemovalFailuresForTest,
} from '../../srv/rag-collections';

type Clear = 'clears' | 'not-ok' | 'rejects' | 'throws' | 'missing';

/** An in-memory store whose clearAll is counted, and can fail or be missing. */
function backend(clear: Clear = 'clears') {
  const calls = { clearAll: 0 };
  class CountingRag extends InMemoryRag {
    writer() {
      const w = super.writer();
      if (clear === 'missing') {
        return { upsertRaw: w.upsertRaw, deleteByIdRaw: w.deleteByIdRaw };
      }
      return {
        ...w,
        clearAll: () => {
          calls.clearAll++;
          switch (clear) {
            case 'not-ok':
              return Promise.resolve({
                ok: false as const,
                error: new RagError('store unreachable'),
              });
            case 'rejects':
              return Promise.reject(new Error('store unreachable'));
            case 'throws':
              throw new Error('store unreachable');
            default:
              return w.clearAll?.() ?? Promise.reject(new Error('no clearAll'));
          }
        },
      };
    }
  }
  return { calls, factory: () => new CountingRag() };
}

let reg: CollectionRegistry;

beforeEach(() => {
  reg = new CollectionRegistry();
  resetCollectionRemovalFailuresForTest();
});

/** A collection with one document in its store; returns that store. */
async function withDocument(
  id: string,
  meta: {
    scope: 'session' | 'user';
    owner: string;
    sessionId?: string;
    expiresAt?: number;
    backend: string;
  },
): Promise<InMemoryRag> {
  reg.createCollection({
    id,
    logicalId: id.split('__')[0],
    displayName: id,
    description: '',
    ...meta,
  });
  await reg.addDocument(id, { id: 'd1', text: 'hello', metadata: {} });
  const store = reg.getRagStore(id) as InMemoryRag;
  // Guard the premise: a store that never held the document proves nothing
  // about clearing it.
  expect(await holds(store, id)).toBe(true);
  return store;
}

/** Whether the store still holds the collection's document. */
async function holds(store: InMemoryRag, id: string): Promise<boolean> {
  // A removal starts clearAll and does not wait for it.
  await new Promise((r) => setImmediate(r));
  const found = await store.getById(`doc:${id}:d1`);
  if (!found.ok) throw found.error;
  return found.value !== null;
}

const ENDINGS: Array<{
  name: string;
  expiresAt: number;
  end: (r: CollectionRegistry) => void;
}> = [
  {
    name: 'deleteCollection',
    expiresAt: Date.now() + 60_000,
    end: (r) => r.deleteCollection('s__x_1'),
  },
  {
    name: 'deleteSessionCollections — logout, clear-chat, eviction',
    expiresAt: Date.now() + 60_000,
    end: (r) => r.deleteSessionCollections('alice', 'x'),
  },
  {
    name: 'sweepExpiredSessions — the TTL',
    expiresAt: Date.now() - 1,
    end: (r) => r.sweepExpiredSessions(),
  },
];

describe.each(ENDINGS)('$name', ({ expiresAt, end }) => {
  it('clears the data through the backend and leaves nothing reachable', async () => {
    const b = backend();
    reg.registerBackend('counting', b.factory);
    const store = await withDocument('s__x_1', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'x',
      expiresAt,
      backend: 'counting',
    });
    end(reg);
    expect(reg.getCollection('s__x_1')).toBeNull();
    expect(reg.getRagStore('s__x_1')).toBeNull();
    expect(reg.hasSessionCollections('alice', 'x')).toBe(false);
    expect(b.calls.clearAll).toBe(1);
    expect(await holds(store, 's__x_1')).toBe(false);
    expect(collectionRemovalFailureCount()).toBe(0);
  });

  it.each<Clear>(['not-ok', 'rejects', 'throws', 'missing'])(
    'a backend whose clear %s: removed all the same, never thrown, counted',
    async (clear) => {
      reg.registerBackend('failing', backend(clear).factory);
      await withDocument('s__x_1', {
        scope: 'session',
        owner: 'alice',
        sessionId: 'x',
        expiresAt,
        backend: 'failing',
      });
      expect(() => end(reg)).not.toThrow();
      expect(reg.getCollection('s__x_1')).toBeNull();
      expect(reg.hasSessionCollections('alice', 'x')).toBe(false);
      await new Promise((r) => setImmediate(r));
      expect(collectionRemovalFailureCount()).toBe(1);
    },
  );
});

describe('what did not end', () => {
  it('keeps its data and its store', async () => {
    const b = backend();
    reg.registerBackend('counting', b.factory);
    const live = await withDocument('s__s_3', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'z',
      expiresAt: Date.now() + 60_000,
      backend: 'counting',
    });
    const user = await withDocument('u__u_2', {
      scope: 'user',
      owner: 'alice',
      backend: 'counting',
    });
    reg.sweepExpiredSessions();
    reg.deleteSessionCollections('bob', 'z');
    expect(b.calls.clearAll).toBe(0);
    expect(await holds(live, 's__s_3')).toBe(true);
    expect(await holds(user, 'u__u_2')).toBe(true);
  });
});

describe('a session with several collections', () => {
  it('removes every one, even when one of them does not clear', async () => {
    const good = backend();
    reg.registerBackend('good', good.factory);
    reg.registerBackend('bad', backend('rejects').factory);
    await withDocument('s__g_1', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'g',
      expiresAt: Date.now() + 60_000,
      backend: 'bad',
    });
    const kept = await withDocument('s__g_2', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'g',
      expiresAt: Date.now() + 60_000,
      backend: 'good',
    });
    reg.deleteSessionCollections('alice', 'g');
    expect(reg.getCollection('s__g_1')).toBeNull();
    expect(reg.getCollection('s__g_2')).toBeNull();
    expect(await holds(kept, 's__g_2')).toBe(false);
    expect(collectionRemovalFailureCount()).toBe(1);
  });
});

describe('collections over one shared backend', () => {
  type Deletion = 'deletes' | 'not-ok' | 'rejects' | 'throws';

  /**
   * One server for every collection, keeping a physical store per name — as a
   * Qdrant collection or a table would be — and deleting one on request. Its
   * deletions wait until the test lets them go. A factory given no name gets the
   * one store the server keeps under no name.
   */
  function sharedServer(deletion: Deletion = 'deletes') {
    const stores = new Map<string, InMemoryRag>();
    const names: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const backend: RagBackend = {
      create: ({ store }) => {
        names.push(store);
        let rag = stores.get(store);
        if (!rag) {
          rag = new InMemoryRag();
          stores.set(store, rag);
        }
        return rag;
      },
      deleteStore: (store) => {
        switch (deletion) {
          case 'not-ok':
            return Promise.resolve({
              ok: false as const,
              error: new RagError('drop refused'),
            });
          case 'rejects':
            return Promise.reject(new Error('server unreachable'));
          case 'throws':
            throw new Error('server unreachable');
          default:
            return hold.then(() => {
              stores.delete(store);
              return { ok: true as const, value: undefined };
            });
        }
      },
    };
    return { backend, names, release, list: () => [...stores.keys()] };
  }

  /** Let the server's held deletions run. */
  async function settle(server: { release(): void }) {
    server.release();
    await new Promise((r) => setImmediate(r));
  }

  it('removing a collection deletes its store from the server, and only its store', async () => {
    const server = sharedServer();
    reg.registerBackend('shared', server.backend);
    await withDocument('s__a_1', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'a',
      expiresAt: Date.now() + 60_000,
      backend: 'shared',
    });
    const second = await withDocument('s__b_1', {
      scope: 'session',
      owner: 'bob',
      sessionId: 'b',
      expiresAt: Date.now() + 60_000,
      backend: 'shared',
    });
    const [first, other] = server.names;
    expect(first).not.toBe(other);
    expect(server.list()).toEqual([first, other]);

    reg.deleteSessionCollections('alice', 'a');
    await settle(server);
    // The store itself is gone, not merely emptied.
    expect(server.list()).toEqual([other]);
    expect(await holds(second, 's__b_1')).toBe(true);
    expect(reg.getCollection('s__b_1')).not.toBeNull();
    expect(collectionRemovalFailureCount()).toBe(0);
  });

  it('a collection re-created under the same id gets a new store the pending deletion cannot reach', async () => {
    const server = sharedServer();
    reg.registerBackend('shared', server.backend);
    await withDocument('s__r_1', {
      scope: 'user',
      owner: 'alice',
      backend: 'shared',
    });
    reg.deleteCollection('s__r_1');
    // The old deletion is still waiting when the same id is created and written again.
    const renewed = await withDocument('s__r_1', {
      scope: 'user',
      owner: 'alice',
      backend: 'shared',
    });
    const [old, current] = server.names;
    expect(old).not.toBe(current);

    await settle(server);
    expect(server.list()).toEqual([current]);
    expect(await holds(renewed, 's__r_1')).toBe(true);
    expect(collectionRemovalFailureCount()).toBe(0);
  });

  it.each<Deletion>(['not-ok', 'rejects', 'throws'])(
    'a deletion that %s: the collection is removed all the same, never thrown, counted',
    async (deletion) => {
      const server = sharedServer(deletion);
      reg.registerBackend('shared', server.backend);
      await withDocument('s__f_1', {
        scope: 'user',
        owner: 'alice',
        backend: 'shared',
      });
      expect(() => reg.deleteCollection('s__f_1')).not.toThrow();
      expect(reg.getCollection('s__f_1')).toBeNull();
      await settle(server);
      expect(collectionRemovalFailureCount()).toBe(1);
    },
  );
});

describe('the enabled flag', () => {
  it('is forgotten with the collection', async () => {
    reg.registerBackend('counting', backend().factory);
    await withDocument('s__s_4', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'w',
      expiresAt: Date.now() + 60_000,
      backend: 'counting',
    });
    reg.setEnabled('alice', 's__s_4', true);
    reg.deleteSessionCollections('alice', 'w');
    expect(reg.getEnabled('alice', 's__s_4')).toBeUndefined();
  });
});

describe('hasSessionCollections', () => {
  it('answers per user and session', async () => {
    reg.registerBackend('counting', backend().factory);
    await withDocument('s__s_5', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'v',
      expiresAt: Date.now() + 60_000,
      backend: 'counting',
    });
    expect(reg.hasSessionCollections('alice', 'v')).toBe(true);
    expect(reg.hasSessionCollections('bob', 'v')).toBe(false);
    expect(reg.hasSessionCollections('alice', 'other')).toBe(false);
  });
});
