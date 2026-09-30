const mockCdsContext: { user?: { id: string; is: (role: string) => boolean } } =
  {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import fs from 'node:fs';
import path from 'node:path';
import { type CallOptions, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import type { Request, Response } from 'express';
import * as manager from '../../srv/agent-manager';
import { sessionCollectionId } from '../../srv/collection-ids';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import { isRefusal, type Lease } from '../../srv/lib/session-retention';
import {
  collectionRemovalFailureCount,
  resetCollectionRemovalFailuresForTest,
} from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { initInMemoryProviders } from './helpers/providers';
import {
  findRoute,
  makeMockRouter,
  makeReq,
  makeRes,
  runIdRoute,
} from './helpers/rag-routes';

/** A backend whose calls wait until the test lets them go. */
function gatedBackend() {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  class GatedRag extends InMemoryRag {
    async upsert(...args: Parameters<InMemoryRag['upsert']>) {
      await gate;
      return super.upsert(...args);
    }
    async query(...args: Parameters<InMemoryRag['query']>) {
      await gate;
      return super.query(...args);
    }
    // InMemoryRag has no `deleteById` of its own — deletion goes through the
    // `IRagBackendWriter` `writer()` returns (see RecencyBoostedRag.deleteById
    // in srv/rag-collections.ts). Gate the same call the real wrapper makes.
    async deleteById(id: string, options?: CallOptions) {
      await gate;
      return this.writer().deleteByIdRaw(id, options);
    }
  }
  return { open, factory: () => new GatedRag() };
}

/** A backend that stores as usual and fails to clear. */
function unclearableBackend() {
  class UnclearableRag extends InMemoryRag {
    writer() {
      return {
        ...super.writer(),
        clearAll: async (): Promise<never> => {
          throw new Error('store unreachable');
        },
      };
    }
  }
  return () => new UnclearableRag();
}

initInMemoryProviders();
const registry = manager.getCollectionRegistry();
const { router, routes } = makeMockRouter();

/** The registry's own record of a collection; fails the test if there is none. */
function storedCollection(physId: string) {
  const stored = (
    registry as unknown as {
      collections: Map<string, { rag: unknown; meta: { expiresAt?: number } }>;
    }
  ).collections.get(physId);
  if (!stored) throw new Error(`no stored collection ${physId}`);
  return stored;
}
registerRagRoutes(router, registry);

function as(user: string) {
  mockCdsContext.user = { id: user, is: () => false };
}

function configure(live: number, retained: number) {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = String(retained);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

async function createSessionCollection(
  user: string,
  sid: string,
  backend?: string,
) {
  as(user);
  const res = makeRes();
  await findRoute(routes, 'POST', '/rag/collections').handler(
    makeReq({
      method: 'POST',
      body: { id: 'notes', displayName: 'Notes', scope: 'session', backend },
      headers: { cookie: `clh_session=${sid}` },
      sessionId: sid,
    }),
    res.res,
  );
  return res;
}

/** Whether a document is still in a store, looked up by the id the registry gives it. */
async function storeHolds(
  store: InMemoryRag | null,
  physId: string,
  docId: string,
) {
  if (!store) throw new Error(`no store for ${physId}`);
  // clearAll is started, not awaited, by the removal.
  await new Promise((r) => setImmediate(r));
  const found = await store.getById(`doc:${physId}:${docId}`);
  if (!found.ok) throw found.error;
  return found.value !== null;
}

beforeEach(() => {
  configure(1, 1);
  resetCollectionRemovalFailuresForTest();
});

afterEach(async () => {
  for (const [u, s] of [
    ['alice', 'A'],
    ['bob', 'B'],
  ]) {
    await gatekeeper.deleteSession(u, s);
  }
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  delete process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS;
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
});

describe('the retention cap on the RAG routes', () => {
  it('a RAG route cannot exceed the cap', async () => {
    // Alice's session is running a pipeline. There is one place, and it is hers.
    const running = gatekeeper.leaseSession('alice', 'A', 'pipeline') as Lease;
    const res = await createSessionCollection('bob', 'B');
    expect(res._status).toBe(503);
    expect(res._body).toEqual({
      error: {
        message:
          'The service has no room to hold another session right now. Please try again shortly.',
        code: 'gatekeeper_retention',
      },
    });
    expect(
      registry.getCollection(sessionCollectionId('notes', 'bob', 'B')),
    ).toBeNull();
    running.release();
  });

  it('evicts an idle session for a new one — all of it, its data cleared in the backend', async () => {
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    const physId = sessionCollectionId('notes', 'alice', 'A');
    await registry.addDocument(physId, {
      id: 'd1',
      text: 'hello',
      metadata: {},
    });
    const store = registry.getRagStore(physId) as InMemoryRag | null;
    expect(await storeHolds(store, physId, 'd1')).toBe(true);

    expect((await createSessionCollection('bob', 'B'))._status).toBe(201);

    expect(registry.getCollection(physId)).toBeNull();
    expect(await storeHolds(store, physId, 'd1')).toBe(false);
    expect(collectionRemovalFailureCount()).toBe(0);
  });
});

describe('a removal whose backend does not clear', () => {
  it('still ends the session: the old cookie does not reach the collection again', async () => {
    registry.registerBackend('unclearable', unclearableBackend());
    expect(
      (await createSessionCollection('alice', 'A', 'unclearable'))._status,
    ).toBe(201);
    const physId = sessionCollectionId('notes', 'alice', 'A');
    await registry.addDocument(physId, {
      id: 'd1',
      text: 'hello',
      metadata: {},
    });

    await expect(gatekeeper.deleteSession('alice', 'A')).resolves.toBe(
      undefined,
    );
    await new Promise((r) => setImmediate(r));

    expect(gatekeeper.sessionIsLive('alice', 'A')).toBe(false);
    expect(registry.getCollection(physId)).toBeNull();
    expect(gatekeeper.theRetention().snapshot()).toMatchObject({
      retained: 0,
      closing: 0,
    });
    expect(collectionRemovalFailureCount()).toBe(1);
  });
});

/** Three operations that each hold a session-scoped lease while their backend call is out. */
const OPERATIONS: Array<{
  name: string;
  start: (physId: string) => Promise<ReturnType<typeof makeRes>>;
}> = [
  {
    name: 'a bulk upload',
    start: (physId) =>
      runIdRoute(
        routes,
        'POST',
        '/rag/collections/:id/documents/bulk',
        makeReq({
          method: 'POST',
          path: '/documents/bulk',
          params: { id: physId },
          body: {
            documents: [
              { id: 'd1', text: 'one' },
              { id: 'd2', text: 'two' },
              { id: 'd3', text: 'three' },
            ],
          },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
  {
    name: 'a query',
    start: (physId) =>
      runIdRoute(
        routes,
        'POST',
        '/rag/collections/:id/query',
        makeReq({
          method: 'POST',
          path: '/query',
          params: { id: physId },
          body: { text: 'hello' },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
  {
    name: 'a document delete',
    start: (physId) =>
      runIdRoute(
        routes,
        'DELETE',
        '/rag/collections/:id/documents/:did',
        makeReq({
          method: 'DELETE',
          path: '/documents/d0',
          params: { id: physId, did: 'd0' },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
];

describe.each(OPERATIONS)('while $name is in flight', ({ start }) => {
  async function inFlight() {
    configure(2, 2);
    const backend = gatedBackend();
    registry.registerBackend('gated', backend.factory);
    expect((await createSessionCollection('alice', 'A', 'gated'))._status).toBe(
      201,
    );
    const physId = sessionCollectionId('notes', 'alice', 'A');
    // A document to delete, written before the gate matters.
    backend.open();
    await registry.addDocument(physId, {
      id: 'd0',
      text: 'zero',
      metadata: {},
    });
    // A fresh gate for the operation under test.
    const held = gatedBackend();
    registry.registerBackend('gated', held.factory);
    storedCollection(physId).rag = held.factory();
    as('alice');
    const running = start(physId);
    await new Promise((r) => setImmediate(r));
    return { physId, running, open: held.open };
  }

  it('is not evicted, slot or no slot — the idle session goes instead', async () => {
    const { physId, running, open } = await inFlight();
    // Alice's session is the least recently used, and it is in use.
    expect((await createSessionCollection('bob', 'B'))._status).toBe(201);
    const bobPhys = sessionCollectionId('notes', 'bob', 'B');
    await registry.addDocument(bobPhys, {
      id: 'b1',
      text: 'bob',
      metadata: {},
    });

    // Carol needs a place. Bob's idle session is evicted, not Alice's.
    expect((await createSessionCollection('carol', 'C'))._status).toBe(201);
    expect(registry.getCollection(bobPhys)).toBeNull();

    // With every place held by something working, nothing is evicted: refused.
    const holdCarol = gatekeeper.leaseSession(
      'carol',
      'C',
      'pipeline',
    ) as Lease;
    const refused = await createSessionCollection('dave', 'D');
    expect(refused._status).toBe(503);
    holdCarol.release();

    open();
    await running;
    expect(registry.getCollection(physId)).not.toBeNull();
    await gatekeeper.deleteSession('carol', 'C');
  });

  it('logout answers at once, refuses new work, and removes everything after it settles', async () => {
    const { physId, running, open } = await inFlight();

    let removed = false;
    const removal = gatekeeper.deleteSession('alice', 'A').then(() => {
      removed = true;
    });
    await Promise.resolve();
    expect(removed).toBe(false);

    // Closed to new leases from the mark.
    const late = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/query',
      makeReq({
        method: 'POST',
        path: '/query',
        params: { id: physId },
        body: { text: 'late' },
        headers: { cookie: 'clh_session=A' },
        sessionId: 'A',
      }),
    );
    expect(late._status).toBe(410);
    expect((late._body as { error: { code: string } }).error.code).toBe(
      'session_closed',
    );

    // The collection is still there while the operation runs against it.
    expect(registry.getCollection(physId)).not.toBeNull();
    open();
    await running;
    await removal;

    // The assertion that matters is made after the operation has finished: a
    // cleanup racing it passes every check made before.
    expect(registry.getCollection(physId)).toBeNull();
  });
});

describe('the TTL sweep', () => {
  it('skips a leased session and takes it on the next pass', async () => {
    configure(2, 2);
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    const physId = sessionCollectionId('notes', 'alice', 'A');
    await registry.addDocument(physId, {
      id: 'd1',
      text: 'hello',
      metadata: {},
    });
    const store = registry.getRagStore(physId) as InMemoryRag | null;
    storedCollection(physId).meta.expiresAt = Date.now() - 1;

    const held = gatekeeper.leaseSession('alice', 'A', 'rag');
    expect(isRefusal(held)).toBe(false);
    registry.sweepExpiredSessions(gatekeeper.maySweepSession);
    expect(registry.getCollection(physId)).not.toBeNull();

    (held as Lease).release();
    registry.sweepExpiredSessions(gatekeeper.maySweepSession);
    expect(registry.getCollection(physId)).toBeNull();
    expect(await storeHolds(store, physId, 'd1')).toBe(false);
  });
});

describe('a retired cookie', () => {
  it('gets a new session, and none of the old state is visible through it', async () => {
    configure(2, 2);
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    await gatekeeper.deleteSession('alice', 'A');

    as('alice');
    const req = {
      headers: { cookie: 'clh_session=A' },
      secure: false,
    } as unknown as Request & {
      sessionId?: string;
    };
    const set: Record<string, string> = {};
    sessionMiddleware({
      isLive: gatekeeper.sessionIsLive,
      userIdOf: () => 'alice',
    })(
      req,
      {
        setHeader: (k: string, v: string) => (set[k] = v),
      } as unknown as Response,
      () => {},
    );
    expect(req.sessionId).not.toBe('A');
    expect(set['Set-Cookie']).toContain(`clh_session=${req.sessionId}`);

    const list = makeRes();
    findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({
        method: 'GET',
        headers: { cookie: `clh_session=${req.sessionId}` },
        sessionId: req.sessionId,
      }),
      list.res,
    );
    const ids = (
      list._body as { collections: Array<{ id: string }> }
    ).collections.map((c) => c.id);
    expect(ids).not.toContain(sessionCollectionId('notes', 'alice', 'A'));
  });
});

describe('a request that outlived its session', () => {
  it('cannot create a session collection under the id after logout removed it', async () => {
    configure(2, 2);
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    // This request passed the middleware while A was live; the logout completes
    // before it reaches the route, so the closing mark is already gone.
    await gatekeeper.deleteSession('alice', 'A');
    as('alice');
    const res = makeRes();
    await findRoute(routes, 'POST', '/rag/collections').handler(
      makeReq({
        method: 'POST',
        body: { id: 'late', displayName: 'Late', scope: 'session' },
        headers: { cookie: 'clh_session=A' },
        sessionId: 'A',
        sessionMinted: false,
      }),
      res.res,
    );
    expect(res._status).toBe(410);
    expect(
      registry.getCollection(sessionCollectionId('late', 'alice', 'A')),
    ).toBeNull();
    expect(gatekeeper.theRetention().snapshot().retained).toBe(0);
  });
});

describe('logout and clear-chat in server.ts', () => {
  it('answer at the mark and do not wait for the removal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../srv/server.ts'),
      'utf8',
    );
    expect(src).toMatch(/void\s+deleteSession\(\s*userId\s*,\s*sessionId\s*\)/);
    expect(src).toMatch(/sweepExpiredSessions\(\s*maySweepSession\s*\)/);
    expect(src).toMatch(/isLive:\s*sessionIsLive/);
  });
});
