/**
 * A malformed gatekeeper variable stops the service before it takes traffic.
 *
 * Two halves, because neither alone proves the promise. The first drives
 * `srv/server.ts`'s own `bootstrap` listener and shows it throws, naming the
 * variable, before it registers a single route. The second runs CAP's real
 * `cds_server` and shows that a throwing `bootstrap` listener rejects it — the
 * promise `cds serve` returns — before any server listens. Validation on
 * `served` would not do: that listener's rejection is caught and logged as
 * "will retry on first request", and the service came up answering 500.
 */

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
const ensureAiCoreCredentials = jest.fn();

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      on: (event: string, fn: (...args: unknown[]) => unknown) => {
        handlers[event] = fn;
      },
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      middlewares: { before: [() => {}, () => {}, () => {}] },
      context: undefined,
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-config', () => ({ ensureAiCoreCredentials }));
jest.mock('../../srv/agent-manager', () => ({
  // Initialisation fails here, as it does when AI Core is not reachable yet.
  initSmartAgents: () => Promise.reject(new Error('AI Core not reachable')),
  getCollectionRegistry: () => ({
    sweepExpiredSessions: () => {},
  }),
}));
jest.mock('../../srv/agent-mcp', () => ({}));
jest.mock('../../srv/anthropic-handler', () => ({}));
jest.mock('../../srv/openai-handler', () => ({}));
jest.mock('../../srv/rag-handler', () => ({ registerRagRoutes: () => {} }));
jest.mock('../../srv/mcp-manager', () => ({}));
jest.mock('../../srv/lib/basic-to-bearer', () => ({
  createBasicToBearerMiddleware: () => () => {},
}));
jest.mock('../../srv/lib/session-middleware', () => ({
  sessionMiddleware: () => () => {},
}));
jest.mock('../../srv/lib/gatekeeper-metrics', () => ({
  installThrottleObserver: () => {},
}));
jest.mock('../../srv/lib/gatekeeper', () => ({}));

import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

require('../../srv/server');

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
});

describe("server.ts's bootstrap listener", () => {
  it('throws, naming the variable, before it registers anything', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '0x10';
    clearGatekeeperConfig();
    // Every Express method the listener could reach, each recorded.
    const calls: string[] = [];
    const app = new Proxy(
      {},
      {
        get: (_t, method: string) => () => calls.push(method),
      },
    );

    expect(() => handlers.bootstrap(app)).toThrow(
      /LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
    expect(calls).toEqual([]);
    expect(ensureAiCoreCredentials).not.toHaveBeenCalled();
  });
});

describe("CAP's cds_server", () => {
  it('rejects, without listening, when a bootstrap listener throws', async () => {
    const realCds = jest.requireActual('@sap/cds');
    const cdsServer = jest.requireActual('@sap/cds/server.js');
    const boom = new Error('Invalid LLM_GATEKEEPER_MAX_LIVE_SESSIONS');
    const listener = () => {
      throw boom;
    };
    realCds.on('bootstrap', listener);
    const listen = jest.fn();
    try {
      await expect(
        cdsServer({ app: { use: jest.fn(), get: jest.fn(), listen } }),
      ).rejects.toBe(boom);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      realCds.off('bootstrap', listener);
    }
  });
});

describe('the /v1 CORS preflight', () => {
  it('does not advertise X-Session-Id, which no route reads any more', () => {
    const registered: Array<{ method: string; args: unknown[] }> = [];
    const app = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            registered.push({ method, args });
          },
      },
    );
    handlers.bootstrap(app);
    const preflight = registered.find(
      (r) => r.method === 'options' && r.args[0] === '/v1/{*path}',
    );
    if (!preflight) throw new Error('no /v1 preflight was registered');
    const headers: Record<string, string> = {};
    (preflight.args[1] as (req: unknown, res: unknown) => void)(
      {},
      {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
        writeHead() {},
        end() {},
      },
    );
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(headers['Access-Control-Allow-Headers']).not.toMatch(
      /x-session-id/i,
    );
  });
});

describe("server.ts's served listener", () => {
  it('starts both session sweeps even when initialisation fails', async () => {
    // Started inside the success path, neither sweep ever ran on an instance
    // whose first initialisation failed: expired session collections and
    // sessions holding nothing were kept until restart.
    const periods: number[] = [];
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(((
      _fn: () => void,
      ms?: number,
    ) => {
      periods.push(ms ?? 0);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval);
    try {
      handlers.served();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(periods).toEqual(
        expect.arrayContaining([60 * 60 * 1000, 5 * 60 * 1000]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
