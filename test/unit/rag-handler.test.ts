/**
 * Unit tests for rag-handler Task 6 behaviour:
 * - POST /rag/collections: user-scope creates <logical>__u_<key>, idempotent
 * - POST /rag/collections: session-scope requires x-session-id
 * - POST /rag/collections: scope:'global' → 400
 * - POST /rag/collections: __ in id → 400
 * - PATCH /rag/collections/:id/enabled: persists enabled state; 404 when absent
 * - GET /rag/collections: returns logicalId/scope/enabled; filters other-session collections
 *
 * We test handler logic by calling registerRagRoutes on a mock Express router
 * and then directly invoking the registered route handlers with mock req/res
 * objects. This avoids starting a real HTTP server.
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
  sanitizeUserKey,
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
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

// Find a specific route handler in the registered list
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
}): Request {
  return {
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
  } as unknown as Request;
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
// Helper: set authenticated user
// ---------------------------------------------------------------------------

function asUser(id: string) {
  mockCdsContext.user = { id, is: () => false };
}
function asAnonymous() {
  mockCdsContext.user = undefined;
}

// ---------------------------------------------------------------------------
// Run the :id middleware chain (USE handler) then the target handler
// ---------------------------------------------------------------------------

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
    // Middleware blocked the request (sent a response).
    return res;
  }

  const targetHandler = findRoute(routes, method, idRoutePath);
  if (!targetHandler) {
    throw new Error(`Route ${method} ${idRoutePath} not registered`);
  }
  await targetHandler.handler(req, res.res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rag-handler — Task 6: create, :id routes, PATCH enabled, listing', () => {
  let registry: CollectionRegistry;
  let routes: RouteHandler[];

  beforeEach(() => {
    registry = new CollectionRegistry();
    const { router, routes: r } = makeMockRouter();
    registerRagRoutes(router, registry);
    routes = r;
    asAnonymous();
  });

  // -------------------------------------------------------------------------
  // POST /rag/collections
  // -------------------------------------------------------------------------

  describe('POST /rag/collections', () => {
    async function doPost(
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) {
      const req = makeReq({ body, headers, method: 'POST' });
      const res = makeRes();
      const handler = findRoute(routes, 'POST', '/rag/collections');
      if (!handler) throw new Error('POST /rag/collections route not found');
      await Promise.resolve(handler.handler(req, res.res));
      return res;
    }

    test('user-scope create: physical id is <logical>__u_<key>', async () => {
      asUser('alice@example.com');
      const res = await doPost({ id: 'result', displayName: 'Result' });
      expect(res._status).toBe(201);
      const expectedId = userCollectionId('result', 'alice@example.com');
      expect((res._body as { id?: string }).id).toBe(expectedId);
      expect(registry.getCollection(expectedId)).not.toBeNull();
    });

    test('user-scope create: idempotent — second call returns 200 with existing meta', async () => {
      asUser('alice@example.com');
      const res1 = await doPost({ id: 'result', displayName: 'Result' });
      expect(res1._status).toBe(201);
      const res2 = await doPost({
        id: 'result',
        displayName: 'Result (again)',
      });
      expect(res2._status).toBe(200);
      // Should return the same physical id
      expect((res2._body as { id?: string }).id).toBe(
        (res1._body as { id?: string }).id,
      );
    });

    test('session-scope without x-session-id → 400', async () => {
      asUser('alice@example.com');
      const res = await doPost({
        id: 'result',
        displayName: 'Result',
        scope: 'session',
      });
      expect(res._status).toBe(400);
      expect(JSON.stringify(res._body)).toMatch(/session/i);
    });

    test('session-scope with x-session-id: physical id is <logical>__s_<key>', async () => {
      asUser('alice@example.com');
      const res = await doPost(
        { id: 'result', displayName: 'Result', scope: 'session' },
        { 'x-session-id': 'sess-abc' },
      );
      expect(res._status).toBe(201);
      const expectedId = sessionCollectionId(
        'result',
        'alice@example.com',
        'sess-abc',
      );
      expect((res._body as { id?: string }).id).toBe(expectedId);
    });

    test('scope global → 400', async () => {
      asUser('alice@example.com');
      const res = await doPost({
        id: 'result',
        displayName: 'Result',
        scope: 'global',
      });
      expect(res._status).toBe(400);
      expect(JSON.stringify(res._body)).toMatch(/global/i);
    });

    test('id with __ → 400 (reserved separator)', async () => {
      asUser('alice@example.com');
      const res = await doPost({ id: 'a__b', displayName: 'Bad Id' });
      expect(res._status).toBe(400);
      expect(JSON.stringify(res._body)).toMatch(/__/);
    });

    test('anonymous user → 401', async () => {
      asAnonymous();
      const res = await doPost({ id: 'result', displayName: 'Result' });
      expect(res._status).toBe(401);
    });

    test('missing id → 400', async () => {
      asUser('alice@example.com');
      const res = await doPost({ displayName: 'No Id' });
      expect(res._status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /rag/collections/:id/enabled
  // -------------------------------------------------------------------------

  describe('PATCH /rag/collections/:id/enabled', () => {
    test('persists enabled=false and returns {id, enabled}', async () => {
      asUser('alice@example.com');
      const physId = userCollectionId('result', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'result',
        displayName: 'Result',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });

      const req = makeReq({
        body: { enabled: false },
        params: { id: physId },
        method: 'PATCH',
        path: '/enabled',
        headers: {},
      });
      const res = await runWithMiddleware(
        routes,
        'PATCH',
        '/rag/collections/:id/enabled',
        req,
      );

      expect(res._status).toBe(200);
      expect((res._body as { enabled?: boolean }).enabled).toBe(false);
      expect(registry.getEnabled('alice@example.com', physId)).toBe(false);
    });

    test('persists enabled=true', async () => {
      asUser('alice@example.com');
      const physId = userCollectionId('result', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'result',
        displayName: 'Result',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });
      registry.setEnabled('alice@example.com', physId, false); // set to false first

      const req = makeReq({
        body: { enabled: true },
        params: { id: physId },
        method: 'PATCH',
        path: '/enabled',
        headers: {},
      });
      const res = await runWithMiddleware(
        routes,
        'PATCH',
        '/rag/collections/:id/enabled',
        req,
      );

      expect(res._status).toBe(200);
      expect((res._body as { enabled?: boolean }).enabled).toBe(true);
    });

    test('404 when collection does not exist', async () => {
      asUser('alice@example.com');
      const req = makeReq({
        body: { enabled: true },
        params: { id: 'nonexistent' },
        method: 'PATCH',
        path: '/enabled',
        headers: {},
      });
      const res = await runWithMiddleware(
        routes,
        'PATCH',
        '/rag/collections/:id/enabled',
        req,
      );
      expect(res._status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /rag/collections — listing fields + session filter
  // -------------------------------------------------------------------------

  describe('GET /rag/collections', () => {
    function doGet(headers: Record<string, string> = {}) {
      const req = makeReq({ method: 'GET', headers });
      const res = makeRes();
      const handler = findRoute(routes, 'GET', '/rag/collections');
      if (!handler) throw new Error('GET /rag/collections route not found');
      handler.handler(req, res.res);
      return res;
    }

    test('returns logicalId, scope, and enabled for user collections', () => {
      asUser('alice@example.com');
      const physId = userCollectionId('result', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'result',
        displayName: 'Result',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });
      registry.setEnabled('alice@example.com', physId, false);

      const res = doGet();
      expect(res._status).toBe(200);
      const body = res._body as {
        collections: Array<{
          id: string;
          logicalId: string;
          scope: string;
          enabled: boolean;
        }>;
      };
      expect(body.collections).toHaveLength(1);
      const c = body.collections[0];
      expect(c.id).toBe(physId);
      expect(c.logicalId).toBe('result');
      expect(c.scope).toBe('user');
      expect(c.enabled).toBe(false);
    });

    test('enabled defaults to true for non-preset collections', () => {
      asUser('alice@example.com');
      const physId = userCollectionId('notes', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'notes',
        displayName: 'Notes',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });
      // No setEnabled call — should default to true

      const res = doGet();
      const body = res._body as { collections: Array<{ enabled: boolean }> };
      expect(body.collections[0].enabled).toBe(true);
    });

    test('enabled defaults to false for preset collections', () => {
      asUser('alice@example.com');
      const physId = userCollectionId('preset-col', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'preset-col',
        displayName: 'Preset',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
        preset: true,
      });

      const res = doGet();
      const body = res._body as { collections: Array<{ enabled: boolean }> };
      expect(body.collections[0].enabled).toBe(false);
    });

    test('session collections from other sessions are filtered out', () => {
      asUser('alice@example.com');
      const sessId1 = sessionCollectionId(
        'notes',
        'alice@example.com',
        'session-1',
      );
      const sessId2 = sessionCollectionId(
        'notes',
        'alice@example.com',
        'session-2',
      );
      registry.createCollection({
        id: sessId1,
        logicalId: 'notes',
        displayName: 'Notes sess1',
        description: '',
        scope: 'session',
        owner: 'alice@example.com',
        sessionId: 'session-1',
        expiresAt: Date.now() + 3600_000,
      });
      registry.createCollection({
        id: sessId2,
        logicalId: 'notes',
        displayName: 'Notes sess2',
        description: '',
        scope: 'session',
        owner: 'alice@example.com',
        sessionId: 'session-2',
        expiresAt: Date.now() + 3600_000,
      });

      // Request from session-1 — should only see session-1 collection
      const res = doGet({ 'x-session-id': 'session-1' });
      const body = res._body as { collections: Array<{ id: string }> };
      expect(body.collections.map((c) => c.id)).toContain(sessId1);
      expect(body.collections.map((c) => c.id)).not.toContain(sessId2);
    });

    test('user collections are always visible regardless of session header', () => {
      asUser('alice@example.com');
      const physId = userCollectionId('always', 'alice@example.com');
      registry.createCollection({
        id: physId,
        logicalId: 'always',
        displayName: 'Always visible',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });

      const res = doGet({ 'x-session-id': 'some-session' });
      const body = res._body as { collections: Array<{ id: string }> };
      expect(body.collections.map((c) => c.id)).toContain(physId);
    });

    test('two users never see each other collections', () => {
      asUser('alice@example.com');
      const aliceId = userCollectionId('result', 'alice@example.com');
      registry.createCollection({
        id: aliceId,
        logicalId: 'result',
        displayName: 'Alice Result',
        description: '',
        scope: 'user',
        owner: 'alice@example.com',
      });
      const bobId = userCollectionId('result', 'bob@example.com');
      registry.createCollection({
        id: bobId,
        logicalId: 'result',
        displayName: 'Bob Result',
        description: '',
        scope: 'user',
        owner: 'bob@example.com',
      });

      // Alice's listing
      const aliceRes = doGet();
      const aliceBody = aliceRes._body as {
        collections: Array<{ id: string }>;
      };
      expect(aliceBody.collections.map((c) => c.id)).toEqual([aliceId]);
      expect(aliceBody.collections.map((c) => c.id)).not.toContain(bobId);

      // Bob's listing
      mockCdsContext.user = { id: 'bob@example.com', is: () => false };
      const bobRes = doGet();
      const bobBody = bobRes._body as { collections: Array<{ id: string }> };
      expect(bobBody.collections.map((c) => c.id)).toEqual([bobId]);
      expect(bobBody.collections.map((c) => c.id)).not.toContain(aliceId);
    });

    test('sanitizeUserKey is PII-free — user email not in physical id', () => {
      asUser('alice@example.com');
      const physId = userCollectionId('result', 'alice@example.com');
      expect(physId).not.toContain('alice');
      const key = sanitizeUserKey('alice@example.com');
      expect(key).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-user isolation at the HTTP/handler level
  // -------------------------------------------------------------------------

  describe('GET /rag/collections/:id — cross-user isolation', () => {
    test("alice gets 404 when requesting bob's collection by physical id", async () => {
      // Register a collection physically owned by bob
      const bobPhysicalId = userCollectionId('secret', 'bob@example.com');
      registry.createCollection({
        id: bobPhysicalId,
        logicalId: 'secret',
        scope: 'user',
        owner: 'bob@example.com',
        displayName: 'secret',
        description: '',
      });

      // Make a request as alice through the full middleware+handler chain
      asUser('alice@example.com');
      const req = makeReq({
        method: 'GET',
        params: { id: bobPhysicalId },
        path: '/',
        headers: {},
      });

      const res = await runWithMiddleware(
        routes,
        'GET',
        '/rag/collections/:id',
        req,
      );

      // Alice must not be able to see bob's collection — middleware returns 404
      expect(res._status).toBe(404);
    });
  });
});
