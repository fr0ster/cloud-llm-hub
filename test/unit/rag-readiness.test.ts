import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { ragReadinessGuard } from '../../srv/lib/rag-readiness';

test('requests before migration get 503', async () => {
  let ready = false;
  const app = express();
  app.use(ragReadinessGuard(() => ready));
  app.use('/chat/webapp', express.static(path.resolve('app/chat/webapp')));
  app.use((req, res) => {
    res.status(req.path === '/not-a-route' ? 404 : 200).end();
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const routes = [
      '/V1/session',
      '/v1/SESSION',
      '/V1/session/',
      '/v1/session/models',
      '/v1/token',
      '/MCP/agent/stream/http',
      '/mcp/stream/http',
      '/health/',
      '/HEALTH',
      '/not-a-route',
      '/chat/webapp/api/sessions',
      '/chat/webapp',
      '/v1/%73ession',
      '/%68ealth',
      '/chat/webapp/vendor/jszip.min.js/extra',
      '/chat/webapp/vendor/%ZZ',
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/rag/collections',
      '/mcp/agent/stream/http',
      '/health',
      '/mcp/health',
    ];
    for (const route of routes) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
        expect((await fetch(base + route, { method })).status).toBe(503);
      }
    }
    for (const asset of [
      '/chat/webapp/vendor/jszip.min.js',
      '/CHAT/WEBAPP/vendor/jszip.min.js',
      '/chat/webapp/vendor/%6aszip.min.js',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + asset, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/javascript/);
        await response.text();
      }
      expect((await fetch(base + asset, { method: 'POST' })).status).toBe(503);
    }
    ready = true;
    for (const route of routes) {
      for (const method of ['GET', 'POST']) {
        expect((await fetch(base + route, { method })).status).toBe(
          route === '/not-a-route' ? 404 : 200,
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
