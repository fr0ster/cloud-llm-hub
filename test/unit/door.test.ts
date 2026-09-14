import { type Admission, type AdmitResult, Door } from '../../srv/lib/door';

function fakeRetention() {
  const r = {
    open: true,
    gone: false,
    leases: 0,
    canReserve: (_u: string, _s: string) => r.open,
    isGone: (_u: string, _s: string) => r.gone,
    lease: (_u: string, _s: string, kind: 'pipeline') => {
      if (!r.open) return { refused: 'retention' as const };
      r.leases++;
      let done = false;
      return {
        kind,
        signal: new AbortController().signal,
        release: () => {
          if (done) return;
          done = true;
          r.leases--;
        },
      };
    },
  };
  return r;
}

function door(
  capacity: number,
  queueLength = capacity,
  retention = fakeRetention(),
) {
  const pressure: number[] = [];
  const d = new Door({
    capacity,
    queueLength,
    retention,
    onPressure: (depth) => pressure.push(depth),
  });
  return { d, retention, pressure };
}

function admitted(r: AdmitResult): Admission {
  if (!('admitted' in r)) {
    if ('closed' in r) throw new Error('closed');
    throw new Error(`refused: ${r.refused}`);
  }
  return r.admitted;
}

const tick = () => new Promise((r) => setImmediate(r));

/** Start an admission without awaiting it; report when it lands. */
function pending(d: Door, u: string, s: string, signal?: AbortSignal) {
  const state: { result?: AdmitResult; error?: unknown } = {};
  const p = d.admit(u, s, signal).then(
    (r) => {
      state.result = r;
      return r;
    },
    (e) => {
      state.error = e;
      throw e;
    },
  );
  p.catch(() => {});
  return { p, state };
}

describe('capacity and the queue', () => {
  it('a capacity of one admits one', async () => {
    const { d } = door(1);
    admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    await tick();
    expect(b.state.result).toBeUndefined();
    expect(d.snapshot()).toMatchObject({ live: 1, queued: 1 });
  });

  it('holds the limit under pressure', async () => {
    const { d } = door(5, 20);
    const all = Array.from({ length: 20 }, (_, i) => pending(d, 'u', `S${i}`));
    await tick();
    expect(d.snapshot()).toMatchObject({ live: 5, queued: 15 });
    expect(all.filter((x) => x.state.result).length).toBe(5);
  });

  it('absorbs and then refuses', async () => {
    const { d } = door(5, 5);
    for (let i = 0; i < 10; i++) void pending(d, 'u', `S${i}`);
    await tick();
    expect(await d.admit('u', 'S10')).toEqual({ refused: 'capacity' });
    expect(d.snapshot().refusals.capacity).toBe(1);
  });

  it('reports three quarters before anyone is refused', async () => {
    const { d, pressure } = door(1, 4);
    for (let i = 0; i < 5; i++) void pending(d, 'u', `S${i}`);
    await tick();
    expect(pressure).toEqual([3]);
    expect(d.snapshot().highWater).toBe(4);
    expect(await d.admit('u', 'S5')).toEqual({ refused: 'capacity' });
  });
});

describe('order', () => {
  it('is first in, first out under contention', async () => {
    const { d } = door(1, 3);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    const c = pending(d, 'u', 'C');
    const e = pending(d, 'u', 'E');
    a.release();
    await tick();
    expect(b.state.result).toBeDefined();
    expect(c.state.result).toBeUndefined();
    admitted(b.state.result!).release();
    await tick();
    expect(c.state.result).toBeDefined();
    expect(e.state.result).toBeUndefined();
  });

  it('has no lost wake-up: a release always dispatches', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    a.release();
    await expect(b.p).resolves.toHaveProperty('admitted');
  });
});

