import type { ContextRow } from './context-store';

/** Self-contained entry point, compiled to JS before being passed to Worker.eval. */
export function contextWorker(): void {
  const { parentPort } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { existsSync, statSync } =
    require('node:fs') as typeof import('node:fs');
  const { DatabaseSync } =
    require('node:sqlite') as typeof import('node:sqlite');
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  let database: import('node:sqlite').DatabaseSync | undefined;
  let statement: import('node:sqlite').StatementSync | undefined;
  let activePath: string | undefined;
  let stopped = false;
  parentPort?.on('message', (serialized: string | null) => {
    if (serialized === null) {
      parentPort?.close();
      return;
    }
    const { row, path, maxMb } = JSON.parse(serialized) as {
      row: ContextRow;
      path: string;
      maxMb: string;
    };
    if (path !== activePath) {
      database?.close();
      database = undefined;
      statement = undefined;
      activePath = path;
      stopped = false;
    }
    const rawMax = Number(maxMb);
    const max =
      (Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 512) * 1024 * 1024;
    if (!stopped && existsSync(path) && statSync(path).size >= max) {
      stopped = true;
      parentPort?.postMessage({ warning: 'MAX_MB_REACHED', dropped: true });
      return;
    }
    if (stopped) {
      parentPort?.postMessage({ dropped: true });
      return;
    }
    try {
      if (!database) {
        database = new DatabaseSync(path);
        const pageSize = database.prepare('PRAGMA page_size').get()?.page_size;
        if (typeof pageSize !== 'number')
          throw new Error('Invalid SQLite page size');
        database.exec(
          `PRAGMA max_page_count = ${Math.max(1, Math.floor(max / pageSize))}`,
        );
        database.exec(`CREATE TABLE IF NOT EXISTS context_calls (
          id TEXT PRIMARY KEY, ts TEXT, session TEXT, component TEXT, model TEXT,
          trace TEXT, messages TEXT, tools TEXT, options TEXT, response TEXT,
          input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
          duration_ms REAL, ok INTEGER, error TEXT)`);
        statement = database.prepare(
          'INSERT INTO context_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
      }
      statement?.run(
        randomUUID(),
        row.ts,
        row.session,
        row.component,
        row.model,
        row.trace,
        row.messages,
        row.tools,
        row.options,
        row.response,
        row.inputTokens,
        row.outputTokens,
        row.cachedTokens,
        row.durationMs,
        row.ok ? 1 : 0,
        row.error,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('errcode' in error) ||
        error.errcode !== 13
      )
        throw error;
      stopped = true;
      parentPort?.postMessage({ warning: 'MAX_MB_REACHED', dropped: true });
      return;
    }
    parentPort?.postMessage({});
  });
  parentPort?.on('close', () => database?.close());
}
