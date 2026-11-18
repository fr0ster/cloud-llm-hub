jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import {
  runWithThrottleRetry,
  type ThrottleContext,
} from '@mcp-abap-adt/llm-agent';
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
  const ctx = (retryAfterSeconds?: number): ThrottleContext => ({
    attempt: 1,
    retryAfterSeconds,
    waitedMs: 0,
    source: 'response',
  });

  it('waits out exactly what the server named, past the old twenty-second ceiling', () => {
    expect(
      strategy.decide({ ...ctx(90), attempt: 30, waitedMs: 600_000 }),
    ).toEqual({
      retry: true,
      waitMs: 90_000,
    });
    expect(strategy.decide(ctx(0))).toEqual({ retry: true, waitMs: 0 });
  });

  it('uses exponential backoff with jitter and caps each wait', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const waits = Array.from(
      { length: 6 },
      (_, i) => strategy.decide({ ...ctx(), attempt: i + 1 }).waitMs,
    );
    expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    expect(strategy.decide({ ...ctx(), attempt: 100 })).toEqual({
      waitMs: 60_000,
      retry: true,
    });
    jest.restoreAllMocks();
  });

  it('counts only unnamed waits within each call', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      withThrottleCall(() => {
        expect(strategy.decide({ ...ctx(90), attempt: 20 }).waitMs).toBe(
          90_000,
        );
        expect(strategy.decide({ ...ctx(), attempt: 21 }).waitMs).toBe(2_000);
        expect(strategy.decide({ ...ctx(90), attempt: 22 }).waitMs).toBe(
          90_000,
        );
        expect(strategy.decide({ ...ctx(), attempt: 23 }).waitMs).toBe(4_000);
      });
      withThrottleCall(() => expect(strategy.decide(ctx()).waitMs).toBe(2_000));
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('honours the jitter range without exceeding sixty seconds', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(strategy.decide(ctx()).waitMs).toBe(1600);
    jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(strategy.decide(ctx()).waitMs).toBe(2400);
    expect(strategy.decide({ ...ctx(), attempt: 6 }).waitMs).toBe(60000);
    jest.restoreAllMocks();
  });

  it('keeps retrying unnamed 429s past six waits until the caller aborts', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const controller = new AbortController();
      const refusal = new Error('HTTP 429');
      const request = jest.fn(async () => {
        throw refusal;
      });
      const rejection = expect(
        runWithThrottleRetry(request, {
          key: 'unnamed-429-abort',
          strategy,
          isThrottled: (error) => error === refusal,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await jest.advanceTimersByTimeAsync(400_000);
      expect(request.mock.calls.length).toBeGreaterThan(7);
      controller.abort();
      await rejection;
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});

it('keeps an explicitly configured ceiling without a door', () => {
  process.env.LLM_AGENT_THROTTLE_MAX_WAIT_MS = '20000';
  expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-if-short-enough');
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
  clearGatekeeperConfig();
  expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-needed');
});
