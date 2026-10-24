import { DialogueOutbox } from '../../srv/lib/dialogue-outbox';

test('retains on failed delivery, replays by id, deduplicates and acknowledges prefixes', async () => {
  const saves: unknown[] = [];
  const outbox = new DialogueOutbox([], async (messages) => {
    saves.push(messages);
  });
  const one = {
    id: 'one',
    text: 'first',
    createdAt: 1,
    trigger: 'event' as const,
  };
  const two = { ...one, id: 'two' };
  await outbox.add([one, two, one]);
  expect(outbox.replay().map((m) => m.id)).toEqual(['one', 'two']);
  expect(outbox.replay('one')).toEqual([two]);
  const restarted = new DialogueOutbox(outbox.replay(), async () => {});
  expect(restarted.replay()).toEqual([one, two]);
  await restarted.ack('missing');
  expect(restarted.replay()).toHaveLength(2);
  await restarted.ack('one');
  expect(restarted.replay()).toEqual([two]);
  expect(saves).toHaveLength(1);
});

test('failed durable acknowledgement retains prefix and concurrent additions survive acknowledgement', async () => {
  const one = {
    id: 'one',
    text: 'first',
    createdAt: 1,
    trigger: 'event' as const,
  };
  let fail = false;
  let release: (() => void) | undefined;
  const outbox = new DialogueOutbox([one], async () => {
    if (fail) throw new Error('database failed');
    if (release === undefined)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  fail = true;
  await expect(outbox.ack('one')).rejects.toThrow('database failed');
  expect(outbox.replay()).toEqual([one]);
  fail = false;
  const ack = outbox.ack('one');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const two = { ...one, id: 'two' };
  const added = outbox.add([two]);
  release?.();
  await ack;
  await added;
  expect(outbox.replay()).toEqual([two]);
});

test('delivers failed persistence prefixes in order with independent tab cursors', async () => {
  let fail = true;
  const box = new DialogueOutbox([], async () => {
    if (fail) throw new Error('offline');
  });
  const a = { id: 'a', text: 'A', createdAt: 1, trigger: 'event' as const };
  const b = { ...a, id: 'b' };
  const first: string[] = [],
    second: string[] = [];
  box.subscribe((m) => {
    first.push(m.id);
  });
  await expect(box.add([a])).rejects.toThrow('offline');
  box.subscribe((m) => {
    second.push(m.id);
  }, 'a');
  fail = false;
  await box.add([b]);
  expect(first).toEqual(['a', 'b']);
  expect(second).toEqual(['b']);
  await box.ack('b');
  expect(box.replay()).toEqual([]);
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
    expect(outbox.replay().map((m) => m.text)).toEqual(texts);
    expect(persist).toHaveBeenCalledWith(outbox.replay());
    const restored = new DialogueOutbox([message], persist);
    expect(restored.replay().map((m) => m.text)).toEqual(texts);
  },
);
