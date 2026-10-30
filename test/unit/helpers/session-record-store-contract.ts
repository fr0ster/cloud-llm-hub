/**
 * The contract every SessionRecordStore keeps, run against each backend
 * (SQLite in session-record-store.test.ts, PG in session-record-store.pg.test.ts).
 */
import {
  type SessionRecord,
  SessionRecordOwnerError,
  type SessionRecordStore,
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

/** The backend's own write, under every put and touch. */
function spyOnWrite(store: SessionRecordStore) {
  return jest.spyOn(
    store as unknown as { writeRecord(r: SessionRecord): Promise<void> },
    'writeRecord',
  );
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

  it('persists selection and writes changes inside the touch throttle window', async () => {
    const r = record({ agentsCollectionId: 'agents' });
    await store.put(r);
    expect((await store.get(r.userId, r.key))?.agentsCollectionId).toBe(
      'agents',
    );
    await store.touch({
      ...r,
      agentsCollectionId: 'own-copy',
      lastActivity: T0 + 1,
    });
    expect((await store.get(r.userId, r.key))?.agentsCollectionId).toBe(
      'own-copy',
    );
  });

  it('round-trips a closed marker', async () => {
    const r = { ...record(), closedAt: T0 + 1 };
    await store.put(r);
    expect(await store.get(r.userId, r.key)).toEqual(r);
  });

  it('writes a destination change within the touch window', async () => {
    const r = record({ destination: 'A' });
    await store.put(r);
    const write = spyOnWrite(store);
    await store.touch({ ...r, destination: 'B', lastActivity: T0 + 1000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await store.get(r.userId, r.key))?.destination).toBe('B');
    await store.touch({ ...r, destination: 'B', lastActivity: T0 + 2000 });
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
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
    const write = spyOnWrite(store);
    await store.touch({ ...r, lastActivity: T0 + 10_000 });
    await store.touch({ ...r, lastActivity: T0 + 50_000 });
    expect(write).not.toHaveBeenCalled();
    expect((await store.get(r.userId, r.key))?.lastActivity).toBe(T0);
    await store.touch({ ...r, lastActivity: T0 + 61_000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await store.get(r.userId, r.key))?.lastActivity).toBe(T0 + 61_000);
    write.mockRestore();
  });

  it("put never replaces another user's record of the same key", async () => {
    const r = record();
    await store.put(r);
    await expect(
      store.put({ ...r, userId: 'bob@example.com', lastActivity: T0 + 1 }),
    ).rejects.toBeInstanceOf(SessionRecordOwnerError);
    expect(await store.get(r.userId, r.key)).toEqual(r);
    expect(await store.get('bob@example.com', r.key)).toBeUndefined();
    expect(await store.list()).toEqual([r]);
  });

  it('overlapping touches write once, and never an older lastActivity', async () => {
    const r = record();
    await store.put(r);
    const write = spyOnWrite(store);
    const original = Object.getPrototypeOf(store).writeRecord as (
      r: SessionRecord,
    ) => Promise<void>;
    // The first write is the slow one: unserialised, the older one lands last.
    const delays = [50, 0];
    write.mockImplementation(async (x: SessionRecord) => {
      await new Promise((res) => setTimeout(res, delays.shift() ?? 0));
      return original.call(store, x);
    });
    await Promise.all([
      store.touch({ ...r, lastActivity: T0 + 120_000 }),
      store.touch({ ...r, lastActivity: T0 + 61_000 }),
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await store.get(r.userId, r.key))?.lastActivity).toBe(T0 + 120_000);
    write.mockRestore();
  });
}
