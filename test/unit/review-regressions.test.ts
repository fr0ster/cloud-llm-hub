import { ExpositionFilteringRag } from '../../srv/agent-manager';
import { MemoryRunRecordStore } from '../../srv/lib/run-record-store';
import { assertToolAllowed } from '../../srv/lib/tool-authorization';
import {
  runWithReadOnlyTools,
  runWithSessionId,
} from '../../srv/request-session';

const record = {
  runId: 'a',
  request: 'secret',
  plan: { steps: [], createdAt: 1 },
  steps: [],
  outcome: 'answered' as const,
  finishedAt: 2,
};
const scoped = <T>(
  user: string | undefined,
  session: string | undefined,
  fn: () => T,
) => runWithSessionId(session, fn, [], user);
it('isolates authenticated users and sessions, and refuses missing or mismatched scope', async () => {
  const store = new MemoryRunRecordStore();
  await scoped('a', 's', () => store.save('s', record));
  expect(await scoped('a', 's', () => store.load('s'))).toEqual(record);
  expect(await scoped('b', 's', () => store.load('s'))).toBeUndefined();
  expect(await scoped('a', 'other', () => store.load('other'))).toBeUndefined();
  expect(await scoped('a', 'other', () => store.load('s'))).toBeUndefined();
  expect(await store.load('s')).toBeUndefined();
  await scoped(undefined, 's', () =>
    store.save('s', { ...record, runId: 'bad' }),
  );
  await scoped('a', undefined, () =>
    store.save('s', { ...record, runId: 'bad' }),
  );
  expect((await scoped('a', 's', () => store.load('s')))?.runId).toBe('a');
});
it('expires records by save time and sweeps memory on save', async () => {
  jest.useFakeTimers();
  try {
    const store = new MemoryRunRecordStore(2, 100);
    await scoped('a', 's', () => store.save('s', record));
    jest.advanceTimersByTime(101);
    expect(await scoped('a', 's', () => store.load('s'))).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});
it('checker blocks writes before dispatch, permits reads, and leaves executor unaffected', () => {
  const adapter = jest.fn();
  const invoke = (name: string, group: string) => {
    assertToolAllowed(name, group, ['readonly', 'high']);
    adapter();
  };
  expect(() =>
    runWithReadOnlyTools(() => invoke('CreateClass', 'high')),
  ).toThrow(/read.only/i);
  expect(adapter).not.toHaveBeenCalled();
  runWithReadOnlyTools(() => invoke('GetClass', 'readonly'));
  invoke('CreateClass', 'high');
  expect(adapter).toHaveBeenCalledTimes(2);
});
it('checker offered tools exclude writes even with developer permissions', async () => {
  const rows = [
    'GetClass',
    'GetProgram',
    'CheckClass',
    'GetATCFindings',
    'CreateClass',
  ].map((name) => ({
    score: 1,
    metadata: {
      id: `tool:${name}`,
      exposition: 'high',
    },
  }));
  const rag = new ExpositionFilteringRag({
    query: async () => ({ ok: true, value: rows }),
    writer: () => undefined,
  } as never);
  const result = await runWithReadOnlyTools(() =>
    rag.query({} as never, 10, {
      ragFilter: { exposition: ['readonly', 'high'] },
    }),
  );
  expect(result.ok && result.value.map((r) => r.metadata.id)).toEqual([
    'tool:GetClass',
    'tool:GetProgram',
    'tool:CheckClass',
    'tool:GetATCFindings',
  ]);
});

it('keeps both users and both sessions independently and deletes only the named owner', async () => {
  const store = new MemoryRunRecordStore(10);
  for (const [user, session, runId] of [
    ['a', 's', 'as'],
    ['b', 's', 'bs'],
    ['a', 't', 'at'],
  ]) {
    await scoped(user, session, () =>
      store.save(session, { ...record, runId }),
    );
  }
  expect((await scoped('a', 's', () => store.load('s')))?.runId).toBe('as');
  expect((await scoped('b', 's', () => store.load('s')))?.runId).toBe('bs');
  expect((await scoped('a', 't', () => store.load('t')))?.runId).toBe('at');
  await scoped('a', 's', () =>
    store.save('t', { ...record, runId: 'mismatch' }),
  );
  await store.delete('b', 's');
  expect(await scoped('b', 's', () => store.load('s'))).toBeUndefined();
  expect((await scoped('a', 's', () => store.load('s')))?.runId).toBe('as');
  expect((await scoped('a', 't', () => store.load('t')))?.runId).toBe('at');
});
it('memory save sweeps expired records even when they are never loaded', async () => {
  jest.useFakeTimers();
  try {
    const store = new MemoryRunRecordStore(10, 100);
    await scoped('a', 's', () => store.save('s', record));
    jest.advanceTimersByTime(101);
    await scoped('a', 't', () => store.save('t', record));
    expect(
      (store as unknown as { records: Map<string, unknown> }).records.size,
    ).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

it.each([
  'GetClass',
  'GetProgram',
  'CheckClass',
  'GetATCFindings',
  'RunATC',
  'RunUnitTest',
])('checker allows %s with developer roles', (name) => {
  runWithReadOnlyTools(() =>
    expect(() => assertToolAllowed(name, 'high', ['high'])).not.toThrow(),
  );
});
it.each([
  'CreateClass',
  'UpdateClass',
  'ActivateClass',
  'DeleteClass',
  'LockClass',
  'UnlockClass',
  'Mystery',
])('checker blocks %s even in readonly exposition', (name) => {
  runWithReadOnlyTools(() =>
    expect(() => assertToolAllowed(name, 'readonly', ['readonly'])).toThrow(
      /read.only/i,
    ),
  );
});
it('checker effect never bypasses role authorization', () => {
  runWithReadOnlyTools(() =>
    expect(() => assertToolAllowed('GetClass', 'high', ['readonly'])).toThrow(
      /roles grant/,
    ),
  );
});

it('tool annotations take precedence over names in checker scope only', () => {
  runWithReadOnlyTools(() => {
    expect(() =>
      assertToolAllowed('CreateClass', 'high', ['high'], {
        readOnlyHint: true,
        destructiveHint: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertToolAllowed('GetClass', 'high', ['high'], { readOnlyHint: false }),
    ).toThrow(/read.only/i);
    expect(() =>
      assertToolAllowed('GetClass', 'high', ['high'], {
        destructiveHint: true,
      }),
    ).toThrow(/read.only/i);
  });
  expect(() =>
    assertToolAllowed('GetClass', 'high', ['high'], { destructiveHint: true }),
  ).not.toThrow();
});
