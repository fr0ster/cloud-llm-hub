/**
 * A real Postgres with pgvector for unit tests: PGlite (Postgres in WASM)
 * served over TCP by @electric-sql/pglite-socket in a child process, with the
 * pg-vector-rag shared layout (`sharedLayoutSql`) deployed in a fresh schema.
 *
 * The data directory lives until `stop()`, so `restart()` brings the same
 * database back on the same port — a backend that went away and came back.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { createPgClient, sharedLayoutSql } from '@mcp-abap-adt/pg-vector-rag';

export interface PgliteHandle {
  /** Address only; log in with `credential`. */
  url: string;
  schema: string;
  credential: ReturnType<typeof staticLogin>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const SCRIPT = path.join(__dirname, 'serve-pglite.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function launch(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SCRIPT, String(port), dataDir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PGlite did not start within 60 s'));
    }, 60_000);
    child.stdout?.on('data', (d) => {
      buf += String(d);
      if (buf.includes('PGLITE_READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`PGlite exited early (code ${code})`));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 15_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin?.end('stop\n');
  });
}

export async function startPglite(opts: {
  dimension: number;
}): Promise<PgliteHandle> {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'clh-pglite-'));
  let child = await launch(port, dataDir);
  const url = `postgres://127.0.0.1:${port}/postgres`;
  const credential = staticLogin('postgres', 'postgres');
  const schema = `t_${process.pid}_${Date.now()}`;

  const client = await createPgClient({
    connectionString: url,
    credential,
    collectionName: 'setup',
    poolMax: 1,
  });
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`CREATE SCHEMA "${schema}"`);
    // A pool of one connection: the search_path holds for every statement of
    // the script (sharedLayoutSql's tables are unqualified).
    await client.query(`SET search_path TO "${schema}", public`);
    for (const stmt of sharedLayoutSql({ dimension: opts.dimension }).split(
      ';\n',
    )) {
      const sql = stmt.trim().replace(/;$/, '');
      if (sql) await client.query(sql);
    }
    await client.query('RESET search_path');
  } finally {
    await client.end();
  }

  return {
    url,
    schema,
    credential,
    async stop() {
      await stopChild(child);
      rmSync(dataDir, { recursive: true, force: true });
    },
    async restart() {
      await stopChild(child);
      child = await launch(port, dataDir);
    },
  };
}
