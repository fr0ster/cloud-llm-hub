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
      parentPort?.postMessage({ warning: 'MAX_MB_REACHED' });
      return;
    }
    if (!stopped) {
      if (!database) {
        database = new DatabaseSync(path);
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
    }
    parentPort?.postMessage({});
  });
  parentPort?.on('close', () => database?.close());
}
