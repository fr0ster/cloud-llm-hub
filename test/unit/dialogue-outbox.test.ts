import {
  DialogueOutbox,
  type OutboxEntry,
} from '../../srv/lib/dialogue-outbox';

const message = (id: string) => ({
  id,
  text: id,
  createdAt: 1,
  trigger: 'event' as const,
});
const ended = (box: DialogueOutbox, ...ids: string[]) => {
  const delivery = box.beginDelivery();
  for (const id of ids) delivery.carried(id);
  delivery.ended();
  return delivery;
};

test('flushed waits for queued adds and writes including message publication', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const box = new DialogueOutbox([], async () => {
    await blocked;
  });
  box.subscribe((message) => events.push(message.id));
  const first = box.add([message('m1')]);
  const second = box.add([message('m2')]);
  const write = box.enterAckMode();
  const flushed = box.flushed().then(() => events.push('flushed'));
  await Promise.resolve();
  expect(events).toEqual([]);
  release();
  await Promise.all([first, second, write, flushed]);
  expect(box.ackMode).toBe(true);
  expect(events).toEqual(['m1', 'm2', 'flushed']);
});

test('confirms only messages carried by an ended delivery', async () => {
  const box = new DialogueOutbox([], async () => {});
  await box.add(['m1', 'm2', 'm3'].map(message));
  ended(box, 'm1', 'm3');
  await box.confirmByArrival();
  expect(box.pending().map((m) => m.id)).toEqual(['m2', 'm3']);
});

test('a delivery that did not end confirms nothing', async () => {
  const box = new DialogueOutbox([message('m1')], async () => {});
  const delivery = box.beginDelivery();
  delivery.carried('m1');
  expect(delivery.has('m1')).toBe(true);
  await box.confirmByArrival();
  await box.confirmUpTo('m1');
  expect(box.pending()).toEqual([message('m1')]);
});

test('confirmUpTo stops at the named id and at an uncarried message', async () => {
  const box = new DialogueOutbox(
    ['m1', 'm2', 'm3'].map(message),
    async () => {},
  );
  ended(box, 'm1', 'm3');
  await box.confirmUpTo('unknown');
  expect(box.pending()).toHaveLength(3);
  await box.confirmUpTo('m1');
  expect(box.pending().map((m) => m.id)).toEqual(['m2', 'm3']);
  await box.confirmUpTo('m3');
  expect(box.pending().map((m) => m.id)).toEqual(['m2', 'm3']);
  ended(box, 'm2');
  await box.confirmUpTo('m2');
  expect(box.pending().map((m) => m.id)).toEqual(['m3']);
  await box.confirmUpTo('m3');
  expect(box.pending()).toEqual([]);
});

test('ack mode ignores arrival and survives restart without delivery records', async () => {
  let saved: OutboxEntry[] = [];
  let mode = false;
  const box = new DialogueOutbox([message('m1')], async (entries, ackMode) => {
    saved = entries;
    mode = ackMode;
  });
  await box.enterAckMode();
  ended(box, 'm1');
  await box.confirmByArrival();
  expect(box.pending()).toHaveLength(1);
  const restored = new DialogueOutbox(saved, async () => {}, mode);
  expect(restored.ackMode).toBe(true);
  await restored.confirmUpTo('m1');
  expect(restored.pending()).toHaveLength(1);
  await box.confirmUpTo('m1');
  expect(box.pending()).toEqual([]);
});

test('history keeps confirmed messages, bounded to 200 confirmed', async () => {
  const box = new DialogueOutbox([], async () => {});
  const messages = Array.from({ length: 202 }, (_, i) => message(String(i)));
  await box.add([...messages, messages[0]]);
  ended(box, ...messages.slice(0, 201).map((m) => m.id));
  await box.confirmByArrival();
  expect(box.history()).toEqual(messages.slice(1));
  expect(box.history('199')).toEqual(messages.slice(200));
  expect(box.pending()).toEqual(messages.slice(201));
  await box.add([messages[0]]);
  expect(box.history()).toHaveLength(201);
});

test('persist receives entries with confirmed flags and ackMode', async () => {
  const persist = jest.fn(
    async (_entries: OutboxEntry[], _mode: boolean) => {},
  );
  const box = new DialogueOutbox([message('m1')], persist);
  ended(box, 'm1');
  await box.enterAckMode();
  await box.confirmUpTo('m1');
  expect(persist).toHaveBeenLastCalledWith(
    [{ ...message('m1'), confirmed: true }],
    true,
  );
  expect(box.history()).toEqual([message('m1')]);
});

