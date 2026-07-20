import {
  InMemoryLruDumpBuffer,
  makeDefaultDumpBuffer,
} from '../../srv/lib/dump-buffer';

const key = (overrides: Partial<Record<string, string>> = {}) => ({
  principalHash: 'alice-hash',
  resolvedDestination: 'S4HANA_DEV',
  effectiveClient: '100',
  dumpId: 'dump-1',
  ...overrides,
});

describe('InMemoryLruDumpBuffer', () => {
  it('round-trips set/get', () => {
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 4,
      maxBytes: 1_000,
      ttlMs: 60_000,
    });
    const value = {
      index: ['Error analysis', 'Call stack'],
      raw: 'dump payload',
    };
    store.set(key(), value);
    expect(store.get(key())).toEqual(value);
  });

  it('returns undefined for a missing key', () => {
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 4,
      maxBytes: 1_000,
      ttlMs: 60_000,
    });
    expect(store.get(key())).toBeUndefined();
  });

  it('isolates entries by principalHash', () => {
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 4,
      maxBytes: 1_000,
      ttlMs: 60_000,
    });
    const value = { index: ['Error analysis'], raw: 'alice dump' };
    store.set(key({ principalHash: 'alice-hash' }), value);

    expect(store.get(key({ principalHash: 'bob-hash' }))).toBeUndefined();
    expect(store.get(key({ principalHash: 'alice-hash' }))).toEqual(value);
  });

  it('evicts the least-recently-used entry past maxEntries', () => {
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 2,
      maxBytes: 1_000_000,
      ttlMs: 60_000,
    });
    store.set(key({ dumpId: 'd1' }), { index: [], raw: 'a' });
    store.set(key({ dumpId: 'd2' }), { index: [], raw: 'b' });
    // touch d1 so it becomes most-recently-used, making d2 the LRU victim
    store.get(key({ dumpId: 'd1' }));
    store.set(key({ dumpId: 'd3' }), { index: [], raw: 'c' });

    expect(store.get(key({ dumpId: 'd1' }))).toEqual({ index: [], raw: 'a' });
    expect(store.get(key({ dumpId: 'd2' }))).toBeUndefined();
    expect(store.get(key({ dumpId: 'd3' }))).toEqual({ index: [], raw: 'c' });
  });

  it('evicts oldest entries past maxBytes', () => {
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 100,
      maxBytes: 16,
      ttlMs: 60_000,
    });
    store.set(key({ dumpId: 'd1' }), { index: [], raw: '1234567890' }); // 10 bytes
    store.set(key({ dumpId: 'd2' }), { index: [], raw: '12345' }); // 5 bytes, total 15 -> ok
    expect(store.get(key({ dumpId: 'd1' }))).toBeDefined();
    expect(store.get(key({ dumpId: 'd2' }))).toBeDefined();

    // touching d1 makes it MRU, so adding d3 must evict d2 (now LRU) first
    store.get(key({ dumpId: 'd1' }));
    store.set(key({ dumpId: 'd3' }), { index: [], raw: '123456' }); // 6 bytes, total would be 21 > 16, evicting d2 (5) brings it to 16

    expect(store.get(key({ dumpId: 'd2' }))).toBeUndefined();
    expect(store.get(key({ dumpId: 'd1' }))).toBeDefined();
    expect(store.get(key({ dumpId: 'd3' }))).toBeDefined();
  });

  it('expires entries past ttlMs using the injected clock', () => {
    let now = 1_000_000;
    const store = new InMemoryLruDumpBuffer({
      maxEntries: 4,
      maxBytes: 1_000,
      ttlMs: 1_000,
      now: () => now,
    });
    store.set(key(), { index: [], raw: 'x' });
    now += 999;
    expect(store.get(key())).toBeDefined();
    now += 2;
    expect(store.get(key())).toBeUndefined();
  });
});

describe('makeDefaultDumpBuffer', () => {
  it('applies defaults when env vars are absent', () => {
    const store = makeDefaultDumpBuffer({});
    const value = { index: [], raw: 'payload' };
    store.set(key(), value);
    expect(store.get(key())).toEqual(value);
  });

  it('reads overrides from the provided env object', () => {
    const store = makeDefaultDumpBuffer({
      LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES: '1',
      LLM_AGENT_DUMP_BUFFER_MAX_BYTES: '1000',
      LLM_AGENT_DUMP_BUFFER_TTL_MS: '600000',
    });
    store.set(key({ dumpId: 'd1' }), { index: [], raw: 'a' });
    store.set(key({ dumpId: 'd2' }), { index: [], raw: 'b' });

    expect(store.get(key({ dumpId: 'd1' }))).toBeUndefined();
    expect(store.get(key({ dumpId: 'd2' }))).toBeDefined();
  });

  it('falls back to safe defaults on malformed env (never disables the cap)', () => {
    // 'abc' → NaN, '' → 0, '-5' → negative: a raw Number() would leave the
    // bound NaN/0 and DISABLE eviction (OOM). It must fall back to the default
    // maxEntries=32, so the 33rd insert still evicts the oldest.
    const store = makeDefaultDumpBuffer({
      LLM_AGENT_DUMP_BUFFER_MAX_ENTRIES: 'abc',
      LLM_AGENT_DUMP_BUFFER_MAX_BYTES: '',
      LLM_AGENT_DUMP_BUFFER_TTL_MS: '-5',
    });
    for (let i = 0; i < 33; i++) {
      store.set(key({ dumpId: `d${i}` }), { index: [], raw: 'x' });
    }
    expect(store.get(key({ dumpId: 'd0' }))).toBeUndefined(); // oldest evicted
    expect(store.get(key({ dumpId: 'd32' }))).toBeDefined(); // newest kept
  });
});
