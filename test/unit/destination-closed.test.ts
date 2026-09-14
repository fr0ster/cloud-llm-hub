/**
 * The probe-in-flight tests below (`describe('one probe chain, not two')`)
 * fire the REAL 5-minute timer under fake timers and let `runProbe` run for
 * real, so its dependencies must not do real network/embedding work — that
 * would hang or slow every run of this file. Each mock keeps `initDestination`
 * fast and deterministic: an empty tool corpus (no vectorization loop, no
 * per-tool throttle `setTimeout`), no BTP lookup, and a destination resolver
 * whose behaviour a test controls directly. `mockResolverState`'s name-prefix
 * is required by Jest's mock-hoisting: a factory may reference an out-of-scope
 * variable only when its name starts with `mock`.
 */
const mockResolverState: { impl: (name: string) => Promise<unknown> } = {
  impl: async () => ({}),
};
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: (name: string) => mockResolverState.impl(name),
}));
jest.mock('../../srv/lib/btp-destinations', () => ({
  getAvailableDestinations: async () => [],
  clearDestinationsCache: () => {},
}));
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual('../../srv/agent-config'),
  getAgentConfig: () => ({
    llm: {
      provider: 'openai',
      apiKey: undefined,
      baseUrl: undefined,
      model: 'm',
      resourceGroup: undefined,
      temperature: 0.1,
      maxTokens: 100,
      whenThrottled: undefined,
    },
    mcp: { destination: 'DEST' },
    agent: { ragType: 'in-memory', mode: 'x', maxIterations: 5 },
  }),
}));
jest.mock('../../srv/lib/cloud-local-tools', () => ({
  ...jest.requireActual('../../srv/lib/cloud-local-tools'),
  mergeCloudLocalTools: () => [],
}));

const load = () => {
  jest.resetModules();
  return require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
};

let current: ReturnType<typeof load> | undefined;

afterEach(() => {
  // closeDestination arms a five-minute probe timer. Left running, Jest either
  // reports an open handle or waits on it after the suite has finished.
  current?.clearDestinationStatesForTest();
  current = undefined;
  jest.resetModules();
  jest.useRealTimers();
});

describe('a closed destination', () => {
  it('reports the remainder to the next probe, not the whole interval', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    mod.setNextProbeAtForTest('S4HANA_DEV', now + 12_000);
    // Refused eleven seconds before the tick: the honest answer is twelve
    // seconds, not three hundred.
    expect(mod.retryAfterForDestination('S4HANA_DEV', now)).toBe(12);
  });

  it('rounds up, because waking early walks back into the same refusal', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', now + 12_400);
    expect(mod.retryAfterForDestination('D', now)).toBe(13);
  });

  it('gives no number when no probe is scheduled', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', undefined);
    expect(mod.retryAfterForDestination('D', 1_000_000)).toBeUndefined();
  });

  it('leaves other destinations alone', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });

  it('stamps a destination closed while a timer is already pending with the same deadline as the first', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('D1', 'first');
    // D1's close armed a timer and stamped D1. D2 closes while that timer is
    // still pending — `scheduleUnreachableRetry` is then a no-op, so without
    // an explicit stamp here D2 would report no `Retry-After` until D1's
    // timer happens to fire.
    mod.closeDestination('D2', 'second');
    const now = Date.now();
    expect(mod.retryAfterForDestination('D2', now)).toBe(
      mod.retryAfterForDestination('D1', now),
    );
  });
});

describe('one probe chain, not two', () => {
  it('does not arm a second timer while a probe is in flight, and leaves a destination closed mid-run unstamped', async () => {
    jest.useFakeTimers();
    const mod = load();
    current = mod;

    // The resolver for D1's re-probe stays pending until the test releases
    // it, so `runProbe` is genuinely "in flight" — blocked inside
    // `ensureDestinationInit`, past the point where it clears its own timer
    // reference and long before it decides whether to re-arm.
    let releaseFirst: (() => void) | undefined;
    mockResolverState.impl = () =>
      new Promise((_resolve, reject) => {
        releaseFirst = () => reject(new Error('unreachable: forced'));
      });

    mod.closeDestination('D1', 'first');
    expect(mod.knownDestinations()).toContain('D1');
    // One timer armed by the close above.
    expect(mod.isProbeTimerArmedForTest()).toBe(true);

    // Fire the 5-minute timer and drain microtasks: `runProbe` starts,
    // clears its own timer reference, and blocks on the resolver mock —
    // nothing else in this chain uses a real timer (the tool corpus is
    // mocked empty, so there is no per-tool throttle wait), so this single
    // await reaches exactly that point.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(releaseFirst).toBeDefined();
    // The fired timer is consumed and nothing has re-armed it yet.
    expect(mod.isProbeTimerArmedForTest()).toBe(false);

    // A second destination closes while the run for D1 is still in flight.
    mod.closeDestination('D2', 'second');

    // The run in flight suppresses re-arming — still no timer, not two.
    expect(mod.isProbeTimerArmedForTest()).toBe(false);
    // And D2 is left unstamped: the running probe stamps or clears it
    // itself when it ends, not this call — from its own `now`.
    expect(mod.retryAfterForDestination('D2')).toBeUndefined();

    // Let the run finish: D1's re-probe fails, so it is still unreachable
    // and the run re-arms.
    releaseFirst?.();
    await jest.advanceTimersByTimeAsync(0);

    // Exactly one timer pending after the run ends — not the orphaned one
    // plus a second from a close that arrived mid-run.
    expect(mod.isProbeTimerArmedForTest()).toBe(true);
  });
});

describe('the classifier closes the destination it names', () => {
  it('turns an unavailability error into a closed destination', () => {
    const mod = load();
    current = mod;
    const { McpUnavailableError, isUnavailable } =
      require('../../srv/lib/mcp-outage') as typeof import('../../srv/lib/mcp-outage');
    const err = new McpUnavailableError(
      'S4HANA_DEV',
      'tunnel down',
      'tunnel_timeout',
    );
    expect(isUnavailable(err)).toBe(true);
    mod.closeDestination('S4HANA_DEV', err.message);
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });
});
