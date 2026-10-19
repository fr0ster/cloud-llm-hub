// Serves PGlite (Postgres in WASM) with pgvector over TCP, so the ordinary `pg`
// driver can connect. Usage: node serve-pglite.mjs <port> <dataDir>
// Prints `PGLITE_READY` once listening; a line `stop` on stdin shuts it down
// cleanly (the data directory survives, so a restart finds the same data).
// A child process, because the PGlite packages are ESM-only and jest is not.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2]);
const dataDir = process.argv[3];
const db = await PGlite.create({ dataDir, extensions: { vector } });
const server = new PGLiteSocketServer({
  db,
  port,
  host: '127.0.0.1',
  maxConnections: 20,
});
await server.start();
console.log('PGLITE_READY');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await db.close();
  process.exit(0);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (String(d).includes('stop')) void stop();
});
process.stdin.on('end', () => void stop());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
