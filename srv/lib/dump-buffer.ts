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

export function makeDefaultDumpBuffer(
  env: Record<string, string | undefined> = process.env,
): DumpBufferStore {
  const maxEntries = Number(env.LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES ?? 32);
  const maxBytes = Number(env.LLM_AGENT_DUMP_BUFFER_MAX_BYTES ?? 64_000_000);
  const ttlMs = Number(env.LLM_AGENT_DUMP_BUFFER_TTL_MS ?? 600_000);

  return new InMemoryLruDumpBuffer({ maxEntries, maxBytes, ttlMs });
}
