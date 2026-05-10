// True-LRU cache backed by Map.
//
// - get() promotes the hit entry to most-recent.
// - set() at capacity evicts the least-recently-used key.
// - get() returns undefined for both "miss" and "stored undefined";
//   use has() to disambiguate when V can include undefined.
//
// Implementation: Map preserves insertion order; cache hits delete +
// reinsert to bump the entry to most-recent. Eviction past capacity
// drops the oldest key. No npm dependency.
export class LruCache<K, V> {
  private readonly store = new Map<K, V>();
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('LruCache capacity must be > 0');
  }
  get size(): number {
    return this.store.size;
  }
  has(key: K): boolean {
    return this.store.has(key);
  }
  get(key: K): V | undefined {
    if (!this.store.has(key)) return undefined;
    const v = this.store.get(key);
    this.store.delete(key);
    this.store.set(key, v as V);
    return v;
  }
  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.capacity) {
      const { value: oldest, done } = this.store.keys().next();
      if (!done) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }
}
