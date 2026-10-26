import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { noopRecorder } from '@mcp-abap-adt/llm-usage';
import express, { type Request, type Response } from 'express';
import { requireMcpRole } from '../../srv/lib/require-mcp-role';
import type { UsageRuntime } from '../../srv/lib/usage/runtime';
import { setUsageRuntimeForTest } from '../../srv/lib/usage/runtime-state';
import { createUsageRouter } from '../../srv/usage-handler';

let mockRoles: string[] = [];
jest.mock('@sap/cds', (): object => ({
  context: {
    user: {
      id: 'admin',
      is: (role: string): boolean => mockRoles.includes(role),
    },
  },
}));

function runtime(): UsageRuntime {
  return {
    recorder: noopRecorder,
    forSession: (): typeof noopRecorder => noopRecorder,
    status: () => ({
      enabled: true,
      sinks: ['memory'],
      fallback: [],
      buffered: 2,
      delivered: 4,
      unconfirmed: 1,
      lost: {},
      lastErrorCode: 'TEST',
    }),
    enabled: (): boolean => true,
    schedule: (): void => {},
    onClose: (): void => {},
    close: async () => ({ delivered: 0, lost: 0, unconfirmed: 0 }),
  };
}
let server: Server;
let base: string;
let sessionResolution: jest.Mock;
let responseProbe: ((res: Response) => void) | undefined;
beforeEach(async (): Promise<void> => {
  mockRoles = ['MCP_Admin'];
  setUsageRuntimeForTest(runtime());
  const app = express();
  sessionResolution = jest.fn();
  responseProbe = undefined;
  app.use(
    '/v1/usage',
    (_req: Request, res: Response, next: express.NextFunction): void => {
      responseProbe?.(res);
      next();
    },
  );
  app.use('/v1/usage', createUsageRouter());
  app.use('/v1', requireMcpRole);

  app.use(
    '/v1',
    (_req: Request, _res: Response, next: express.NextFunction): void => {
      sessionResolution();
      next();
    },
  );
  app.get('/v1/tools', (_req: Request, res: Response): void => {
    res.end();
  });
  server = app.listen(0);
  await new Promise<void>((resolve: () => void): void => {
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async (): Promise<void> => {
  setUsageRuntimeForTest(undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve: () => void): void => {
    server.close((): void => resolve());
  });
});
it.each([['MCP_Admin'], ['MCP_Admin', 'MCP_Developer']])(
  'admin routes accept %s with stale sessions',
  async (...roles: string[]): Promise<void> => {
    mockRoles = roles;
    expect((await fetch(`${base}/v1/tools`)).status).toBe(
      roles.includes('MCP_Developer') ? 200 : 403,
    );
    sessionResolution.mockClear();
    const response = await fetch(`${base}/v1/usage/status`, {
      headers: { 'x-clh-session': 'stale' },
    });
    expect(response.status).toBe(200);
    expect(sessionResolution).not.toHaveBeenCalled();
  },
);
it.each(['MCP_Reader', 'MCP_Developer'])(
  'denies %s without admin',
  async (role: string): Promise<void> => {
    mockRoles = [role];
    expect((await fetch(`${base}/v1/usage/status`)).status).toBe(403);
    expect(
      (await fetch(`${base}/v1/usage/records?from=100&to=200`)).status,
    ).toBe(403);
  },
);
it('admin alone has no tool access', async (): Promise<void> => {
  expect((await fetch(`${base}/v1/tools`)).status).toBe(403);
});
it('mounts admin routes before tool authorization and session resolution', (): void => {
  const source = readFileSync('srv/server.ts', 'utf8');
  const admin = source.indexOf("'/v1/usage'");
  expect(admin).toBeGreaterThan(0);
  expect(admin).toBeLessThan(
    source.indexOf("app.use('/v1', context, wrappedAuth, requireMcpRole"),
  );
  expect(admin).toBeLessThan(source.indexOf('sessionMiddleware({'));
});
it('off returns clear 404 for status', async (): Promise<void> => {
  setUsageRuntimeForTest(undefined);
  const response = await fetch(`${base}/v1/usage/status`);
  expect(response.status).toBe(404);
  expect(await response.text()).toContain('recording is off');
  expect((await fetch(`${base}/v1/usage/records?from=100&to=200`)).status).toBe(
    404,
  );
});
it('reports runtime health only', async (): Promise<void> => {
  const response = await fetch(`${base}/v1/usage/status`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(JSON.stringify(runtime().status()));
});
it.each(['', '/'])(
  'usage router terminates paths with suffix %s',
  async (suffix: string): Promise<void> => {
    for (const role of ['MCP_Admin', 'MCP_Developer']) {
      mockRoles = [role];
      for (const method of [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ]) {
        for (const path of ['records', 'status', 'missing', '']) {
          const response = await fetch(`${base}/v1/usage/${path}${suffix}`, {
            method,
          });
          const known = path === 'status';
          expect(response.status).toBe(
            role !== 'MCP_Admin'
              ? 403
              : !known
                ? 404
                : method !== 'GET'
                  ? 405
                  : 200,
          );
          if (role === 'MCP_Admin' && known && method !== 'GET')
            expect(response.headers.get('allow')).toBe('GET');
        }
      }
    }
    expect(sessionResolution).not.toHaveBeenCalled();
  },
);

function snapshot(source: UnderlyingDefaultSource<Uint8Array>): void {
  setUsageRuntimeForTest({
    ...runtime(),
    sqliteSnapshot: async (): Promise<ReadableStream<Uint8Array>> =>
      new ReadableStream<Uint8Array>(source),
  });
}
it('downloads exact snapshot bytes with attachment headers', async (): Promise<void> => {
  const bytes = new Uint8Array([0, 255, 83, 81, 76, 0]);
  snapshot({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const response = await fetch(`${base}/v1/usage/sqlite`, {
    headers: { 'x-clh-session': 'stale' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/vnd.sqlite3');
  expect(response.headers.get('content-disposition')).toMatch(
    /^attachment; filename="usage-[\w-]+-\d{8}T\d{6}Z\.sqlite"$/,
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(sessionResolution).not.toHaveBeenCalled();
});
it('denies SQLite downloads without admin', async (): Promise<void> => {
  mockRoles = ['MCP_Developer'];
  expect((await fetch(`${base}/v1/usage/sqlite`)).status).toBe(403);
});
it.each([true, false])(
  'SQLite unavailable returns clear 404 (off=%s)',
  async (off: boolean): Promise<void> => {
    if (off) setUsageRuntimeForTest(undefined);
    const response = await fetch(`${base}/v1/usage/sqlite`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(
      off ? 'recording is off' : 'SQLite usage sink is not active',
    );
  },
);
it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
  'SQLite %s returns 405',
  async (method: string): Promise<void> => {
    const response = await fetch(`${base}/v1/usage/sqlite`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  },
);
it('cancels a pending source read on disconnect', async (): Promise<void> => {
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve: () => void): void => {
    cancelled = resolve;
  });
  snapshot({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel: cancelled,
  });
  const abort = new AbortController();
  const response = await fetch(`${base}/v1/usage/sqlite`, {
    signal: abort.signal,
  });
  await response.body?.getReader().read();
  abort.abort();
  await cancellation;
});
it.each(['snapshot', 'read'])(
  'sanitizes %s failure before headers',
  async (mode: string): Promise<void> => {
    if (mode === 'snapshot')
      setUsageRuntimeForTest({
        ...runtime(),
        sqliteSnapshot: async (): Promise<ReadableStream<Uint8Array>> => {
          throw new Error('secret stack');
        },
      });
    else
      snapshot({
        start(controller: ReadableStreamDefaultController<Uint8Array>): void {
          controller.error(new Error('secret stack'));
        },
      });
    const response = await fetch(`${base}/v1/usage/sqlite`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: 'SQLite usage snapshot failed',
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toBeNull();
  },
);
it('destroys the response on source error after headers', async (): Promise<void> => {
  let fail!: () => void;
  snapshot({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(new Uint8Array([1]));
      fail = (): void => controller.error(new Error('secret'));
    },
  });
  const response = await fetch(`${base}/v1/usage/sqlite`);
  expect(response.status).toBe(200);
  fail();
  await expect(response.arrayBuffer()).rejects.toThrow();
});
it('bounds drain and close listeners across many backpressured chunks', async (): Promise<void> => {
  let chunks = 0;
  let maxDrain = 0;
  let maxClose = 0;
  let maxAhead = 0;
  let writes = 0;
  let observed: Response | undefined;
  responseProbe = (res: Response): void => {
    observed = res;
    const write = res.write.bind(res);
    jest
      .spyOn(res, 'write')
      .mockImplementation((chunk: Uint8Array): boolean => {
        writes++;
        maxAhead = Math.max(maxAhead, chunks - writes);
        maxDrain = Math.max(maxDrain, res.listenerCount('drain'));
        maxClose = Math.max(maxClose, res.listenerCount('close'));
        write(chunk);
        setImmediate((): void => {
          res.emit('drain');
        });
        return false;
      });
  };
  snapshot({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      if (chunks++ < 1000) controller.enqueue(new Uint8Array([42]));
      else controller.close();
    },
  });
  const response = await fetch(`${base}/v1/usage/sqlite`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(1000).fill(42),
  );
  expect(maxDrain).toBe(1);
  expect(maxClose).toBeLessThanOrEqual(2);
  expect(maxAhead).toBeLessThanOrEqual(1);
  expect(observed?.listenerCount('drain')).toBe(0);
});

it('cancels a snapshot that becomes ready after disconnect', async (): Promise<void> => {
  let ready!: (stream: ReadableStream<Uint8Array>) => void;
  let started!: () => void;
  let cancelled!: () => void;
  const begun = new Promise<void>((resolve: () => void): void => {
    started = resolve;
  });
  const cancellation = new Promise<void>((resolve: () => void): void => {
    cancelled = resolve;
  });
  const pending = new Promise<ReadableStream<Uint8Array>>(
    (resolve: (stream: ReadableStream<Uint8Array>) => void): void => {
      ready = resolve;
    },
  );
  setUsageRuntimeForTest({
    ...runtime(),
    sqliteSnapshot: (): Promise<ReadableStream<Uint8Array>> => {
      started();
      return pending;
    },
  });
  const abort = new AbortController();
  const request = fetch(`${base}/v1/usage/sqlite`, {
    signal: abort.signal,
  }).catch((): void => {});
  await begun;
  abort.abort();
  await request;
  ready(new ReadableStream<Uint8Array>({ cancel: cancelled }));
  await cancellation;
});
it('cancels and releases the backpressure waiter on disconnect', async (): Promise<void> => {
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve: () => void): void => {
    cancelled = resolve;
  });
  let observed: Response | undefined;
  responseProbe = (res: Response): void => {
    observed = res;
    const write = res.write.bind(res);
    jest
      .spyOn(res, 'write')
      .mockImplementation((chunk: Uint8Array): boolean => {
        write(chunk);
        setImmediate((): void => {
          res.destroy();
        });
        return false;
      });
  };
  snapshot({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel: cancelled,
  });
  await fetch(`${base}/v1/usage/sqlite`)
    .then(async (response: globalThis.Response): Promise<void> => {
      await response.arrayBuffer();
    })
    .catch((): void => {});
  await cancellation;
  await new Promise<void>((resolve: () => void): void => {
    setImmediate(resolve);
  });
  expect(observed?.listenerCount('drain')).toBe(0);
});
