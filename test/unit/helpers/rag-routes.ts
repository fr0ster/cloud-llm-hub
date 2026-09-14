import type { Request, Response, Router } from 'express';

export interface RouteHandler {
  method: string;
  path: string;
  handler: (
    req: Request,
    res: Response,
    next?: () => void,
  ) => void | Promise<void>;
}

export function makeMockRouter(): { router: Router; routes: RouteHandler[] } {
  const routes: RouteHandler[] = [];
  const add =
    (method: string) => (path: string, handler: RouteHandler['handler']) => {
      routes.push({ method, path, handler });
    };
  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    use: add('USE'),
  } as unknown as Router;
  return { router, routes };
}

export function findRoute(
  routes: RouteHandler[],
  method: string,
  path: string,
) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`${method} ${path} not registered`);
  return r;
}

export function makeReq(o: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  sessionId?: string;
  sessionMinted?: boolean;
}): Request {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: {},
    headers: o.headers ?? {},
    method: o.method ?? 'GET',
    path: o.path ?? '/',
    sessionId: o.sessionId,
    sessionMinted: o.sessionMinted,
  } as unknown as Request;
}

export interface MockRes {
  _status: number;
  _body: unknown;
  res: Response;
}

export function makeRes(): MockRes {
  const r = { _status: 200, _body: undefined as unknown } as MockRes;
  const res = {
    status(code: number) {
      r._status = code;
      return res;
    },
    json(data: unknown) {
      r._body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  r.res = res as unknown as Response;
  return r;
}

/** Run the `/rag/collections/:id` guard, then the route, as Express would. */
export async function runIdRoute(
  routes: RouteHandler[],
  method: string,
  path: string,
  req: Request,
): Promise<MockRes> {
  const res = makeRes();
  let passed = false;
  await findRoute(routes, 'USE', '/rag/collections/:id').handler(
    req,
    res.res,
    () => {
      passed = true;
    },
  );
  if (!passed) return res;
  await findRoute(routes, method, path).handler(req, res.res);
  return res;
}
