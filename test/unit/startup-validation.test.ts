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
const getAgentConfig = jest.fn(() => ({}));
jest.mock('../../srv/agent-config', () => ({
  ensureAiCoreCredentials,
  getAgentConfig,
}));
const order: string[] = [];
// Set by a test to make the provider startup reject.
const providersFailure: { error?: Error } = {};
jest.mock('../../srv/lib/providers', () => ({
  startProviders: async () => {
    order.push('startProviders');
    if (providersFailure.error) throw providersFailure.error;
    return {};
  },
}));
jest.mock('../../srv/agent-manager', () => ({
  initProviders: () => order.push('initProviders'),
  isProvidersReady: () => order.includes('initProviders'),
  // Initialisation fails here, as it does when AI Core is not reachable yet.
  initSmartAgents: () => {
    order.push('initSmartAgents');
    return Promise.reject(new Error('AI Core not reachable'));
  },
  getCollectionRegistry: () => ({
    sweepExpiredSessions: () => {},
  }),
}));
jest.mock('../../srv/agent-mcp', () => ({}));
jest.mock('../../srv/anthropic-handler', () => ({}));
jest.mock('../../srv/openai-handler', () => ({}));
jest.mock('../../srv/rag-handler', () => ({
  registerRagRoutes: () => order.push('registerRagRoutes'),
}));
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
    expect(getAgentConfig).not.toHaveBeenCalled();
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

describe('the /v1/rag gate', () => {
  it('answers 503 on /v1/rag/* until the providers are built, then passes', () => {
    order.length = 0;
    const uses: unknown[][] = [];
    const app = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            if (method === 'use') uses.push(args);
          },
      },
    );
    handlers.bootstrap(app);
    const probe = (path: string) => {
      const out = { status: 0, next: false };
      for (const [mount, fn] of uses) {
        if (mount !== '/v1' || typeof fn !== 'function' || fn.length !== 3)
          continue;
        const res = {
          status: (code: number) => {
            out.status = code;
            return res;
          },
          json: () => res,
        };
        try {
          fn({ path, headers: {} }, res, () => {
            out.next = true;
          });
        } catch {
          // express.json and the router are not the gate; skip them.
        }
        if (out.status) return out;
      }
      return out;
    };
    expect(probe('/rag/collections').status).toBe(503);
    expect(probe('/chat/completions').status).toBe(0);
    order.push('initProviders');
    expect(probe('/rag/collections').status).toBe(0);
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

  /** Runs `served` with timers stubbed and `process.exit` recorded. */
  async function runServed(): Promise<number[]> {
    order.length = 0;
    const exits: number[] = [];
    const timers = jest
      .spyOn(global, 'setInterval')
      .mockImplementation((() => ({
        unref: () => undefined,
      })) as unknown as typeof setInterval);
    const exit = jest.spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      exits.push(code ?? 0);
    }) as unknown as typeof process.exit);
    try {
      handlers.served();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    } finally {
      timers.mockRestore();
      exit.mockRestore();
    }
    return exits;
  }

  it('builds the providers, then the RAG routes, then warms the agents', async () => {
    // The mocked initSmartAgents rejects: an agent warm-up failure can be an
    // outage, so it is logged and retried, never a reason to exit.
    const exits = await runServed();
    expect(order).toEqual([
      'startProviders',
      'initProviders',
      'registerRagRoutes',
      'initSmartAgents',
    ]);
    expect(exits).toEqual([]);
  });

  it('exits non-zero when the providers cannot be built, and warms nothing', async () => {
    providersFailure.error = new Error('embedder package not installed');
    try {
      const exits = await runServed();
      expect(exits).toEqual([1]);
      expect(order).toEqual(['startProviders']);
    } finally {
      providersFailure.error = undefined;
    }
  });
});

describe("server.ts's bootstrap listener, configuration", () => {
  it('reads the agent configuration before it registers a route', () => {
    getAgentConfig.mockImplementationOnce(() => {
      throw new Error('LLM_AGENT_RAG_TYPE: unknown value');
    });
    const calls: string[] = [];
    const app = new Proxy(
      {},
      { get: (_t, method: string) => () => calls.push(method) },
    );
    expect(() => handlers.bootstrap(app)).toThrow(/LLM_AGENT_RAG_TYPE/);
    expect(calls).toEqual([]);
  });
});
