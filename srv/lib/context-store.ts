import { Worker } from 'node:worker_threads';
import cds from '@sap/cds';
import { contextWorker } from './context-worker';

const secretKey =
  /^(?:password|passwd|pwd|.*secret.*|.*token.*|authorization|(?:set-)?cookie|api[_-]?key|private[_-]?key|sap-password|x-sap-.*)$/i;
const textCredential = new RegExp(
  `(?<![\\w-])(["']?)(${secretKey.source.slice(1, -1).replaceAll('.*', '[\\w-]*')})\\1(\\s*[=:]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Basic|Bearer)\\s+[^\\s&;,}]+|[^\\s&;,}]+)`,
  'gi',
);
const usageKey =
  /^(?:tokens|(?:input|output|total|cached|prompt|completion|reasoning|cache_read_input|cache_creation_input|max)[_-]?tokens)$/i;
const replacement = '\u00abredacted\u00bb';
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactContext(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) && !(usageKey.test(key) && typeof item === 'number')
          ? replacement
          : redactValue(item),
      ]),
    );
  return value;
}

export function redactContext(value: string): string {
  try {
    const parsed: JsonValue = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object')
      return JSON.stringify(redactValue(parsed));
  } catch {
    /* Plain text. */
  }
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      replacement,
    )
    .replace(
      /\b((?:Set-)?Cookie)(:\s*)([^\r\n]+)/gi,
      (_match, key: string, separator: string, item: string) =>
        `${key}${separator}${item.replace(/([^\s;,=]+)(\s*=\s*)("[^"\r\n]*"|[^;,\r\n]*)/g, `$1$2${replacement}`)}`,
    )
    .replace(
      /^([\w-]+)(:[ \t]*)([^\r\n]+)$/gm,
      (match, key: string, separator: string, item: string) =>
        secretKey.test(key) &&
        !/^(?:set-)?cookie$/i.test(key) &&
        !(
          usageKey.test(key) &&
          /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(item.trim())
        )
          ? `${key}${separator}${replacement}`
          : match,
    )
    .replace(
      textCredential,
      (match, quote: string, key: string, separator: string, item: string) => {
        if (
          !quote &&
          /^(?:set-)?cookie$/i.test(key) &&
          separator.includes(':') &&
          item.includes('=')
        )
          return match;
        if (!secretKey.test(key)) return match;
        if (
          usageKey.test(key) &&
          /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(item.trim())
        )
          return match;
        return `${quote}${key}${quote}${separator}${replacement}`;
      },
    )
    .replace(/\b(Basic|Bearer)(\s+)[^\s"'&,;}]+/gi, `$1$2${replacement}`);
}

export function contextJson(value: object): string {
  const serialized: JsonValue = JSON.parse(JSON.stringify(value));
  return JSON.stringify(redactValue(serialized));
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

// At most 64 serialized rows, including the single row in flight to the worker.
export const CONTEXT_QUEUE_LIMIT = 64;
const queue: string[] = [];
let worker: Worker | undefined;
let disabled = false;
let busy = false;
let overflow = false;
let dropped = 0;
const waiters: Array<() => void> = [];

export function contextStoreStatus(): {
  pending: number;
  dropped: number;
  active: boolean;
  disabled: boolean;
} {
  return {
    pending: queue.length,
    dropped,
    active: worker !== undefined,
    disabled,
  };
}
function settled(): void {
  if (queue.length) return;
  worker?.unref();
  for (const resolve of waiters.splice(0)) resolve();
}
function failWorker(): void {
  disabled = true;
  busy = false;
  queue.length = 0;
  warnContext('WORKER_FAILED');
  const failed = worker;
  worker = undefined;
  void failed?.terminate();
  settled();
}
function dispatch(): void {
  if (busy || !queue.length || !worker) return;
  busy = true;
  worker.ref();
  try {
    worker.postMessage(queue[0]);
  } catch {
    failWorker();
  }
}
export function appendContext(row: ContextRow): void {
  if (disabled) return;
  if (queue.length >= CONTEXT_QUEUE_LIMIT) {
    dropped++;
    if (!overflow) {
      overflow = true;
      try {
        cds
          .log('context-capture')
          .warn(
            'Context capture: QUEUE_FULL (dropping new rows; see contextStoreStatus().dropped)',
          );
      } catch {}
    }
    return;
  }
  try {
    if (!worker) {
      const created = new Worker(`(${contextWorker.toString()})()`, {
        eval: true,
      });
      worker = created;
      created.on(
        'message',
        (message: { warning?: string; dropped?: boolean }) => {
          if (worker !== created) return;
          if (message.warning) warnContext(message.warning);
          if (message.dropped) dropped++;
          queue.shift();
          busy = false;
          overflow = false;
          dispatch();
          settled();
        },
      );
      created.on('error', () => {
        if (worker === created) failWorker();
      });
      created.on('exit', () => {
        if (worker === created) failWorker();
      });
    }
    queue.push(
      JSON.stringify({
        row,
        path:
          process.env.LLM_AGENT_CONTEXT_CAPTURE_FILE?.trim() ||
          'context.sqlite',
        maxMb: process.env.LLM_AGENT_CONTEXT_CAPTURE_MAX_MB || '512',
      }),
    );
    dispatch();
  } catch {
    failWorker();
  }
}
export function drainContext(): Promise<void> {
  if (!queue.length) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}
/** Resolves once the previous worker has exited and released the file. */
export async function resetContextStore(): Promise<void> {
  const previous = worker;
  worker = undefined;
  disabled = false;
  busy = false;
  overflow = false;
  dropped = 0;
  warned.clear();
  queue.length = 0;
  settled();
  await previous?.terminate();
}
// Pending writes keep the worker referenced. On natural shutdown, close its port
// and SQLite connection before allowing exit. Forced exit remains best effort.
process.once('beforeExit', () => {
  const closing = worker;
  if (!closing) return;
  worker = undefined;
  disabled = true;
  closing.ref();
  try {
    closing.postMessage(null);
  } catch {
    void closing.terminate();
  }
});
process.once('exit', () => {
  void worker?.terminate();
});
