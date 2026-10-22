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
