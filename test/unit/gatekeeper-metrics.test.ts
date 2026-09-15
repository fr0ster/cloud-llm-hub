jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

const observers: Array<(e: unknown) => void> = [];
jest.mock('@mcp-abap-adt/llm-agent', () => ({
  ...jest.requireActual('@mcp-abap-adt/llm-agent'),
  setThrottleObserver: (fn: (e: unknown) => void) => observers.push(fn),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  clearGatekeeperMetrics,
  gatekeeperSnapshot,
  installThrottleObserver,
  recordDestinationRefusal,
} from '../../srv/lib/gatekeeper-metrics';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

afterEach(() => {
  configure();
  clearGatekeeperMetrics();
});

describe('the door scope', () => {
  it('says it is off when no capacity is configured', () => {
    expect(gatekeeperSnapshot().door).toEqual({ configured: false });
  });

  it('counts live sessions and refusals by reason', async () => {
    configure(1, 1);
    const held = await gatekeeper.admitPipeline('u', 'A');
    void gatekeeper.admitPipeline('u', 'B');
    await new Promise((r) => setImmediate(r));
    await gatekeeper.admitPipeline('u', 'C');
    const door = gatekeeperSnapshot().door;
    expect(door).toMatchObject({
      live: 1,
      queued: 1,
      refusals: { capacity: 1 },
    });
    if ('admitted' in held) held.admitted.release();
  });
});

describe('the scopes do not mix', () => {
  it('a closed-destination refusal is not a door refusal', async () => {
    configure(2);
    recordDestinationRefusal('S4HANA_DEV');
    recordDestinationRefusal('S4HANA_DEV');
    const snap = gatekeeperSnapshot();
    expect(snap.destinations).toContainEqual(
      expect.objectContaining({ name: 'S4HANA_DEV', refusals: 2 }),
    );
    expect(snap.door).toMatchObject({
      refusals: { session_busy: 0, capacity: 0, retention: 0 },
    });
  });

  it('retention reports held, evictions and sessions awaiting cleanup', () => {
    expect(gatekeeperSnapshot().retention).toEqual(
      expect.objectContaining({ retained: 0, evictions: 0, closing: 0 }),
    );
  });
});

describe('the throttling scope', () => {
  it('counts what the provider observed, including a 429 with no interval', () => {
    installThrottleObserver();
    const observe = observers[observers.length - 1];
    const base = {
      strategy: 'wait-as-told',
      attempt: 1,
      waitMs: 0,
      waitedMs: 0,
    };
    observe({
      ...base,
      key: 'q1',
      source: 'response',
      retryAfterSeconds: 30,
      willRetry: true,
    });
    observe({
      ...base,
      key: 'q1',
      source: 'response',
      willRetry: false,
      reason: 'no-interval',
    });
    expect(gatekeeperSnapshot().throttling).toEqual({
      events: 2,
      gaveUp: 1,
      noInterval: 1,
      byQuota: { q1: 2 },
    });
  });
});

describe('wired where it is read and where it is counted', () => {
  const read = (f: string) =>
    readFileSync(join(__dirname, '../../srv', f), 'utf8');

  it('Health carries the snapshot', () => {
    expect(read('mcp-proxy.ts')).toMatch(
      /gatekeeper:\s*JSON\.stringify\(\s*gatekeeperSnapshot\(\)\s*\)/,
    );
    expect(read('mcp-proxy.cds')).toMatch(/gatekeeper\s*:\s*LargeString/);
  });

  it('the observer is installed at startup', () => {
    expect(read('server.ts')).toMatch(/installThrottleObserver\(\)/);
  });

  it('every channel counts the closed-destination refusals it sends', () => {
    for (const f of [
      'openai-handler.ts',
      'anthropic-handler.ts',
      'agent-mcp.ts',
    ]) {
      expect(read(f)).toMatch(/recordDestinationRefusal\(/);
    }
  });
});
