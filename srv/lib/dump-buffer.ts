export interface DumpBufferKey {
  principalHash: string;
  resolvedDestination: string;
  effectiveClient: string;
  dumpId: string;
}

export interface DumpBufferValue {
  index: string[];
  raw: string;
}

export interface DumpBufferStore {
  get(key: DumpBufferKey): DumpBufferValue | undefined;
  set(key: DumpBufferKey, value: DumpBufferValue): void;
}

interface DumpBufferOptions {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
}

interface DumpBufferEntry {
  value: DumpBufferValue;
  bytes: number;
  expiresAt: number;
}

function toKey(key: DumpBufferKey): string {
  return JSON.stringify([
    key.principalHash,
    key.resolvedDestination,
    key.effectiveClient,
    key.dumpId,
  ]);
}

export class InMemoryLruDumpBuffer implements DumpBufferStore {
  private readonly entries = new Map<string, DumpBufferEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DumpBufferOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: DumpBufferKey): DumpBufferValue | undefined {
    const mapKey = toKey(key);
    const entry = this.entries.get(mapKey);
    if (!entry) return undefined;

    if (this.now() >= entry.expiresAt) {
      this.entries.delete(mapKey);
      return undefined;
    }

    // Refresh recency: re-insert at the end (most-recently-used).
    this.entries.delete(mapKey);
    this.entries.set(mapKey, entry);
    return entry.value;
  }

  set(key: DumpBufferKey, value: DumpBufferValue): void {
    const mapKey = toKey(key);
    const entry: DumpBufferEntry = {
      value,
      bytes: value.raw.length,
      expiresAt: this.now() + this.ttlMs,
    };

    this.entries.delete(mapKey);
    this.entries.set(mapKey, entry);

    this.evict();
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  private evict(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes() > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * Parse a strictly-positive integer env value; anything else (unset, empty,
 * non-numeric, zero, negative, non-integer) → `def`. A raw `Number('abc')` is
 * NaN and a bare `?? def` does NOT catch it — a malformed value would then make
 * `maxBytes`/`maxEntries` NaN (every `> NaN` comparison false → eviction never
 * fires) or `ttlMs` NaN (entries never expire), silently defeating the hard
 * cap this buffer exists to enforce.
 */
function positiveIntEnv(value: string | undefined, def: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function makeDefaultDumpBuffer(
  env: Record<string, string | undefined> = process.env,
): DumpBufferStore {
  const maxEntries = positiveIntEnv(env.LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES, 32);
  const maxBytes = positiveIntEnv(
    env.LLM_AGENT_DUMP_BUFFER_MAX_BYTES,
    64_000_000,
  );
  const ttlMs = positiveIntEnv(env.LLM_AGENT_DUMP_BUFFER_TTL_MS, 600_000);

  return new InMemoryLruDumpBuffer({ maxEntries, maxBytes, ttlMs });
}
