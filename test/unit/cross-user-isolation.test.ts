/**
 * End-to-end isolation tests for the full chat + RAG stack.
 *
 * Tests the following invariants:
 * A. Cross-user session-scoped RAG isolation
 * B. Cross-session-within-one-user RAG isolation
 * C. Chat history (sessionStore) cross-user isolation
 * D. Cookie identity does not cross-contaminate
 *
 * Uses the same mocking patterns as rag-handler.test.ts.
 */

// --- CDS mock (must be before any import that loads @sap/cds) ---
const mockCdsContext: {
  user?: { id: string; is?: (role: string) => boolean };
} = {};
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

// --- request-session mock ---
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
}));

import type { Request, Response, Router } from 'express';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import {
  appendToSession,
  clearSession,
  getSessionHistory,
} from '../../srv/openai-handler';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';

// ---------------------------------------------------------------------------
// Minimal mock router that captures registered routes
// ---------------------------------------------------------------------------

interface RouteHandler {
  method: string;
  path: string;
  handler: (
    req: Request,
    res: Response,
    next?: () => void,
  ) => void | Promise<void>;
}

function makeMockRouter(): { router: Router; routes: RouteHandler[] } {
  const routes: RouteHandler[] = [];
  const router = {
    get: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'GET', path, handler });
    },
    post: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'POST', path, handler });
    },
    put: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'PUT', path, handler });
    },
    patch: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'PATCH', path, handler });
    },
    delete: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'DELETE', path, handler });
    },
    use: (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method: 'USE', path, handler });
    },
  } as unknown as Router;
  return { router, routes };
}

function findRoute(
  routes: RouteHandler[],
  method: string,
  path: string,
): RouteHandler | undefined {
  return routes.find((r) => r.method === method && r.path === path);
}

// ---------------------------------------------------------------------------
// Mock req/res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  sessionId?: string;
}): Request {
  const req = {
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
  } as unknown as Request;
  if (overrides.sessionId !== undefined) {
    (req as Request & { sessionId?: string }).sessionId = overrides.sessionId;
  }
  return req;
}

interface MockRes {
  _status: number;
  _body: unknown;
  status(code: number): MockRes;
  json(data: unknown): MockRes;
  end(): void;
  res: Response;
}

