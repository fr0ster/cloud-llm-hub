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
