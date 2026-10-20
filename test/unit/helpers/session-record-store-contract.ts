/**
 * The contract every SessionRecordStore keeps, run against each backend
 * (SQLite in session-record-store.test.ts, PG in session-record-store.pg.test.ts).
 */
import type {
  SessionRecord,
  SessionRecordStore,
} from '../../../srv/lib/session-record-store';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');

export function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    userId: 'alice@example.com',
    key: 'ls-11111111-1111-4111-8111-111111111111',
    createdAt: T0,
    lastActivity: T0,
    ttlMs: 3_600_000,
    ...over,
  };
}

/** `make` returns an empty store for each test. */
export function sessionRecordStoreContract(
  make: () => Promise<SessionRecordStore>,
): void {
  let store: SessionRecordStore;
  beforeEach(async () => {
    store = await make();
  });

  it('put then get round-trips', async () => {
    const r = record({ destination: 'S4H' });
    await store.put(r);
    expect(await store.get(r.userId, r.key)).toEqual(r);
  });

  it('get for another user → undefined', async () => {
    const r = record();
    await store.put(r);
    expect(await store.get('bob@example.com', r.key)).toBeUndefined();
  });

  it('delete removes it; list returns the rest', async () => {
    const a = record();
    const b = record({ key: 'ls-22222222-2222-4222-8222-222222222222' });
    const c = record({
      userId: 'bob@example.com',
      key: 'ls-33333333-3333-4333-8333-333333333333',
      destination: 'BTP',
    });
    await store.put(a);
    await store.put(b);
    await store.put(c);
    await store.delete(a.userId, a.key);
    expect(await store.get(a.userId, a.key)).toBeUndefined();
    const listed = await store.list();
    expect(listed.sort((x, y) => x.key.localeCompare(y.key))).toEqual([b, c]);
  });

  it('delete by another user leaves the record', async () => {
    const r = record();
    await store.put(r);
    await store.delete('bob@example.com', r.key);
    expect(await store.get(r.userId, r.key)).toEqual(r);
  });

  it('touch writes the record at most once a minute', async () => {
    const r = record();
    await store.put(r);
    const write = jest.spyOn(store, 'put');
    await store.touch({ ...r, lastActivity: T0 + 10_000 });
    await store.touch({ ...r, lastActivity: T0 + 50_000 });
    expect(write).not.toHaveBeenCalled();
    expect((await store.get(r.userId, r.key))?.lastActivity).toBe(T0);
    await store.touch({ ...r, lastActivity: T0 + 61_000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await store.get(r.userId, r.key))?.lastActivity).toBe(T0 + 61_000);
    write.mockRestore();
  });
}
