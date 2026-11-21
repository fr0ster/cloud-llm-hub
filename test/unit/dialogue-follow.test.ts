import { type ChatStream, streamDialogue } from '../../srv/lib/chat-stream';
import { followDialogue, supersedeFollow } from '../../srv/lib/dialogue-follow';
import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';
import type {
  DialogueEvent,
  DialogueHandle,
} from '../../srv/lib/dialogue-sessions';

function fixture(priorFailure = false) {
  const outbox = new DialogueOutbox([], async () => {});
  const state: ReturnType<DialogueHandle['state']> = {
    settledSeq: priorFailure ? 1 : 0,
    lastFailedSeq: priorFailure ? 1 : 0,
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
  const since = state.settledSeq;
  const delivery = outbox.beginDelivery();
  const controller = new AbortController();
  const start = (signal = controller.signal) =>
    followDialogue(handle, {
      delivery,
      since,
      signal,
    })[Symbol.asyncIterator]();
  return {
    emit: (event: DialogueEvent) => {
      for (const fn of listeners) fn(event);
    },
    handle,
    state,
    outbox,
    delivery,
    controller,
    start,
    settled: (outcome: 'ok' | 'failed' = 'ok') => {
      state.settledSeq++;
      if (outcome === 'failed') state.lastFailedSeq = state.settledSeq;
      for (const fn of listeners)
        fn({ kind: 'settled', outcome, trigger: 'event' });
    },
    add: (id: string) =>
      outbox.add([{ id, text: id, createdAt: 1, trigger: 'event' }]),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each(['openai', 'anthropic'] as const)(
  '%s sends a dialogue reply after the former 30-minute deadline',
  async (protocol) => {
    const f = fixture();
    const write = jest.fn<void, [string]>();
    const stream: ChatStream = {
      createdAt: Date.now(),
      toolResults: false,
      measurement: undefined,
      signal: f.controller.signal,
      opened: true,
      ensureStream: jest.fn(),
      error: jest.fn(),
      end: jest.fn(),
      out: {
        detached: false,
        detach: jest.fn(),
        writeHead: jest.fn(),
        setHeader: jest.fn(),
        write,
        end: jest.fn(),
        json: jest.fn(),
      },
    };
    const continueStream = await streamDialogue({
      stream,
      protocol,
      model: 'test',
      context: { adapterName: protocol, protocol: {} },
      agent: {
        process: jest.fn(),
        streamProcess: jest.fn(),
        hasFollow: () => true,
        follow: (signal) => ({
          [Symbol.asyncIterator]: () => f.start(signal),
        }),
      },
      source: (async function* () {
        yield { ok: true as const, value: { content: 'Initial reply' } };
      })(),
      run: (fn) => fn(),
      onError: String,
    });
    const finished = continueStream();
    await jest.advanceTimersByTimeAsync(1_800_001);
    expect(stream.end).not.toHaveBeenCalled();
    await f.add('Late reply');
    f.state.status = 'done';
    f.settled();
    await finished;
    expect(write.mock.calls.flat().join('')).toContain('Late reply');
    expect(stream.end).toHaveBeenCalledTimes(1);
    expect(stream.error).not.toHaveBeenCalled();
  },
);

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

test.each(['done', 'disconnected'] as const)(
  'delivers a message after the former 30-minute deadline and ends on %s',
  async (reason) => {
    const f = fixture();
    const iterator = f.start();
    const next = iterator.next();
    await jest.advanceTimersByTimeAsync(1_800_001);
    await f.add('late reply');
    expect((await next).value).toMatchObject({
      kind: 'message',
      message: { text: 'late reply' },
    });
    if (reason === 'done') {
      f.state.status = 'done';
      f.settled();
    } else {
      f.controller.abort();
    }
    expect((await iterator.next()).value).toEqual({ kind: 'end', reason });
    expect((await iterator.next()).done).toBe(true);
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

test.each([false, true])(
  'failure before subscription ends with error even after success=%s',
  async (success) => {
    const f = fixture();
    const startedAt = Date.now();
    f.settled('failed');
    if (success) f.settled('ok');
    expect(Date.now()).toBe(startedAt);
    f.state.idle = true;
    const iterator = f.start();
    expect((await iterator.next()).value).toEqual({
      kind: 'end',
      reason: 'error',
    });
    expect((await iterator.next()).done).toBe(true);
  },
);

test('failure before delivery began does not end with error', async () => {
  const f = fixture(true);
  f.state.idle = true;
  const iterator = f.start();
  expect((await iterator.next()).value).toEqual({
    kind: 'end',
    reason: 'idle',
  });
  expect((await iterator.next()).done).toBe(true);
});

test('supersede waits for response completion beyond five seconds', async () => {
  const f = fixture();
  let endResponse!: () => void;
  const iterator = followDialogue(f.handle, {
    delivery: f.delivery,
    since: 0,
    signal: f.controller.signal,
    responseEnded: new Promise<void>((resolve) => {
      endResponse = resolve;
    }),
  })[Symbol.asyncIterator]();
  const next = iterator.next();
  await Promise.resolve();
  let resolved = false;
  const superseding = supersedeFollow(f.handle).then(() => {
    resolved = true;
  });
  expect((await next).value).toMatchObject({ reason: 'superseded' });
  await jest.advanceTimersByTimeAsync(4999);
  expect(resolved).toBe(false);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(resolved).toBe(false);
  endResponse();
  await superseding;
  expect(resolved).toBe(true);
  await iterator.return?.();
});

test('queued tool results drain before the failure terminal', async () => {
  const f = fixture();
  const iterator = f.start();
  const next = iterator.next();
  await Promise.resolve();
  const records = [1, 2].map((id) => ({
    call: { id: String(id), name: 'record_get', arguments: {} },
    result: { content: `result-${id}` },
  }));
  for (const record of records) f.emit({ kind: 'tool-result', record });
  f.settled('failed');
  expect((await next).value).toEqual({
    kind: 'tool-result',
    record: records[0],
  });
  expect((await iterator.next()).value).toEqual({
    kind: 'tool-result',
    record: records[1],
  });
  expect((await iterator.next()).value).toEqual({
    kind: 'end',
    reason: 'error',
  });
  expect((await iterator.next()).done).toBe(true);
});
