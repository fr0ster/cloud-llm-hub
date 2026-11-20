// Serves PGlite (Postgres in WASM) with pgvector over TCP, so the ordinary `pg`
// driver can connect. A worker thread runs the ESM packages outside Jest's
// module runtime and keeps the data directory for restart tests.
import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const { port, dataDir } = workerData;
const db = await PGlite.create({ dataDir, extensions: { vector } });
const server = new PGLiteSocketServer({
  db,
  port,
  host: '127.0.0.1',
  maxConnections: 20,
});
await server.start();
parentPort.postMessage('ready');
parentPort.once('message', async () => {
  await server.stop();
  await db.close();
  parentPort.close();
});
