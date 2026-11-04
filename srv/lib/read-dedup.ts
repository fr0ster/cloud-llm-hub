import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { parseToolResultMaxChars } from '../agent-config';
import { toolResultBudget } from './tool-result-cap';

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
  limit = DEFAULT_READ_LIMIT,
  serialize?: (page: ReturnType<typeof readPage>) => string | object,
) {
  // Measure the complete MCP content, including attributes and both JSON layers,
  // before dedup records delivery. A cap too small for progress must not consume a page.
  const cap = toolResultBudget.getStore() ?? parseToolResultMaxChars();
  if (cap && serialize) {
    const fits = (size: number) =>
      JSON.stringify(serialize(readPage(id, text, offset, size))).length <= cap;
    let low = 0;
    let high = Math.min(limit, Math.max(0, text.length - (offset ?? 0)));
    if (fits(high)) {
      low = high;
    } else {
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid)) low = mid;
        else high = mid - 1;
      }
      if (!fits(low)) return readPage(id, text, offset, limit);
    }
    if (low === 0 && (offset ?? 0) < text.length)
      return readPage(id, text, offset, limit);
    limit = low;
  }
  const reads = loopReads.getStore();
  return trace && reads
    ? reads.read(trace, collection, id, text, offset, limit)
    : readPage(id, text, offset, limit);
}
