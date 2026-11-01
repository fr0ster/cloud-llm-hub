import {
  currentCoordinatorRun,
  withCoordinatorRun,
} from '../../srv/lib/coordinator-tools-client';

it('loads without the dialogue connection and environment graph', () => {
  expect(
    Object.keys(require.cache).filter((file) =>
      /[\\/]srv[\\/](?:lib[\\/]dialogue-sessions|env-setup)\.[jt]s$/.test(file),
    ),
  ).toEqual([]);
});

it('captures each dialogue admission runner across asynchronous planner preparation', async () => {
  const first = new AbortController().signal;
  const second = new AbortController().signal;
  const capture = (signal: AbortSignal) =>
    withCoordinatorRun(
      (run) => run(signal),
      async () => {
        await Promise.resolve();
        return currentCoordinatorRun();
      },
    );
  const runners = await Promise.all([capture(first), capture(second)]);
  for (const [index, run] of runners.entries()) {
    await run(async (signal) => {
      expect(signal).toBe([first, second][index]);
      return { ok: true };
    });
  }
  await expect(
    currentCoordinatorRun()(async () => ({ ok: true })),
  ).rejects.toThrow('Session execution scope required');
});
