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

it.each(['explicit', 'ttl', 'shutdown'] as const)(
  'disposes registry clients on %s close, including failed cleanup',
  async (reason) => {
    const { LongSessionRegistry } = await import('../../srv/lib/long-session');
    const { longSessionLlms, runWithRequestLlms, sessionLlms } = await import(
      '../../srv/lib/session-llms'
    );
    const registry = new LongSessionRegistry(
      { ttlMs: 1, maxSessions: 10, maxPerUser: 10, queueLength: 1 },
      {
        onClose: async () => {
          throw new Error('cleanup failed');
        },
      },
    );
    const session = registry.open('alice', { key: 'same' });
    if ('refused' in session) throw new Error(session.refused);
    const owner = longSessionLlms(session);
    await runWithRequestLlms(session, async () => {
      expect(sessionLlms.getStore()).toBe(owner);
      await registry.run(session, async () => {
        expect(sessionLlms.getStore()).toBe(owner);
      });
    });
    await expect(registry.close('alice', 'same', reason)).rejects.toThrow(
      'cleanup failed',
    );
    await expect(owner.get('unused', jest.fn())).rejects.toThrow('closed');
  },
);

it.each([false, true])(
  'disposes a request owner after completion (failure: %s)',
  async (fails) => {
    const { runWithRequestLlms, sessionLlms } = await import(
      '../../srv/lib/session-llms'
    );
    let owner: SessionLlms | undefined;
    const result = runWithRequestLlms(undefined, async () => {
      owner = sessionLlms.getStore();
      expect(owner).toBeDefined();
      await runWithRequestLlms(undefined, async () =>
        expect(sessionLlms.getStore()).toBe(owner),
      );
      if (fails) throw new Error('request failed');
    });
    if (fails) await expect(result).rejects.toThrow('request failed');
    else await result;
    if (!owner) throw new Error('missing owner');
    await expect(owner.get('unused', jest.fn())).rejects.toThrow('closed');
    expect(sessionLlms.getStore()).toBeUndefined();
  },
);
