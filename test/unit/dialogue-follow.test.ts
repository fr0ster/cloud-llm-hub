import { followDialogue, supersedeFollow } from '../../srv/lib/dialogue-follow';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';
import type {
  DialogueEvent,
  DialogueHandle,
} from '../../srv/lib/dialogue-sessions';

function fixture() {
  const outbox = new DialogueOutbox([], async () => {});
  const state: ReturnType<DialogueHandle['state']> = {
    turnActive: false,
    queuedInputs: 0,
    running: 1,
    total: 5,
    done: 3,
    status: 'active' as 'active' | 'done' | 'waiting_user',
    idle: false,
  };
  const listeners = new Set<(event: DialogueEvent) => void>();
  const handle = {
    outbox,
    state: () => state,
    subscribe(fn: (event: DialogueEvent) => void) {
      listeners.add(fn);
      const off = outbox.subscribe((message) =>
        fn({ kind: 'message', message }),
      );
      return () => {
        off();
        listeners.delete(fn);
      };
    },
  } as DialogueHandle;
  const delivery = outbox.beginDelivery();
  const controller = new AbortController();
  const start = () =>
    followDialogue(handle, {
      delivery,
      signal: controller.signal,
      maxMs: 1000,
    })[Symbol.asyncIterator]();
  return {
    handle,
    state,
    outbox,
    delivery,
    controller,
    start,
    settled: (outcome: 'ok' | 'failed' = 'ok') => {
      for (const fn of listeners)
        fn({ kind: 'settled', outcome, trigger: 'event' });
    },
    add: (id: string) =>
      outbox.add([{ id, text: id, createdAt: 1, trigger: 'event' }]),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a message added before the reply is still streamed', async () => {
  const f = fixture();
  f.outbox.pending();
  await f.add('background');
  await f.add('reply');
  f.delivery.carried('reply');
  const iterator = f.start();
  const item = (await iterator.next()).value;
  expect(item).toMatchObject({
    kind: 'message',
    message: { id: 'background' },
  });
  expect(f.delivery.has('background')).toBe(false);
  if (item?.kind === 'message') item.written();
  expect(f.delivery.has('background')).toBe(true);
  await iterator.return?.();
});

test.each(['done', 'waiting_user'] as const)(
  'ends on %s only after the turn message and settled',
  async (status) => {
    const f = fixture();
    const iterator = f.start();
    const next = iterator.next();
    await Promise.resolve();
    f.state.status = status;
    await f.add('final');
    expect((await next).value).toMatchObject({
      kind: 'message',
      message: { id: 'final' },
    });
    f.settled();
    expect((await iterator.next()).value).toEqual({
      kind: 'end',
      reason: status,
    });
    await iterator.next();
  },
);

test.each(['turnActive', 'queuedInputs'] as const)(
  'does not stop at start while %s is unsettled',
  async (field) => {
    const f = fixture();
    f.state.status = 'done';
    if (field === 'turnActive') f.state.turnActive = true;
    else f.state.queuedInputs = 1;
    const iterator = f.start();
    const next = iterator.next();
    await Promise.resolve();
    await f.add('last');
    expect((await next).value).toMatchObject({ kind: 'message' });
    f.state.turnActive = false;
    f.state.queuedInputs = 0;
    f.settled();
    expect((await iterator.next()).value).toEqual({
      kind: 'end',
      reason: 'done',
    });
    await iterator.next();
  },
);

test('ends idle only on a settled state with nothing running', async () => {
  const f = fixture();
  const iterator = f.start();
  const next = iterator.next();
  await Promise.resolve();
  f.state.running = 0;
  f.state.idle = true;
  f.settled();
  expect((await next).value).toEqual({ kind: 'end', reason: 'idle' });
  await iterator.next();
});

test.each([5, 0])(
  'limit ends with the exact status line, total %s',
  async (total) => {
    const f = fixture();
    f.state.total = total;
    const iterator = f.start();
    const next = iterator.next();
    await jest.advanceTimersByTimeAsync(1000);
    expect((await next).value).toEqual({
      kind: 'end',
      reason: 'limit',
      note: total ? 'still running: 3 of 5 steps done' : 'still running',
    });
    await iterator.next();
  },
);

test('supersede ends the old follow with the exact note before the new one starts', async () => {
  const f = fixture();
  const old = f.start();
  const end = old.next();
  await Promise.resolve();
  const replacement = f.start();
  const next = replacement.next();
  expect((await end).value).toEqual({
    kind: 'end',
    reason: 'superseded',
    note: 'A new message arrived; the work continues in its response.',
  });
  const supersede = supersedeFollow(f.handle);
  expect((await next).value).toMatchObject({
    kind: 'end',
    reason: 'superseded',
  });
  await supersede;
  await old.next();
  await replacement.next();
});

test('abort ends with disconnected and yields nothing more', async () => {
  const f = fixture();
  const iterator = f.start();
  const next = iterator.next();
  f.controller.abort();
  expect((await next).value).toEqual({ kind: 'end', reason: 'disconnected' });
  await f.add('later');
  expect((await iterator.next()).done).toBe(true);
});

test('abort before next allows supersede to finish', async () => {
  const f = fixture();
  const iterator = f.start();
  f.controller.abort();
  await supersedeFollow(f.handle);
  await f.add('later');
  expect((await iterator.next()).value).toEqual({
    kind: 'end',
    reason: 'disconnected',
  });
  expect((await iterator.next()).done).toBe(true);
});

test('supersede before next finishes and prevents message delivery', async () => {
  const f = fixture();
  const iterator = f.start();
  await supersedeFollow(f.handle);
  await f.add('later');
  expect((await iterator.next()).value).toMatchObject({
    kind: 'end',
    reason: 'superseded',
  });
  expect((await iterator.next()).done).toBe(true);
});

test('return before next allows supersede to finish', async () => {
  const f = fixture();
  const iterator = f.start();
  expect((await iterator.return?.())?.done).toBe(true);
  await supersedeFollow(f.handle);
  expect((await iterator.next()).done).toBe(true);
});

test('replacement can start when the previous follow never started', async () => {
  const f = fixture();
  const old = f.start();
  const replacement = f.start();
  await f.add('replacement');
  expect((await replacement.next()).value).toMatchObject({
    kind: 'message',
    message: { id: 'replacement' },
  });
  expect((await old.next()).value).toMatchObject({
    kind: 'end',
    reason: 'superseded',
  });
  await old.next();
  await replacement.return?.();
});

test('failed settlement ends after progress with an error', async () => {
  const f = fixture();
  await f.add('progress');
  const iterator = f.start();
  expect((await iterator.next()).value).toMatchObject({ kind: 'message' });
  f.settled('failed');
  expect((await iterator.next()).value).toEqual({
    kind: 'end',
    reason: 'error',
  });
  expect((await iterator.next()).done).toBe(true);
});

test.each([-1, 0, 1])(
  'retained failure at delivery start %+i ends only if newer',
  async (offset) => {
    const f = fixture();
    jest.advanceTimersByTime(10);
    f.state.lastSettled = {
      outcome: 'failed',
      at: f.delivery.startedAt + offset,
    };
    f.state.idle = true;
    const iterator = f.start();
    expect((await iterator.next()).value).toEqual({
      kind: 'end',
      reason: offset > 0 ? 'error' : 'idle',
    });
    expect((await iterator.next()).done).toBe(true);
  },
);