function makeRes(): MockRes {
  const r: MockRes = {
    _status: 200,
    _body: undefined,
    status(code) {
      r._status = code;
      return r;
    },
    json(data) {
      r._body = data;
      return r;
    },
    end() {},
    get res() {
      return r as unknown as Response;
    },
  };
  return r;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asUser(id: string) {
  mockCdsContext.user = { id, is: () => false };
}

function asAnonymous() {
  mockCdsContext.user = undefined;
}

async function runWithMiddleware(
  routes: RouteHandler[],
  method: string,
  idRoutePath: string,
  req: Request,
): Promise<MockRes> {
  const res = makeRes();
  let nextCalled = false;

  const useHandler = findRoute(routes, 'USE', '/rag/collections/:id');
  if (useHandler) {
    await useHandler.handler(req, res.res, () => {
      nextCalled = true;
    });
  }

  if (!nextCalled) {
    return res;
  }

  const targetHandler = findRoute(routes, method, idRoutePath);
  if (!targetHandler) {
    throw new Error(`Route ${method} ${idRoutePath} not registered`);
  }
  await targetHandler.handler(req, res.res);
  return res;
}

async function doGet(
  routes: RouteHandler[],
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<MockRes> {
  const req = makeReq({ method: 'GET', headers, sessionId });
  const res = makeRes();
  const handler = findRoute(routes, 'GET', '/rag/collections');
  if (!handler) throw new Error('GET /rag/collections route not found');
  handler.handler(req, res.res);
  return res;
}

async function doPost(
  routes: RouteHandler[],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<MockRes> {
  const req = makeReq({ body, headers, method: 'POST', sessionId });
  const res = makeRes();
  const handler = findRoute(routes, 'POST', '/rag/collections');
  if (!handler) throw new Error('POST /rag/collections route not found');
  await Promise.resolve(handler.handler(req, res.res));
  return res;
}

// ---------------------------------------------------------------------------
// A. Cross-user session-scoped RAG isolation
// ---------------------------------------------------------------------------

describe('A. Cross-user session-scoped RAG isolation', () => {
  let registry: CollectionRegistry;
  let routes: RouteHandler[];

  beforeEach(() => {
    registry = new CollectionRegistry();
    const { router, routes: r } = makeMockRouter();
    registerRagRoutes(router, registry);
    routes = r;
    asAnonymous();
  });

  test("User B with same raw x-session-id as User A cannot see A's session collection in GET /rag/collections", async () => {
    const rawSessionId = 's1';

    // Alice creates a session collection
    asUser('alice@example.com');
    const alicePhysId = sessionCollectionId(
      'result',
      'alice@example.com',
      rawSessionId,
    );
    registry.createCollection({
      id: alicePhysId,
      logicalId: 'result',
      displayName: 'Alice Result',
      description: '',
      scope: 'session',
      owner: 'alice@example.com',
      sessionId: rawSessionId,
      expiresAt: Date.now() + 3_600_000,
    });

    // Bob requests with the SAME raw session id
    mockCdsContext.user = { id: 'bob@example.com', is: () => false };
    const res = await doGet(
      routes,
      { 'x-session-id': rawSessionId },
      rawSessionId,
    );

    expect(res._status).toBe(200);
    const body = res._body as { collections: Array<{ id: string }> };
    // Bob must NOT see Alice's collection
    expect(body.collections.map((c) => c.id)).not.toContain(alicePhysId);
  });

  test("User B with same raw x-session-id gets 404 on :id routes against A's physical id", async () => {
    const rawSessionId = 's1';

    // Alice's session collection
    asUser('alice@example.com');
    const alicePhysId = sessionCollectionId(
      'result',
      'alice@example.com',
      rawSessionId,
    );
    registry.createCollection({
      id: alicePhysId,
      logicalId: 'result',
      displayName: 'Alice Result',
      description: '',
      scope: 'session',
      owner: 'alice@example.com',
      sessionId: rawSessionId,
      expiresAt: Date.now() + 3_600_000,
    });

    // Bob tries to access Alice's physical id directly
    mockCdsContext.user = { id: 'bob@example.com', is: () => false };
    const req = makeReq({
      method: 'GET',
      params: { id: alicePhysId },
      path: '/',
      headers: { 'x-session-id': rawSessionId },
      sessionId: rawSessionId,
    });
    const res = await runWithMiddleware(
      routes,
      'GET',
      '/rag/collections/:id',
      req,
    );
    expect(res._status).toBe(404);
  });

  test('rag_add for User A and User B with same raw session id land in different physical ids', () => {
    const rawSessionId = 's1';

    const alicePhysId = sessionCollectionId(
      'result',
      'alice@example.com',
      rawSessionId,
    );
    const bobPhysId = sessionCollectionId(
      'result',
      'bob@example.com',
      rawSessionId,
    );

    // Physical ids must differ because sessionCollectionId hashes user+session together
    expect(alicePhysId).not.toBe(bobPhysId);
    // And neither should contain the other's email (PII-free)
    expect(alicePhysId).not.toContain('alice');
    expect(bobPhysId).not.toContain('bob');
  });

  test("DELETE /v1/session for User A does NOT delete User B's same-raw-sessionId collection", () => {
    const rawSessionId = 's1';

    // Create session collections for both users with the same raw session id
    const alicePhysId = sessionCollectionId(
      'notes',
      'alice@example.com',
      rawSessionId,
    );
    const bobPhysId = sessionCollectionId(
      'notes',
      'bob@example.com',
      rawSessionId,
    );

    registry.createCollection({
      id: alicePhysId,
      logicalId: 'notes',
      displayName: 'Alice Notes',
      description: '',
      scope: 'session',
      owner: 'alice@example.com',
      sessionId: rawSessionId,
      expiresAt: Date.now() + 3_600_000,
    });
    registry.createCollection({
      id: bobPhysId,
      logicalId: 'notes',
      displayName: 'Bob Notes',
      description: '',
      scope: 'session',
      owner: 'bob@example.com',
      sessionId: rawSessionId,
      expiresAt: Date.now() + 3_600_000,
    });

    // Alice deletes her session
    registry.deleteSessionCollections('alice@example.com', rawSessionId);

    // Alice's collection is gone
    expect(registry.getCollection(alicePhysId)).toBeNull();
    // Bob's collection is UNTOUCHED
    expect(registry.getCollection(bobPhysId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B. Cross-session-within-one-user RAG isolation
// ---------------------------------------------------------------------------

describe('B. Cross-session-within-one-user RAG isolation', () => {
  let registry: CollectionRegistry;
  let routes: RouteHandler[];

  beforeEach(() => {
    registry = new CollectionRegistry();
    const { router, routes: r } = makeMockRouter();
    registerRagRoutes(router, registry);
    routes = r;
    asAnonymous();
  });

  test("Alice in session s1: s2 listing does NOT show s1's session collection", async () => {
    asUser('alice@example.com');

    // Create a collection in session s1
    const sess1Id = sessionCollectionId(
      'notes',
      'alice@example.com',
      'session-1',
    );
    registry.createCollection({
      id: sess1Id,
      logicalId: 'notes',
      displayName: 'Notes s1',
      description: '',
      scope: 'session',
      owner: 'alice@example.com',
      sessionId: 'session-1',
      expiresAt: Date.now() + 3_600_000,
    });

    // Request from session-2: should NOT see session-1's collection
    const res = await doGet(
      routes,
      { 'x-session-id': 'session-2' },
      'session-2',
    );
    const body = res._body as { collections: Array<{ id: string }> };
    expect(body.collections.map((c) => c.id)).not.toContain(sess1Id);
  });

  test('Alice in session s2 gets 404 on :id against s1 physical id', async () => {
    asUser('alice@example.com');

    const sess1PhysId = sessionCollectionId(
      'notes',
      'alice@example.com',
      'session-1',
    );
    registry.createCollection({
      id: sess1PhysId,
      logicalId: 'notes',
      displayName: 'Notes s1',
      description: '',
      scope: 'session',
      owner: 'alice@example.com',
      sessionId: 'session-1',
      expiresAt: Date.now() + 3_600_000,
    });

    // Alice in session-2 tries to access session-1's physical id
    const req = makeReq({
      method: 'GET',
      params: { id: sess1PhysId },
      path: '/',
      headers: { 'x-session-id': 'session-2' },
      sessionId: 'session-2',
    });
    const res = await runWithMiddleware(
      routes,
      'GET',
      '/rag/collections/:id',
      req,
    );
    expect(res._status).toBe(404);
  });

  test('rag_add in session s1 and s2 for same user lands in different physical ids', () => {
    const sess1PhysId = sessionCollectionId(
      'result',
      'alice@example.com',
      'session-1',
    );
    const sess2PhysId = sessionCollectionId(
      'result',
      'alice@example.com',
      'session-2',
    );
    expect(sess1PhysId).not.toBe(sess2PhysId);
  });

  test('User-scoped collections are always visible regardless of session', async () => {
    asUser('alice@example.com');
    const userPhysId = userCollectionId('always', 'alice@example.com');
    registry.createCollection({
      id: userPhysId,
      logicalId: 'always',
      displayName: 'Always visible',
      description: '',
      scope: 'user',
      owner: 'alice@example.com',
    });

    // Visible in session s1
    const res1 = await doGet(
      routes,
      { 'x-session-id': 'session-1' },
      'session-1',
    );
    const body1 = res1._body as { collections: Array<{ id: string }> };
    expect(body1.collections.map((c) => c.id)).toContain(userPhysId);

    // Visible in session s2
    const res2 = await doGet(
      routes,
      { 'x-session-id': 'session-2' },
      'session-2',
    );
    const body2 = res2._body as { collections: Array<{ id: string }> };
    expect(body2.collections.map((c) => c.id)).toContain(userPhysId);

    // Visible without any session
    const res3 = await doGet(routes, {});
    const body3 = res3._body as { collections: Array<{ id: string }> };
    expect(body3.collections.map((c) => c.id)).toContain(userPhysId);
  });
});

// ---------------------------------------------------------------------------
// C. Chat history (sessionStore) cross-user isolation
// ---------------------------------------------------------------------------

describe('C. Chat history (sessionStore) cross-user isolation', () => {
  const SESSION_ID = 'shared-session-xyz';
  const ALICE = 'alice@example.com';
  const BOB = 'bob@example.com';

  beforeEach(() => {
    // Clear any pre-existing session state
    clearSession(SESSION_ID, ALICE);
    clearSession(SESSION_ID, BOB);
  });

  afterEach(() => {
    clearSession(SESSION_ID, ALICE);
    clearSession(SESSION_ID, BOB);
  });

  test("Alice's history is NOT readable by Bob using the same session id", () => {
    // Alice appends a message
    appendToSession(SESSION_ID, ALICE, {
      role: 'user',
      content: 'Alice secret message',
    });
    appendToSession(SESSION_ID, ALICE, {
      role: 'assistant',
      content: 'Alice response',
    });

    // Bob reads using the same session id
    const bobHistory = getSessionHistory(SESSION_ID, BOB);

    // Bob must see empty history — NOT Alice's messages
    expect(bobHistory).toHaveLength(0);
    expect(JSON.stringify(bobHistory)).not.toContain('Alice secret message');
    expect(JSON.stringify(bobHistory)).not.toContain('Alice response');
  });

  test("Alice's history is correctly stored and retrievable by Alice", () => {
    appendToSession(SESSION_ID, ALICE, {
      role: 'user',
      content: 'Alice message',
    });
    appendToSession(SESSION_ID, ALICE, {
      role: 'assistant',
      content: 'Alice reply',
    });

    const aliceHistory = getSessionHistory(SESSION_ID, ALICE);
    expect(aliceHistory).toHaveLength(2);
    expect(aliceHistory[0].content).toBe('Alice message');
    expect(aliceHistory[1].content).toBe('Alice reply');
  });

  test('Alice and Bob accumulate independent histories in the same session id', () => {
    appendToSession(SESSION_ID, ALICE, {
      role: 'user',
      content: 'Alice turn 1',
    });
    appendToSession(SESSION_ID, BOB, { role: 'user', content: 'Bob turn 1' });
    appendToSession(SESSION_ID, ALICE, {
      role: 'assistant',
      content: 'Alice reply 1',
    });
    appendToSession(SESSION_ID, BOB, {
      role: 'assistant',
      content: 'Bob reply 1',
    });

    const aliceHistory = getSessionHistory(SESSION_ID, ALICE);
    const bobHistory = getSessionHistory(SESSION_ID, BOB);

    expect(aliceHistory).toHaveLength(2);
    expect(bobHistory).toHaveLength(2);

    // Cross-check: no leakage
    const aliceStr = JSON.stringify(aliceHistory);
    const bobStr = JSON.stringify(bobHistory);
    expect(aliceStr).not.toContain('Bob');
    expect(bobStr).not.toContain('Alice');
  });

  test("clearSession for Alice does NOT clear Bob's history for the same session id", () => {
    appendToSession(SESSION_ID, ALICE, {
      role: 'user',
      content: 'Alice message',
    });
    appendToSession(SESSION_ID, BOB, { role: 'user', content: 'Bob message' });

    clearSession(SESSION_ID, ALICE);

    // Alice's history is cleared
    expect(getSessionHistory(SESSION_ID, ALICE)).toHaveLength(0);
    // Bob's history is untouched
    const bobHistory = getSessionHistory(SESSION_ID, BOB);
    expect(bobHistory).toHaveLength(1);
    expect(bobHistory[0].content).toBe('Bob message');
  });

  test('anonymous user sessions are isolated from each other (no cross-anonymous-session leak)', () => {
    const ANON = 'anonymous';
    const SESSION_A = 'session-a';
    const SESSION_B = 'session-b';

    appendToSession(SESSION_A, ANON, {
      role: 'user',
      content: 'Anon in session A',
    });
    const historyB = getSessionHistory(SESSION_B, ANON);
    expect(historyB).toHaveLength(0);

    clearSession(SESSION_A, ANON);
  });
});

// ---------------------------------------------------------------------------
// D. Cookie identity does not cross-contaminate
// ---------------------------------------------------------------------------

describe('D. Cookie identity does not cross-contaminate', () => {
  const COOKIE_SESSION = 'cookie-session-abc';
  const ALICE = 'alice@example.com';
  const BOB = 'bob@example.com';

  beforeEach(() => {
    clearSession(COOKIE_SESSION, ALICE);
    clearSession(COOKIE_SESSION, BOB);
  });

  afterEach(() => {
    clearSession(COOKIE_SESSION, ALICE);
    clearSession(COOKIE_SESSION, BOB);
  });

  test("Bob presenting Alice's cookie session id sees empty history, not Alice's", () => {
    // Alice makes a request and builds history
    appendToSession(COOKIE_SESSION, ALICE, {
      role: 'user',
      content: 'Alice private question',
    });
    appendToSession(COOKIE_SESSION, ALICE, {
      role: 'assistant',
      content: 'Alice private answer',
    });

    // Bob presents the same cookie value (theft / header spoofing scenario)
    const bobHistory = getSessionHistory(COOKIE_SESSION, BOB);

    // Bob must see empty history
    expect(bobHistory).toHaveLength(0);
    expect(JSON.stringify(bobHistory)).not.toContain('Alice private question');
    expect(JSON.stringify(bobHistory)).not.toContain('Alice private answer');
  });

  test('Server-side session lookup is user-scoped: same cookie, different users = different entries', () => {
    appendToSession(COOKIE_SESSION, ALICE, { role: 'user', content: 'A msg' });
    appendToSession(COOKIE_SESSION, BOB, { role: 'user', content: 'B msg' });

    expect(getSessionHistory(COOKIE_SESSION, ALICE)).toHaveLength(1);
    expect(getSessionHistory(COOKIE_SESSION, BOB)).toHaveLength(1);
    expect(getSessionHistory(COOKIE_SESSION, ALICE)[0].content).toBe('A msg');
    expect(getSessionHistory(COOKIE_SESSION, BOB)[0].content).toBe('B msg');
  });
});
