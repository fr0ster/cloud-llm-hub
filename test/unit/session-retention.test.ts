import {
  isRefusal,
  type Lease,
  type LeaseRefusal,
  SessionRetention,
} from '../../srv/lib/session-retention';

function fakeStores() {
  const held = new Set<string>();
  const log: string[] = [];
  return {
    held,
    log,
    put: (u: string, s: string) => held.add(`${u}/${s}`),
    stores: {
      hasState: (u: string, s: string) => held.has(`${u}/${s}`),
      deleteAll: (u: string, s: string) => {
        log.push(`delete ${u}/${s}`);
        held.delete(`${u}/${s}`);
      },
    },
  };
}

function lease(x: Lease | LeaseRefusal): Lease {
  if (isRefusal(x)) throw new Error(`refused: ${x.refused}`);
  return x;
}

function clock() {
  let t = 0;
  return { now: () => t, tick: (ms = 1) => (t += ms) };
}

describe('places', () => {
  it('keeps two users apart when their parts could be read two ways', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 5);
    lease(r.lease('a', 'b c', 'pipeline'));
    expect(r.isKnown('a b', 'c')).toBe(false);
    expect(r.lease('a b', 'c', 'pipeline')).not.toEqual({ refused: 'closed' });
    expect(r.snapshot().retained).toBe(2);
  });

  it('counts a session once however many leases it holds', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 3);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline'));
    lease(r.lease('alice', 'A', 'rag'));
    expect(r.snapshot().retained).toBe(1);
  });

  it('evicts the least recently used idle session to make room, all of it', () => {
    const f = fakeStores();
    const c = clock();
    const r = new SessionRetention(f.stores, 2, c.now);
    for (const s of ['A', 'B']) {
      f.put('alice', s);
      lease(r.lease('alice', s, 'rag')).release();
      c.tick();
    }
    // A is older. C needs a place.
    const l = lease(r.lease('alice', 'C', 'rag'));
    expect(f.log).toEqual(['delete alice/A']);
    expect(r.isKnown('alice', 'A')).toBe(false);
    expect(r.snapshot()).toMatchObject({ retained: 2, evictions: 1 });
    l.release();
  });

  it('never evicts a session holding a pipeline lease', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 1);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline'));
    expect(r.canReserve('bob', 'B')).toBe(false);
    expect(r.lease('bob', 'B', 'pipeline')).toEqual({ refused: 'retention' });
    expect(f.log).toEqual([]);
  });

  it('never evicts a session in the middle of a RAG operation, slot or no slot', () => {
    // The test the slot-only rule passed while being wrong: the upload holds no
    // slot, and it is the least recently used.
    const f = fakeStores();
    const c = clock();
    const r = new SessionRetention(f.stores, 2, c.now);
    f.put('alice', 'A');
    const upload = lease(r.lease('alice', 'A', 'rag'));
    c.tick();
    f.put('alice', 'B');
    lease(r.lease('alice', 'B', 'rag')).release();
    c.tick();
    // B is the only idle candidate, so B goes and A survives.
    lease(r.lease('alice', 'C', 'rag'));
    expect(f.log).toEqual(['delete alice/B']);
    expect(r.isKnown('alice', 'A')).toBe(true);
    upload.release();
  });

  it('a cap filled entirely by live sessions evicts nothing', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('alice', 'A', 'pipeline'));
    lease(r.lease('bob', 'B', 'pipeline'));
    expect(r.lease('carol', 'C', 'pipeline')).toEqual({ refused: 'retention' });
    expect(f.log).toEqual([]);
  });

  it('is unbounded without a cap', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores);
    for (let i = 0; i < 50; i++) lease(r.lease('alice', `S${i}`, 'pipeline'));
    expect(r.snapshot().retained).toBe(50);
    expect(r.snapshot().cap).toBeUndefined();
  });

  it('lets a released session that holds nothing leave the count', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('agent', 'step-1', 'pipeline')).release();
    expect(r.snapshot().retained).toBe(0);
  });

  it('keeps a released session that still holds state', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline')).release();
    expect(r.isKnown('alice', 'A')).toBe(true);
  });
});

