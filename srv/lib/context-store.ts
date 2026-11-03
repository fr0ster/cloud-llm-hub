import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import cds from '@sap/cds';

/** Redact strings before JSON encoding, including JSON embedded in tool arguments. */
export function redactContext(value: string): string {
  return value
    .replace(
      /((?:password|passwd|client_secret|clientsecret|sap-password|x-sap-[\w-]+|authorization)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+(?:[ \t]+[^\s,;}\r\n]+)?)/gi,
      (match, prefix: string) => {
        const raw = match.slice(prefix.length);
        // Only authorization consumes a scheme plus its credential.
        const tail =
          !/authorization/i.test(prefix) && !/^["']/.test(raw)
            ? raw.indexOf(' ')
            : -1;
        return `${prefix}${/^["']/.test(raw) ? '"«redacted»"' : '«redacted»'}${tail >= 0 ? raw.slice(tail) : ''}`;
      },
    )
    .replace(/(bearer\s+)[^\s"',;}]+/gi, '$1«redacted»');
}

export function contextJson(value: object): string {
  return JSON.stringify(
    value,
    (key, item: object | string | number | boolean | null) =>
      /^(password|passwd|client_secret|clientsecret|sap-password|x-sap-[\w-]+|authorization)$/i.test(
        key,
      )
        ? '\u00abredacted\u00bb'
        : typeof item === 'string'
          ? redactContext(item)
          : item,
  );
}

export interface ContextRow {
  ts: string;
  session: string | null;
  component: string;
  model: string | null;
  trace: string | null;
  messages: string;
  tools: string;
  options: string;
  response: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

const warned = new Set<string>();
export function warnContext(kind: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  try {
    cds.log('context-capture').warn(`Context capture: ${kind}`);
  } catch {}
}
let database: DatabaseSync | undefined;
let statement: StatementSync | undefined;
let activePath: string | undefined;
let stopped = false;
const queue: ContextRow[] = [];
let draining = false;

/** Bounded, ordered queue; SQLite work runs after the caller receives its result. */
export function appendContext(row: ContextRow): void {
  if (queue.length >= 64) {
    warnContext('QUEUE_FULL');
    return;
  }
  queue.push(row);
  if (draining) return;
  draining = true;
  setImmediate(() => {
    void drainContext();
  });
}

export async function drainContext(): Promise<void> {
  if (!queue.length) {
    draining = false;
    return;
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    while (queue.length) {
      const row = queue.shift();
      if (!row) continue;
      try {
        const path =
          process.env.LLM_AGENT_CONTEXT_CAPTURE_FILE?.trim() ||
          'context.sqlite';
        if (path !== activePath) {
          database?.close();
          database = undefined;
          statement = undefined;
          activePath = path;
          stopped = false;
        }
        if (stopped) continue;
        const rawMax = Number(
          process.env.LLM_AGENT_CONTEXT_CAPTURE_MAX_MB || 512,
        );
        const max =
          (Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 512) * 1024 * 1024;
        const size = existsSync(path) ? statSync(path).size : 0;
        if (size >= max) {
          stopped = true;
          warnContext('MAX_MB_REACHED');
          continue;
        }
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
      } catch (error) {
        warnContext(
          error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
            ? error.code
            : error instanceof Error
              ? error.name
              : 'WRITE_FAILED',
        );
      }
    }
  } catch {
    queue.length = 0;
    warnContext('SQLITE_UNAVAILABLE');
  } finally {
    draining = false;
  }
}

export function resetContextStore(): void {
  database?.close();
  database = undefined;
  statement = undefined;
  activePath = undefined;
  stopped = false;
  warned.clear();
  queue.length = 0;
}
