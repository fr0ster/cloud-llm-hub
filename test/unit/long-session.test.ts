import cds from '@sap/cds';
import {
  type CloseReason,
  type LongSession,
  LongSessionRegistry,
  newSessionKey,
} from '../../srv/lib/long-session';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function make(
  cfg: Partial<{
    ttlMs: number;
    maxSessions: number;
    maxPerUser: number;
    queueLength: number;
  }> = {},
  onClose?: (s: LongSession, reason: CloseReason) => Promise<void>,
) {
  let t = 0;
  const closed: Array<{ key: string; reason: CloseReason }> = [];
  const registry = new LongSessionRegistry(
    { ttlMs: 1000, maxSessions: 10, maxPerUser: 5, queueLength: 2, ...cfg },
    {
      onClose:
        onClose ??
        (async (s, reason) => {
          closed.push({ key: s.key, reason });
        }),
    },
    () => t,
  );
  return {
    registry,
    closed,
    setTime: (v: number) => {
      t = v;
    },
  };
}

function opened(r: ReturnType<LongSessionRegistry['open']>): LongSession {
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  return r;
}

describe('LongSessionRegistry', () => {
  it('open mints ls- keys and enforces caps', () => {
    const { registry } = make({ maxSessions: 2, maxPerUser: 1 });
    const a = opened(registry.open('alice', {}));
    expect(a.key).toMatch(/^ls-/);
    expect(a.revived).toBe(false);
    expect(registry.open('alice', {})).toEqual({ refused: 'SESSION_LIMIT' });
    expect('refused' in registry.open('bob', {})).toBe(false);
    expect(registry.open('carol', {})).toEqual({ refused: 'SESSION_LIMIT' });
    expect(registry.size()).toBe(2);
    expect(registry.size('alice')).toBe(1);
  });

  it('open with a key revives under that key', () => {
    const { registry } = make();
    const s = opened(
      registry.open('alice', { key: 'ls-old', createdAt: 5, revived: true }),
    );
    expect(s.key).toBe('ls-old');
    expect(s.createdAt).toBe(5);
    expect(s.revived).toBe(true);
    expect(registry.get('alice', 'ls-old')).toBe(s);
  });

  it('get is scoped by user', () => {
    const { registry } = make();
    const a = opened(registry.open('alice', {}));
    expect(registry.get('alice', a.key)).toBe(a);
    expect(registry.get('bob', a.key)).toBeUndefined();
    expect(registry.has('bob', a.key)).toBe(false);
    expect(registry.has('alice', a.key)).toBe(true);
  });

  it('newSessionKey mints distinct ls- keys', () => {
    expect(newSessionKey()).toMatch(/^ls-[0-9a-f-]{36}$/);
    expect(newSessionKey()).not.toBe(newSessionKey());
  });

  it('run serialises one session', async () => {
    const { registry } = make();
    const s = opened(registry.open('alice', {}));
    const order: string[] = [];
    const gate = deferred();
    const a = registry.run(s, async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const b = registry.run(s, async () => {
      order.push('b-start');
    });
    await tick();
    expect(order).toEqual(['a-start']);
    gate.resolve();
    await a;
    await b;
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('run returns the value of fn', async () => {
    const { registry } = make();
    const s = opened(registry.open('alice', {}));
    expect(await registry.run(s, async () => 42)).toBe(42);
  });

  it('run refuses beyond the queue', async () => {
    const { registry } = make({ queueLength: 1 });
    const s = opened(registry.open('alice', {}));
    const gate = deferred();
    const first = registry.run(s, () => gate.promise);
    const second = registry.run(s, async () => 'second');
    const fn = jest.fn(async () => 'third');
    expect(await registry.run(s, fn)).toEqual({ refused: 'SESSION_BUSY' });
    expect(fn).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    expect(await second).toBe('second');
  });

  it('run frees its slot when fn throws', async () => {
    const { registry } = make({ queueLength: 0 });
    const s = opened(registry.open('alice', {}));
    await expect(
      registry.run(s, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await registry.run(s, async () => 'ok')).toBe('ok');
  });

  it('run touches before and after', async () => {
    const { registry, setTime } = make();
    const touched: number[] = [];
    const s = opened(registry.open('alice', {}));
    setTime(100);
    await registry.run(s, async () => {
      touched.push(s.lastActivity);
      setTime(300);
    });
    expect(touched).toEqual([100]);
    expect(s.lastActivity).toBe(300);
  });

  it('calls onTouch on open and on every run', async () => {
    const onTouch = jest.fn();
    const registry = new LongSessionRegistry(
      { ttlMs: 1000, maxSessions: 5, maxPerUser: 5, queueLength: 2 },
      { onClose: async () => {}, onTouch },
      () => 0,
    );
    const s = opened(registry.open('alice', {}));
    expect(onTouch).toHaveBeenCalledTimes(1);
    await registry.run(s, async () => {});
    expect(onTouch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sweep closes idle sessions only', async () => {
    const { registry, closed, setTime } = make({ ttlMs: 1000 });
    const s = opened(registry.open('alice', {}));
    setTime(500);
    await registry.run(s, async () => {});
    setTime(1400);
    expect(await registry.sweep()).toBe(0);
    expect(closed).toEqual([]);
    setTime(1600);
    expect(await registry.sweep()).toBe(1);
    expect(closed).toEqual([{ key: s.key, reason: 'ttl' }]);
    expect(registry.size()).toBe(0);
  });

  it('sweep leaves a session with a running request alone', async () => {
    const { registry, closed, setTime } = make({ ttlMs: 1000 });
    const s = opened(registry.open('alice', {}));
    const gate = deferred();
    const running = registry.run(s, () => gate.promise);
    setTime(5000);
    expect(await registry.sweep()).toBe(0);
    gate.resolve();
    await running;
    expect(closed).toEqual([]);
  });

  it('close waits for the running request and is idempotent', async () => {
    const { registry, closed } = make();
    const s = opened(registry.open('alice', {}));
    const order: string[] = [];
    const gate = deferred();
    const running = registry.run(s, async () => {
      await gate.promise;
      order.push('run-end');
    });
    const queued = registry.run(s, async () => 'never');
    await tick();
    const closing = registry.close('alice', s.key, 'explicit').then(() => {
      order.push('closed');
    });
    expect(registry.get('alice', s.key)).toBeUndefined();
    expect(registry.has('alice', s.key)).toBe(false);
    await tick();
    expect(order).toEqual([]);
    gate.resolve();
    await running;
    await closing;
    expect(order).toEqual(['run-end', 'closed']);
    expect(await queued).toEqual({ refused: 'SESSION_CLOSED' });
    await registry.close('alice', s.key, 'explicit');
    expect(closed).toEqual([{ key: s.key, reason: 'explicit' }]);
    expect(await registry.run(s, async () => 'x')).toEqual({
      refused: 'SESSION_CLOSED',
    });
  });

  it('concurrent closes call onClose once', async () => {
    const { registry, closed } = make();
    const s = opened(registry.open('alice', {}));
    await Promise.all([
      registry.close('alice', s.key, 'explicit'),
      registry.close('alice', s.key, 'ttl'),
    ]);
    expect(closed).toEqual([{ key: s.key, reason: 'explicit' }]);
  });

  it('close of an unknown or foreign key does nothing', async () => {
    const { registry, closed } = make();
    const s = opened(registry.open('alice', {}));
    await registry.close('bob', s.key, 'explicit');
    await registry.close('alice', 'ls-nope', 'explicit');
    expect(closed).toEqual([]);
    expect(registry.size()).toBe(1);
  });

  it("closeAll('shutdown') calls onClose for every session", async () => {
    const { registry, closed } = make();
    const a = opened(registry.open('alice', {}));
    const b = opened(registry.open('bob', {}));
    await registry.closeAll('shutdown');
    expect(closed.map((c) => c.reason)).toEqual(['shutdown', 'shutdown']);
    expect(closed.map((c) => c.key).sort()).toEqual([a.key, b.key].sort());
    expect(registry.size()).toBe(0);
  });

  it('a throwing onClose rejects close but still removes the session', async () => {
    const { registry } = make({}, async () => {
      throw new Error('abap gone');
    });
    const s = opened(registry.open('alice', {}));
    await expect(registry.close('alice', s.key, 'explicit')).rejects.toThrow(
      'abap gone',
    );
    expect(registry.size()).toBe(0);
    expect(registry.get('alice', s.key)).toBeUndefined();
  });

  it('sweep and closeAll close the others when one hook throws', async () => {
    const closed: string[] = [];
    const { registry, setTime } = make({}, async (s) => {
      if (s.userId === 'bad') throw new Error('abap gone');
      closed.push(s.key);
    });
    const warn = jest
      .spyOn(cds.log('long-session'), 'warn')
      .mockReturnValue(undefined as never);
    const good = opened(registry.open('alice', {}));
    opened(registry.open('bad', {}));
    setTime(5000);
    expect(await registry.sweep()).toBe(2);
    expect(closed).toEqual([good.key]);
    expect(registry.size()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    opened(registry.open('bad', {}));
    opened(registry.open('alice', {}));
    await expect(registry.closeAll('shutdown')).resolves.toBeUndefined();
    expect(closed).toHaveLength(2);
    expect(registry.size()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('open refuses an existing key, live or closing', async () => {
    const gate = deferred();
    const { registry } = make({}, async () => gate.promise);
    const s = opened(registry.open('alice', { key: 'ls-k' }));
    expect(registry.open('alice', { key: 'ls-k' })).toEqual({
      refused: 'SESSION_EXISTS',
    });
    expect(registry.get('alice', 'ls-k')).toBe(s);
    const closing = registry.close('alice', 'ls-k', 'explicit');
    expect(registry.open('alice', { key: 'ls-k' })).toEqual({
      refused: 'SESSION_EXISTS',
    });
    gate.resolve();
    await closing;
    expect('refused' in registry.open('alice', { key: 'ls-k' })).toBe(false);
  });
});

test('sweep keeps a held session past the TTL', async () => {
  const { registry, setTime } = make();
  const s = opened(registry.open('alice', {}));
  const a = registry.hold(s);
  const b = registry.hold(s);
  setTime(2000);
  expect(await registry.sweep()).toBe(0);
  a();
  setTime(4000);
  expect(await registry.sweep()).toBe(0);
  b();
});

test('release touches, so the TTL counts from release', async () => {
  const { registry, setTime } = make();
  const s = opened(registry.open('alice', {}));
  const release = registry.hold(s);
  setTime(2000);
  release();
  expect(s.lastActivity).toBe(2000);
  setTime(3000);
  expect(await registry.sweep()).toBe(0);
  setTime(3001);
  expect(await registry.sweep()).toBe(1);
});

test('double release is harmless', async () => {
  const { registry, setTime } = make();
  const s = opened(registry.open('alice', {}));
  const release = registry.hold(s);
  setTime(2000);
  release();
  setTime(2500);
  release();
  expect(s.lastActivity).toBe(2000);
  setTime(3001);
  expect(await registry.sweep()).toBe(1);
});
