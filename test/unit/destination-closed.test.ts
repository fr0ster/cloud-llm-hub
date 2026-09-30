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
// Also test-controllable, not a fixed `() => []`: the corpus-build-failure
// regression test below needs this to THROW — `listToolDefsFromExporter()`
// calls it synchronously inside `ensureSharedToolsVectorized`, whose
// rejection escapes `initDestination`'s own try/catch entirely (it is
// awaited before that try begins), which is exactly the shape that froze
// the probe loop before this fix.
const mockCloudLocalToolsState: { impl: () => unknown[] } = {
  impl: () => [],
};
jest.mock('../../srv/lib/cloud-local-tools', () => ({
  ...jest.requireActual('../../srv/lib/cloud-local-tools'),
  mergeCloudLocalTools: () => mockCloudLocalToolsState.impl(),
}));

const load = () => {
  jest.resetModules();
  const m =
    require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
  // Fresh module registry: the providers go into this copy of agent-manager.
  (
    require('./helpers/providers') as typeof import('./helpers/providers')
  ).initInMemoryProviders();
  return m;
};

let current: ReturnType<typeof load> | undefined;

afterEach(() => {
  // closeDestination arms a five-minute probe timer. Left running, Jest either
  // reports an open handle or waits on it after the suite has finished.
  current?.clearDestinationStatesForTest();
  current = undefined;
  jest.resetModules();
  jest.useRealTimers();
  // A test that swaps these in to control a `runProbe` run must not leak
  // that behaviour into the next test in the file.
  mockResolverState.impl = async () => ({});
  mockCloudLocalToolsState.impl = () => [];
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

  it('clears the stamp on every destination awaiting re-probe, not just the one the loop has reached', async () => {
    jest.useFakeTimers();
    const mod = load();
    current = mod;

    // D1's re-probe stays pending until released, so the loop is still on
    // D1 (destinations are visited in the `Map`'s insertion order) when we
    // check D2 below — D2 is waiting its turn, not yet reached.
    let releaseFirst: (() => void) | undefined;
    mockResolverState.impl = () =>
      new Promise((_resolve, reject) => {
        releaseFirst = () => reject(new Error('unreachable: forced'));
      });

    mod.closeDestination('D1', 'first');
    mod.closeDestination('D2', 'second');
    // Both stamped before the timer fires (the earlier "same deadline" test
    // above covers this half already).
    expect(mod.retryAfterForDestination('D1')).toBeDefined();
    expect(mod.retryAfterForDestination('D2')).toBeDefined();

    // Fire the timer: the run starts, clears the stamp on every destination
    // it is ABOUT to re-probe up front, then blocks on D1's resolver.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(releaseFirst).toBeDefined();

    // D2's stale stamp must already be gone, even though the loop has not
    // reached D2 yet — a stamp from the timer that just fired is already in
    // the past, whichever destination it belongs to.
    expect(mod.retryAfterForDestination('D2')).toBeUndefined();

    // Let the run finish and clean up.
    releaseFirst?.();
    await jest.advanceTimersByTimeAsync(0);
  });

  it('resets and re-arms after a failed run, instead of freezing the probe loop forever', async () => {
    jest.useFakeTimers();
    const mod = load();
    current = mod;

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    // Simulate the shared tool corpus build failing (e.g. the embedder is
    // down): this throw happens INSIDE `ensureSharedToolsVectorized`, which
    // `initDestination` awaits before its own try/catch begins, so it
    // escapes uncaught all the way up through `ensureDestinationInit` into
    // `runProbe` — exactly the shape that, before this fix, left
    // `probeRunning` stuck `true` and turned into an unhandled rejection
    // (`setTimeout(runProbe, ...)` drops the returned promise).
    mockCloudLocalToolsState.impl = () => {
      throw new Error('corpus build down');
    };

    mod.closeDestination('D1', 'first');
    expect(mod.isProbeTimerArmedForTest()).toBe(true);

    // Fire the timer: the run throws, catches its own failure, resets
    // `probeRunning`, and — since D1 is still `unreachable` — re-arms, all
    // within this one drained await.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    // The failed run still reset itself and re-armed its own timer.
    expect(mod.isProbeTimerArmedForTest()).toBe(true);

    // And it left no stuck flag behind: a destination closed afterward gets
    // a real stamp, not silence for the rest of the process's life.
    mod.closeDestination('D2', 'second');
    expect(mod.retryAfterForDestination('D2')).toBeDefined();

    // Give the unhandled-rejection detector (which Node defers by a turn)
    // a chance to fire before checking it did not.
    await Promise.resolve();
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandledRejection);
    expect(unhandled).toEqual([]);
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