describe('closing, then deleting', () => {
  it('deletes at once when nothing holds the session', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'rag')).release();
    await r.close('alice', 'A');
    expect(f.log).toEqual(['delete alice/A']);
    expect(r.isKnown('alice', 'A')).toBe(false);
  });

  it('refuses new leases from the moment it is closed', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'pipeline'));
    void r.close('alice', 'A');
    expect(r.lease('alice', 'A', 'rag')).toEqual({ refused: 'closed' });
    expect(r.isClosing('alice', 'A')).toBe(true);
    held.release();
  });

  it('does not recreate a presented session removed since it was presented', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'rag')).release();
    await r.close('alice', 'A');
    // The request passed the middleware before the logout, and arrives after
    // the removal has run — when the mark is already gone.
    expect(r.lease('alice', 'A', 'pipeline', { presented: true })).toEqual({
      refused: 'closed',
    });
    expect(r.canReserve('alice', 'A', { presented: true })).toBe(false);
    expect(r.snapshot().retained).toBe(0);
  });

  it('treats a presented session held only in the stores as live', () => {
    // Collections loaded from disk after a restart: retention never saw them.
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    expect(r.isGone('alice', 'A')).toBe(false);
    lease(r.lease('alice', 'A', 'pipeline', { presented: true })).release();
  });

  it('cancels a RAG lease, and still waits for it to settle before deleting', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const upload = lease(r.lease('alice', 'A', 'rag'));
    const closed = r.close('alice', 'A');
    expect(upload.signal.aborted).toBe(true);
    // Cancelled is not finished: the upload is still writing.
    expect(f.log).toEqual([]);
    f.log.push('upload wrote its last document');
    upload.release();
    await closed;
    expect(f.log).toEqual(['upload wrote its last document', 'delete alice/A']);
  });

  it('does not cancel a pipeline, and deletes only after it ends', async () => {
    // A logout is a disconnect with a better name. Cutting an admitted pipeline
    // between create and activate leaves an ABAP object inactive and locked.
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const pipeline = lease(r.lease('alice', 'A', 'pipeline'));
    let settled = false;
    const closed = r.close('alice', 'A').then(() => {
      settled = true;
    });
    expect(pipeline.signal.aborted).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.log).toEqual([]);
    pipeline.release();
    await closed;
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('deletes once however many times it is closed', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const held = lease(r.lease('alice', 'A', 'rag'));
    const first = r.close('alice', 'A');
    const second = r.close('alice', 'A');
    held.release();
    await Promise.all([first, second]);
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('removes state for a session retention never saw', async () => {
    // After a restart, or with no lease ever taken: the stores may still hold
    // it, and a logout must still take it away.
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    await r.close('alice', 'A');
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('is not a tombstone: the entry is gone once removal has run', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('alice', 'A', 'rag')).release();
    await r.close('alice', 'A');
    expect(r.isClosing('alice', 'A')).toBe(false);
    expect(r.snapshot().closing).toBe(0);
  });

  it('counts a closed session whose cleanup is still waiting', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'pipeline'));
    void r.close('alice', 'A');
    // Its bytes are still there, so it still takes a place.
    expect(r.snapshot()).toMatchObject({ retained: 1, closing: 1 });
    held.release();
  });

  it('a lease releasing twice settles once', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const a = lease(r.lease('alice', 'A', 'rag'));
    const b = lease(r.lease('alice', 'A', 'rag'));
    const closed = r.close('alice', 'A');
    a.release();
    a.release();
    expect(f.log).toEqual([]);
    b.release();
    await closed;
    expect(f.log).toEqual(['delete alice/A']);
  });
});

describe('the sweep asks first', () => {
  it('may not sweep a leased or closing session, and may once it settles', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'rag'));
    expect(r.maySweep('alice', 'A')).toBe(false);
    held.release();
    expect(r.maySweep('alice', 'A')).toBe(true);
    expect(r.maySweep('nobody', 'N')).toBe(true);
  });

  it('forgets entries that hold nothing and have no lease', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 3);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'rag')).release();
    const held = lease(r.lease('bob', 'B', 'rag'));
    // A's history expired on its own thirty-minute clock.
    f.held.delete('alice/A');
    expect(r.forgetEmpty()).toBe(1);
    expect(r.isKnown('alice', 'A')).toBe(false);
    expect(r.isKnown('bob', 'B')).toBe(true);
    held.release();
  });
});
