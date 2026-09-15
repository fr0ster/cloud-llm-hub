import { guardedTask } from '../../srv/lib/guarded-task';

function recordingLog() {
  const warnings: Array<{ message: string; detail: unknown }> = [];
  return {
    warnings,
    log: {
      warn: (message: string, detail?: unknown) =>
        warnings.push({ message, detail }),
    },
  };
}

describe('a periodic task cannot take the process down', () => {
  it('a synchronous throw is logged, not thrown', () => {
    const { warnings, log } = recordingLog();
    const tick = guardedTask('collection sweep', log, () => {
      throw new Error('registry unavailable');
    });
    expect(() => tick()).not.toThrow();
    expect(warnings).toEqual([
      {
        message: 'collection sweep failed',
        detail: { error: 'registry unavailable' },
      },
    ]);
  });

  it('a rejected promise is logged, not left unhandled', async () => {
    const { warnings, log } = recordingLog();
    const tick = guardedTask('session forget', log, async () => {
      throw new Error('store busy');
    });
    tick();
    await new Promise((r) => setImmediate(r));
    expect(warnings).toEqual([
      { message: 'session forget failed', detail: { error: 'store busy' } },
    ]);
  });

  it('a task that succeeds logs nothing and runs every tick', async () => {
    const { warnings, log } = recordingLog();
    let runs = 0;
    const tick = guardedTask('ok', log, () => {
      runs++;
    });
    tick();
    tick();
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(2);
    expect(warnings).toEqual([]);
  });
});