test('failed durable confirmation retains pending and serialized additions survive', async () => {
  let fail = true;
  const box = new DialogueOutbox([message('m1')], async () => {
    if (fail) throw new Error('offline');
  });
  ended(box, 'm1');
  await expect(box.confirmByArrival()).rejects.toThrow('offline');
  expect(box.pending()).toEqual([message('m1')]);
  fail = false;
  await Promise.all([box.confirmByArrival(), box.add([message('m2')])]);
  expect(box.pending()).toEqual([message('m2')]);
  expect(box.history()).toEqual(['m1', 'm2'].map(message));
});

test('delivery records drop oldest ended first and remain bounded with open responses', async () => {
  const box = new DialogueOutbox(['m1', 'm2'].map(message), async () => {});
  const open = box.beginDelivery();
  open.carried('m1');
  ended(box, 'm2');
  for (let i = 0; i < 19; i++) box.beginDelivery();
  open.ended();
  await box.confirmByArrival();
  expect(box.pending()).toEqual([message('m2')]);
  const conservative = new DialogueOutbox([message('m1')], async () => {});
  const oldest = conservative.beginDelivery();
  oldest.carried('m1');
  for (let i = 0; i < 20; i++) conservative.beginDelivery();
  oldest.ended();
  await conservative.confirmByArrival();
  expect(conservative.pending()).toHaveLength(1);
});

test('subscribers receive retained history with independent cursors after failed persistence', async () => {
  let fail = true;
  const box = new DialogueOutbox([], async () => {
    if (fail) throw new Error('offline');
  });
  const first: string[] = [],
    second: string[] = [];
  box.subscribe((m) => first.push(m.id));
  await expect(box.add([message('a')])).rejects.toThrow('offline');
  box.subscribe((m) => second.push(m.id), 'a');
  fail = false;
  await box.add([message('b')]);
  ended(box, 'a', 'b');
  await box.confirmByArrival();
  const late: string[] = [];
  box.subscribe((m) => late.push(m.id));
  expect(first).toEqual(['a', 'b']);
  expect(second).toEqual(['b']);
  expect(late).toEqual(['a', 'b']);
});

test.each([
  ['NO_MESSAGE', undefined],
  ['  NO_MESSAGE \n NO_MESSAGE  ', undefined],
  ['Result\n\nNO_MESSAGE', 'Result'],
  ['NO_MESSAGE\n\nResult', 'Result'],
  ['NO_MESSAGE Result NO_MESSAGE', 'Result'],
  ['MY_NO_MESSAGE NO_MESSAGE_suffix', 'MY_NO_MESSAGE NO_MESSAGE_suffix'],
  ['Result NO_MESSAGE inside text', 'Result NO_MESSAGE inside text'],
])(
  'cleans boundary sentinels in %j before storage and delivery',
  async (text, expected) => {
    const message = {
      id: 'one',
      text,
      createdAt: 1,
      trigger: 'event' as const,
    };
    const persist = jest.fn(async () => {});
    const outbox = new DialogueOutbox([], persist);
    const delivered: string[] = [];
    outbox.subscribe((m) => delivered.push(m.text));
    await outbox.add([message]);
    const texts = expected === undefined ? [] : [expected];
    expect(delivered).toEqual(texts);
    expect(outbox.history().map((m) => m.text)).toEqual(texts);
    expect(persist).toHaveBeenCalledWith(outbox.history(), false);
    const restored = new DialogueOutbox([message], persist);
    expect(restored.history().map((m) => m.text)).toEqual(texts);
  },
);

test('upsert replaces an unconfirmed reply and preserves confirmed text', async () => {
  const persist = jest.fn(async (_entries: OutboxEntry[]) => {});
  const box = new DialogueOutbox([], persist);
  await box.upsert([message('reply')]);
  await box.upsert([{ ...message('reply'), text: 'complete' }]);
  expect(box.pending()).toEqual([{ ...message('reply'), text: 'complete' }]);
  ended(box, 'reply');
  await box.confirmUpTo('reply');
  await box.upsert([{ ...message('reply'), text: 'changed' }]);
  expect(box.history()).toEqual([{ ...message('reply'), text: 'complete' }]);
  expect(box.pending()).toEqual([]);
});

test('usage updates reach passed cursors once without replaying a message', async () => {
  const box = new DialogueOutbox([], async () => {});
  const messages: string[] = [];
  const updates: string[] = [];
  box.subscribe(
    (reply) => messages.push(reply.id),
    undefined,
    (id) => updates.push(id),
  );
  await box.add([message('reply')]);
  const enriched = {
    ...message('reply'),
    usage: {
      planner: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    },
  };
  await box.upsert([enriched]);
  await box.upsert([enriched]);
  expect(messages).toEqual(['reply']);
  expect(updates).toEqual(['reply']);
  const replay: string[] = [];
  box.subscribe(
    (reply) => replay.push(reply.id),
    'reply',
    (id) => replay.push(id),
  );
  await box.upsert([
    {
      ...enriched,
      usage: {
        planner: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      },
    },
  ]);
  expect(replay).toEqual(['reply']);
});