describe('one session, one pipeline', () => {
  it('a second request for a live session waits, with slots to spare', async () => {
    // Written with capacity free: a test that fills the door first would pass
    // on the queue alone and prove nothing about the key.
    const { d } = door(5);
    admitted(await d.admit('alice', 'A'));
    const again = pending(d, 'alice', 'A');
    await tick();
    expect(again.state.result).toBeUndefined();
    expect(d.snapshot().live).toBe(1);
  });

  it('does not mistake one user for another when the parts could be read two ways', async () => {
    // With a join, ("a b", "c") would be the same key as ("a", "b c"): it would
    // wait on a session that is not its own, and its release would free the
    // other user's admission.
    const { d } = door(5);
    const first = admitted(await d.admit('a', 'b c'));
    const second = admitted(await d.admit('a b', 'c'));
    expect(d.snapshot().live).toBe(2);
    second.release();
    expect(d.snapshot().live).toBe(1);
    first.release();
  });

  it('two users cannot collide, whatever id they send', async () => {
    const { d } = door(5);
    admitted(await d.admit('alice', 'A'));
    admitted(await d.admit('bob', 'A'));
    expect(d.snapshot().live).toBe(2);
  });

  it('a caller colliding with itself is serialised, and both complete', async () => {
    const { d } = door(5);
    const first = admitted(await d.admit('alice', 'A'));
    const second = pending(d, 'alice', 'A');
    first.release();
    await expect(second.p).resolves.toHaveProperty('admitted');
  });

  it('a repeated session id cannot build a backlog', async () => {
    const { d } = door(5, 10);
    admitted(await d.admit('alice', 'A'));
    for (let i = 0; i < 10; i++) void pending(d, 'alice', 'A');
    await tick();
    expect(await d.admit('alice', 'A')).toEqual({ refused: 'session_busy' });
  });

  it('a blocked waiter does not hold the queue, and is not starved', async () => {
    const { d } = door(2, 5);
    const a = admitted(await d.admit('u', 'A'));
    const c = admitted(await d.admit('u', 'C'));
    const a2 = pending(d, 'u', 'A');
    const b = pending(d, 'u', 'B');
    c.release();
    await tick();
    // B is served while A is still busy, rather than the slot sitting empty.
    expect(b.state.result).toBeDefined();
    expect(a2.state.result).toBeUndefined();
    const later = pending(d, 'u', 'D');
    a.release();
    await tick();
    // A's waiter goes before anyone who arrived after it.
    expect(a2.state.result).toBeDefined();
    expect(later.state.result).toBeUndefined();
  });
});

describe('retention is part of admission', () => {
  it('a free slot with no retention place admits nobody, until a place frees', async () => {
    const { d, retention } = door(3);
    retention.open = false;
    const w = pending(d, 'u', 'A');
    await tick();
    expect(w.state.result).toBeUndefined();
    expect(retention.leases).toBe(0);
    retention.open = true;
    d.poke();
    await expect(w.p).resolves.toHaveProperty('admitted');
    expect(retention.leases).toBe(1);
  });

  it('a full queue refuses with every slot free, and says retention', async () => {
    const { d, retention } = door(3, 2);
    retention.open = false;
    void pending(d, 'u', 'A');
    void pending(d, 'u', 'B');
    await tick();
    expect(await d.admit('u', 'C')).toEqual({ refused: 'retention' });
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 2 });
  });

  it('checks the session before capacity, and capacity before retention', async () => {
    const { d, retention } = door(1, 1);
    admitted(await d.admit('alice', 'A'));
    void pending(d, 'bob', 'B');
    await tick();
    retention.open = false;
    expect(await d.admit('alice', 'A')).toEqual({ refused: 'session_busy' });
    expect(await d.admit('carol', 'C')).toEqual({ refused: 'capacity' });
  });

  it('releasing gives the place back as well as the slot', async () => {
    const { d, retention } = door(2);
    const a = admitted(await d.admit('u', 'A'));
    a.release();
    a.release();
    expect(retention.leases).toBe(0);
    expect(d.snapshot().live).toBe(0);
  });
});

describe('a session closed under a request', () => {
  it('is answered closed on arrival, and takes nothing', async () => {
    const { d, retention } = door(2);
    retention.gone = true;
    expect(await d.admit('u', 'A', undefined, { presented: true })).toEqual({
      closed: true,
    });
    expect(retention.leases).toBe(0);
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 0 });
  });

  it('is answered closed if the session goes while it waits, never admitted', async () => {
    const { d, retention } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const late = d.admit('u', 'B', undefined, { presented: true });
    await tick();
    retention.gone = true;
    a.release();
    expect(await late).toEqual({ closed: true });
    expect(retention.leases).toBe(0);
  });

  it('never asks about a session minted for this request', async () => {
    const { d, retention } = door(1);
    retention.gone = true;
    admitted(await d.admit('u', 'C'));
  });
});

describe('a waiter that leaves', () => {
  it('takes no slot and starts nothing', async () => {
    const { d, retention } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const controller = new AbortController();
    const b = pending(d, 'u', 'B', controller.signal);
    controller.abort(new Error('client gone'));
    await expect(b.p).rejects.toThrow('client gone');
    a.release();
    await tick();
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 0, left: 1 });
    expect(retention.leases).toBe(0);
  });
});

describe('the register', () => {
  it('drains only when every tracked call has settled, rejected ones included', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    let finish!: () => void;
    let fail!: (e: Error) => void;
    void a.track(new Promise<void>((r) => (finish = r)));
    a.track(new Promise<void>((_, j) => (fail = j))).catch(() => {});
    expect(a.outstanding).toBe(2);
    let drained = false;
    void a.drain().then(() => (drained = true));
    finish();
    await tick();
    expect(drained).toBe(false);
    fail(new Error('write failed'));
    await tick();
    expect(drained).toBe(true);
    expect(a.outstanding).toBe(0);
  });

  it('drains at once when nothing was tracked', async () => {
    const { d } = door(1);
    await expect(
      admitted(await d.admit('u', 'A')).drain(),
    ).resolves.toBeUndefined();
  });
});

