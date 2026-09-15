import {
  clearGatekeeperConfig,
  describeGatekeeperConfig,
  loadGatekeeperConfig,
} from '../../srv/lib/gatekeeper-config';

const VARS = [
  'LLM_GATEKEEPER_MAX_LIVE_SESSIONS',
  'LLM_GATEKEEPER_QUEUE_LENGTH',
  'LLM_GATEKEEPER_MAX_RETAINED_SESSIONS',
] as const;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  clearGatekeeperConfig();
});

describe('absent means off', () => {
  it('configures nothing when nothing is set', () => {
    expect(loadGatekeeperConfig()).toEqual({
      maxLiveSessions: undefined,
      queueLength: undefined,
      maxRetainedSessions: undefined,
    });
  });

  it('treats a blank value as unset', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '  ';
    expect(loadGatekeeperConfig().maxLiveSessions).toBeUndefined();
  });
});

describe('the queue is derived from the capacity', () => {
  it('defaults to the capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    expect(loadGatekeeperConfig()).toMatchObject({
      maxLiveSessions: 4,
      queueLength: 4,
    });
  });

  it('takes an explicit length', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    process.env.LLM_GATEKEEPER_QUEUE_LENGTH = '2';
    expect(loadGatekeeperConfig().queueLength).toBe(2);
  });

  it('refuses a queue with no door in front of it', () => {
    process.env.LLM_GATEKEEPER_QUEUE_LENGTH = '2';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_QUEUE_LENGTH[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });
});

describe('malformed means refuse to start, naming the variable', () => {
  for (const v of VARS) {
    for (const bad of ['0', '-1', '2.5', 'four', '1e3x']) {
      it(`${v}=${bad}`, () => {
        process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '8';
        process.env[v] = bad;
        expect(() => loadGatekeeperConfig()).toThrow(new RegExp(v));
      });
    }
  }
});

describe('a positive integer is digits and nothing else', () => {
  // `Number()` reads every one of these as a whole number, so each would have
  // configured a limit nobody wrote down: sixteen slots from "0x10", a thousand
  // from "1e3".
  for (const v of VARS) {
    for (const bad of ['0x10', '1e3', ' 5', '5 ', '5.0', '+5', '0b11']) {
      it(`${v}=${JSON.stringify(bad)}`, () => {
        process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '8';
        process.env[v] = bad;
        expect(() => loadGatekeeperConfig()).toThrow(new RegExp(v));
      });
    }
  }

  it('still reads plain digits', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '12';
    expect(loadGatekeeperConfig().maxLiveSessions).toBe(12);
  });
});

describe('retention requires a capacity and may not be smaller than it', () => {
  it('refuses retention without a capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '10';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_MAX_RETAINED_SESSIONS[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });

  it('refuses retention below capacity, naming both', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '5';
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '2';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_MAX_RETAINED_SESSIONS[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });

  it('accepts retention equal to capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '5';
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '5';
    expect(loadGatekeeperConfig().maxRetainedSessions).toBe(5);
  });
});

describe('describeGatekeeperConfig', () => {
  it('says what is off rather than printing nothing', () => {
    expect(describeGatekeeperConfig({})).toEqual({
      door: 'off (execute_step keeps its semaphore of two)',
      queueLength: 'none',
      retainedSessions: 'unbounded',
    });
  });

  it('prints the values in force', () => {
    expect(
      describeGatekeeperConfig({
        maxLiveSessions: 4,
        queueLength: 4,
        maxRetainedSessions: 40,
      }),
    ).toEqual({ door: 4, queueLength: 4, retainedSessions: 40 });
  });
});
