jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import type { ThrottleContext } from '@mcp-abap-adt/llm-agent';
import { clearAgentConfig, loadAgentConfig } from '../../srv/agent-config';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  WaitAsNeeded,
  withThrottleCall,
} from '../../srv/lib/throttle-strategy';

beforeEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  delete process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
  clearGatekeeperConfig();
  clearAgentConfig();
});

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  delete process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS;
  clearGatekeeperConfig();
  clearAgentConfig();
});

describe('the throttle strategy follows the door', () => {
  it('waits as told when a door protects capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-needed');
  });

  it('waits as needed with no door', () => {
    expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-needed');
  });
});

describe('an admitted session and a 429', () => {
  const strategy = new WaitAsNeeded();
  const ctx = (retryAfterSeconds?: number) =>
    ({
      attempt: 1,
      retryAfterSeconds,
      waitedMs: 0,
      source: 'response',
    }) as ThrottleContext;

  it('waits out exactly what the server named, past the old twenty-second ceiling', () => {
    expect(strategy.decide(ctx(45))).toMatchObject({
      retry: true,
      waitMs: 45_000,
    });
  });

  it('uses exponential backoff with jitter and caps each wait', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const waits = Array.from(
      { length: 6 },
      (_, i) => strategy.decide({ ...ctx(), attempt: i + 1 }).waitMs,
    );
    expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    expect(strategy.decide({ ...ctx(), attempt: 7 })).toEqual({
      waitMs: 0,
      retry: false,
      reason: 'no-interval',
    });
    jest.restoreAllMocks();
  });

  it('counts only unnamed waits within each call', () => {
    withThrottleCall(() => {
      for (let attempt = 1; attempt <= 6; attempt++) {
        expect(strategy.decide({ ...ctx(90), attempt }).retry).toBe(true);
        expect(strategy.decide({ ...ctx(), attempt: attempt + 20 }).retry).toBe(
          true,
        );
      }
      expect(strategy.decide({ ...ctx(), attempt: 30 }).reason).toBe(
        'no-interval',
      );
    });
    withThrottleCall(() => expect(strategy.decide(ctx()).retry).toBe(true));
  });

  it('honours the jitter range without exceeding sixty seconds', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(strategy.decide(ctx()).waitMs).toBe(1600);
    jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(strategy.decide(ctx()).waitMs).toBe(2400);
    expect(strategy.decide({ ...ctx(), attempt: 6 }).waitMs).toBe(60000);
    jest.restoreAllMocks();
  });
});

it('keeps an explicitly configured ceiling without a door', () => {
  process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '20000';
  expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-if-short-enough');
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
  clearGatekeeperConfig();
  expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-needed');
});
