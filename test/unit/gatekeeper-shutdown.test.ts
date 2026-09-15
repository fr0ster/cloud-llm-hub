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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
});

describe('shutdown', () => {
  it('aborts every admitted session and every waiter', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '1';
    clearGatekeeperConfig();
    gatekeeper.resetGatekeeperForTest();
    const first = await gatekeeper.admitPipeline('u', 'A');
    if (!('admitted' in first)) throw new Error('refused');
    const waiting = gatekeeper.admitPipeline('u', 'B');
    waiting.catch(() => {});

    expect(first.admitted.signal?.aborted).toBe(false);
    gatekeeper.shutdownGatekeeper();
    expect(first.admitted.signal?.aborted).toBe(true);
    await expect(waiting).rejects.toThrow('shutdown');
  });

  it('is a no-op with no door', () => {
    expect(() => gatekeeper.shutdownGatekeeper()).not.toThrow();
  });

  it('is hooked to CAP shutdown', () => {
    const src = readFileSync(join(__dirname, '../../srv/server.ts'), 'utf8');
    expect(src).toMatch(
      /cds\.on\(\s*'shutdown'[\s\S]{0,120}shutdownGatekeeper\(\)/,
    );
  });
});
