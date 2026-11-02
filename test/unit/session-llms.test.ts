import { resetQuotaGates, runWithThrottleRetry } from '@mcp-abap-adt/llm-agent';
import { SessionLlms } from '../../srv/lib/session-llms';
import { WaitAsNeeded } from '../../srv/lib/throttle-strategy';

it('isolates Retry-After across sessions while calls in one session wait together', async () => {
  jest.useFakeTimers();
  const a = new SessionLlms();
  const b = new SessionLlms();
  let attempts = 0;
  const call = (owner: SessionLlms, run: () => Promise<string>) =>
    runWithThrottleRetry(run, {
      key: `fake:${owner.quotaScope}:model`,
      strategy: new WaitAsNeeded(),
      isThrottled: (error) => error instanceof Error && error.message === '429',
      retryAfterSeconds: () => 2,
    });
  try {
    const first = call(a, async () => {
      if (++attempts === 1) throw new Error('429');
      return 'a';
    });
    await jest.advanceTimersByTimeAsync(0);
    const same = jest.fn(async () => 'same');
    const second = call(a, same);
    await expect(call(b, async () => 'b')).resolves.toBe('b');
    await jest.advanceTimersByTimeAsync(1999);
    expect(same).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('same');
  } finally {
    resetQuotaGates();
    jest.useRealTimers();
  }
});

it('rejects lazy client creation after session disposal', async () => {
  const owner = new SessionLlms();
  owner.dispose();
  const create = jest.fn();
  await expect(owner.get('model', create)).rejects.toThrow('closed');
  expect(create).not.toHaveBeenCalled();
});
