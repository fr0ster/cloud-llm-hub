import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const DEFAULT_READ_LIMIT = 32000;

export function readPage(
  id: string,
  text: string,
  offset = 0,
  limit = DEFAULT_READ_LIMIT,
) {
  const end = Math.min(text.length, offset + limit);
  return {
    id,
    offset,
    total: text.length,
    ...(end < text.length ? { next: end } : {}),
    text: text.slice(offset, end),
  };
}

/** Loop bookkeeping only: retain hashes and original rounds, never record text. */
export class ReadDedup {
  private round = 0;
  private readonly reads = new Map<string | object, Map<string, number>>();
  constructor(private readonly window: number) {}
  advance(): void {
    this.round++;
    for (const pages of this.reads.values()) {
      for (const [key, round] of pages) {
        if (this.round - round >= this.window) pages.delete(key);
      }
    }
  }
  read(
    trace: string | object,
    collection: string,
    id: string,
    text: string,
    offset = 0,
    limit = DEFAULT_READ_LIMIT,
  ) {
    let pages = this.reads.get(trace);
    if (!pages) {
      pages = new Map();
      this.reads.set(trace, pages);
    }
    const hash = createHash('sha256').update(text).digest('hex');
    const key = JSON.stringify([collection, id, offset, limit, hash]);
    const original = pages.get(key);
    const end = Math.min(text.length, offset + limit);
    if (original !== undefined && this.round - original < this.window) {
      return {
        id,
        offset,
        total: text.length,
        alreadyRead: true as const,
        note: `already read above in this task: ${id} offset ${offset}–${end}`,
      };
    }
    pages.set(key, this.round + 1);
    return readPage(id, text, offset, limit);
  }
}

// The library invokes the factory synchronously inside each async tool loop.
// Its async continuation inherits this scope; concurrent loops get separate state.
export const loopReads = new AsyncLocalStorage<ReadDedup>();

export function readLoopPage(
  trace: string | undefined,
  collection: string,
  id: string,
  text: string,
  offset?: number,
  limit?: number,
) {
  const reads = loopReads.getStore();
  return trace && reads
    ? reads.read(trace, collection, id, text, offset, limit)
    : readPage(id, text, offset, limit);
}
