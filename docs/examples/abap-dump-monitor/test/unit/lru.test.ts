import { LruCache } from '../../srv/lru';

describe('LruCache', () => {
  test('get returns undefined for missing keys', () => {
    const c = new LruCache<string, number>(3);
    expect(c.get('x')).toBeUndefined();
  });

  test('set + get round-trip', () => {
    const c = new LruCache<string, number>(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });

  test('evicts the least-recently-used entry past capacity', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // 'a' is now evicted
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  test('get promotes the entry to most-recent (true LRU)', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // bumps 'a' → 'b' is now LRU
    c.set('c', 3); // should evict 'b', not 'a'
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  test('size reflects current count', () => {
    const c = new LruCache<string, number>(2);
    expect(c.size).toBe(0);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.size).toBe(2);
  });

  test('re-setting an existing key at capacity does not evict and updates the value', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 9); // re-set on existing key — must not evict 'b'
    expect(c.get('a')).toBe(9);
    expect(c.get('b')).toBe(2);
    expect(c.size).toBe(2);
  });

  test('constructor throws on non-positive capacity', () => {
    expect(() => new LruCache<string, number>(0)).toThrow(
      /capacity must be > 0/,
    );
    expect(() => new LruCache<string, number>(-1)).toThrow(
      /capacity must be > 0/,
    );
  });

  test('has() distinguishes a stored undefined value from a miss', () => {
    const c = new LruCache<string, number | undefined>(2);
    c.set('a', undefined);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBeUndefined(); // ambiguous on get alone
  });
});
