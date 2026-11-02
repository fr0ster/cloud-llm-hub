import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { requireMcpRole } from '../../srv/lib/require-mcp-role';

let roles: string[] = [];
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    get context() {
      return {
        user: { id: 'test', is: (role: string) => roles.includes(role) },
      };
    },
  },
}));

test.each([
  ['anonymous', 401],
  ['MCP_Analyst', 403],
  ['MCP_Reader', 204],
])('ping uses /v1 auth for %s', async (role, status) => {
  roles = [String(role)];
  const source = readFileSync('srv/server.ts', 'utf8');
  const auth = source.indexOf(
    "app.use('/v1', context, wrappedAuth, requireMcpRole, authJsonErrorHandler)",
  );
  const route = source.indexOf("app.get('/v1/ping'");
  expect(auth).toBeGreaterThan(-1);
  expect(route).toBeGreaterThan(auth);
  const app = express();
  app.use('/v1', requireMcpRole);
  runInNewContext(
    source
      .slice(route, source.indexOf('\n  });', route) + 6)
      .replace('_req: Request', '_req')
      .replace('res: Response', 'res'),
    { app },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test port');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/ping`);
    expect(response.status).toBe(status);
    if (status === 204) expect(await response.text()).toBe('');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
