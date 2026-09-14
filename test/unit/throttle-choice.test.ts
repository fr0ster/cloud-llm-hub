jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { WaitAsTold } from '@mcp-abap-adt/llm-agent';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

beforeEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  clearAgentConfig();
});

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  clearAgentConfig();
});

describe('the throttle strategy follows the door', () => {
  it('waits as told when a door protects capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-told');
  });

  it('keeps the ceiling with no door, as today', () => {
    expect(loadAgentConfig().llm.whenThrottled.name).toBe(
      'wait-if-short-enough',
    );
  });
});

describe('an admitted session and a 429', () => {
  const strategy = new WaitAsTold();
  const ctx = (retryAfterSeconds?: number) =>
    ({
      attempt: 1,
      retryAfterSeconds,
      waitedMs: 0,
      source: 'response',
    }) as Parameters<WaitAsTold['decide']>[0];

  it('waits out exactly what the server named, past the old twenty-second ceiling', () => {
    expect(strategy.decide(ctx(45))).toMatchObject({
      retry: true,
      waitMs: 45_000,
    });
  });

  it('fails when the server named no interval — the one hole, kept a decision', () => {
    expect(strategy.decide(ctx(undefined)).retry).toBe(false);
  });
});