describe('shutdown', () => {
  it('aborts every admitted session and every waiter, and nothing else does', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    await tick();
    expect(a.signal.aborted).toBe(false);
    d.abortAll(new Error('shutdown'));
    expect(a.signal.aborted).toBe(true);
    await expect(b.p).rejects.toThrow('shutdown');
  });
});

describe('a retention that pokes the door from inside a lease', () => {
  it('admits every queued caller and releases nothing', async () => {
    const retention = fakeRetention();
    const d = new Door({
      capacity: 3,
      queueLength: 5,
      retention,
    });

    // Wrap retention.lease to poke the door synchronously
    const inner = retention.lease;
    retention.lease = (u: string, s: string, k: 'pipeline') => {
      const l = inner(u, s, k);
      d.poke();
      return l;
    };

    // Admit one at once (exercises admit's guard)
    const a = admitted(await d.admit('u', 'A'));
    expect(retention.leases).toBe(d.snapshot().live);
    expect(d.snapshot().live).toBe(1);
    expect(d.snapshot().queued).toBe(0);

    // Queue four more
    const b = pending(d, 'u', 'B');
    const c = pending(d, 'u', 'C');
    const e = pending(d, 'u', 'E');
    const f = pending(d, 'u', 'F');
    await tick();

    // A, B, C should be live (eligible), E, F queued (full capacity)
    expect(d.snapshot()).toMatchObject({
      live: 3,
      queued: 2,
    });
    expect(retention.leases).toBe(d.snapshot().live);
    const answeredBeforeRelease = [b, c, e].filter(
      (x) => x.state.result,
    ).length;
    expect(answeredBeforeRelease + d.snapshot().queued).toBe(4);

    // Release and let dispatch run
    a.release();
    await tick();

    // B, C still admitted; E should be admitted; F should still wait
    const b_adm = admitted(b.state.result!);
    const c_adm = admitted(c.state.result!);
    const e_adm = admitted(e.state.result!);
    expect(f.state.result).toBeUndefined(); // The fourth waits

    // Invariants the bug broke
    expect(retention.leases).toBe(d.snapshot().live);
    expect(d.snapshot().live).toBeLessThanOrEqual(3);
    // Each admission is for a different session
    const sessions = [b_adm, c_adm, e_adm].map((x) => x.sessionId);
    expect(new Set(sessions).size).toBe(3);
    expect(retention.leases).toBe(3);
    expect(d.snapshot().queued).toBe(1); // F still waiting

    // Release all, drain
    b_adm.release();
    c_adm.release();
    e_adm.release();
    await tick();
    const f_adm = admitted(f.state.result!);
    f_adm.release();
    await tick();

    // Everything released
    expect(retention.leases).toBe(0);
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 0 });
  });

  it('an arrival cannot be admitted twice when its lease pokes the queue', async () => {
    const retention = fakeRetention();
    const d = new Door({
      capacity: 2,
      queueLength: 5,
      retention,
    });

    // Wrap retention.lease to poke the door synchronously
    const inner = retention.lease;
    retention.lease = (u: string, s: string, k: 'pipeline') => {
      const l = inner(u, s, k);
      d.poke();
      return l;
    };

    // Close retention, queue B
    retention.open = false;
    const queued = pending(d, 'u', 'B');
    await tick();

    expect(queued.state.result).toBeUndefined(); // Not answered
    expect(d.snapshot().queued).toBe(1);
    expect(retention.leases).toBe(0); // Queued, no lease yet

    // Reopen retention without poking
    retention.open = true;

    // A second arrival for the same session B
    const arrival = pending(d, 'u', 'B');
    await tick();

    // Exactly one of them is answered, the other waits
    const queuedAnswered = queued.state.result !== undefined;
    const arrivalAnswered = arrival.state.result !== undefined;
    expect(
      Number(queuedAnswered) + Number(arrivalAnswered) + d.snapshot().queued,
    ).toBe(2);
    expect(queuedAnswered || arrivalAnswered).toBe(true);
    expect(queuedAnswered && arrivalAnswered).toBe(false); // Not both answered

    // Invariants: only one admission, one lease
    expect(d.snapshot().live).toBe(1);
    expect(retention.leases).toBe(1);

    // Get the admitted one
    const adm = queuedAnswered
      ? admitted(queued.state.result!)
      : admitted(arrival.state.result!);

    // Release that one admission
    adm.release();
    await tick();

    // The other is now admitted
    expect(
      queuedAnswered ? arrival.state.result : queued.state.result,
    ).toBeDefined();
    const otherAdm = queuedAnswered
      ? admitted(arrival.state.result!)
      : admitted(queued.state.result!);
    expect(d.snapshot()).toMatchObject({ live: 1, queued: 0 });
    expect(retention.leases).toBe(1);

    // Release it
    otherAdm.release();
    await tick();

    // Everything released
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 0 });
    expect(retention.leases).toBe(0);
  });
});
