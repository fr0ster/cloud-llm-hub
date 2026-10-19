/**
 * A real Postgres with pgvector for unit tests: PGlite (Postgres in WASM)
 * served over TCP by @electric-sql/pglite-socket in a child process, with the
 * pg-vector-rag shared layout (`sharedLayoutSql`) deployed in a fresh schema.
 *
 * The data directory lives until `stop()`, so `restart()` brings the same
 * database back on the same port — a backend that went away and came back.
 * End every `pg` pool on it before `restart()`: pg-vector-rag's pool has no
 * 'error' listener, so a dropped idle connection would be an uncaught error.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { createPgClient, sharedLayoutSql } from '@mcp-abap-adt/pg-vector-rag';

export interface PgliteHandle {
  /** Address only; log in with `credential`. Stays valid across `restart()`. */
  url: string;
  schema: string;
  credential: ReturnType<typeof staticLogin>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stop the server and keep its data: the port refuses connections. */
  suspend(): Promise<void>;
  /** Bring a suspended server back on the same port, with the same data. */
  resume(): Promise<void>;
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

/** Resolves once `port` can be bound again (the stopped server released it). */
async function portFree(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return;
    if (Date.now() > deadline)
      throw new Error(`port ${port} is still in use after the PGlite stop`);
    await new Promise((r) => setTimeout(r, 100));
  }
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
    const early = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`PGlite exited early (code ${code})`));
    };
    child.on('exit', early);
    child.stdout?.on('data', (d) => {
      buf += String(d);
      if (buf.includes('PGLITE_READY')) {
        clearTimeout(timer);
        child.off('exit', early);
        resolve(child);
      }
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
  const url = `postgres://127.0.0.1:${port}/postgres`;
  const credential = staticLogin('postgres', 'postgres');
  const schema = `t_${process.pid}_${Date.now()}`;

  let child: ChildProcess | undefined;
  try {
    child = await launch(port, dataDir);
    const client = await createPgClient({
      connectionString: url,
      credential,
      collectionName: 'setup',
      poolMax: 1,
    });
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE SCHEMA "${schema}"`);
      // One multi-statement (simple protocol) query: the search_path holds for
      // the whole script, whose tables are unqualified, and nothing splits it
      // on ';' (a body containing one would survive).
      await client.query(
        [
          `SET search_path TO "${schema}", public;`,
          sharedLayoutSql({ dimension: opts.dimension }),
          'RESET search_path;',
        ].join('\n'),
      );
    } finally {
      await client.end();
    }
  } catch (err) {
    if (child) await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  let running: ChildProcess = child;
  return {
    url,
    schema,
    credential,
    async stop() {
      await stopChild(running);
      rmSync(dataDir, { recursive: true, force: true });
    },
    async restart() {
      await stopChild(running);
      await portFree(port);
      running = await launch(port, dataDir);
    },
    async suspend() {
      await stopChild(running);
      await portFree(port);
    },
    async resume() {
      running = await launch(port, dataDir);
    },
  };
}
