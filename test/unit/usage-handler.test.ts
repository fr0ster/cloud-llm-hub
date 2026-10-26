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
beforeEach(async (): Promise<void> => {
  mockRoles = ['MCP_Admin'];
  setUsageRuntimeForTest(runtime());
  const app = express();
  sessionResolution = jest.fn();
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
