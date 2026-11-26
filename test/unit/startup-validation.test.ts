import { createServer } from 'node:http';
import { InMemoryRagProvider } from '@mcp-abap-adt/llm-agent';
import express, { type Request, type Response } from 'express';

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
const agentProfiles = { collectionId: 'agents', plannerRecord: 'coordinator' };
let profiles: typeof agentProfiles | undefined;
const getAgentConfig = jest.fn(() => ({
  rag: { backends: { session: 'vector' } },
  profiles,
}));
jest.mock('../../srv/agent-config', () => ({
  ensureAiCoreCredentials,
  getAgentConfig,
}));
const order: string[] = [];
// What the mocked collectionsRestoreStatus answers; /health maps it.
const restoreStatus: { value: { state: string; error?: string } } = {
  value: { state: 'off' },
};
// Set by a test to make the provider startup reject.
const providersFailure: { error?: Error } = {};
const agentsFailure: { error?: Error } = {};
const migrationFailure = { failed: false };
let collectionProvider: InMemoryRagProvider | undefined;
let sessionProvider: InMemoryRagProvider | undefined;
const seedAgentConfiguration = jest.fn(async () => {});
const createAgentMcpServerForRequest = jest.fn(async () => ({
  transport: {
    async handleRequest(_req: Request, res: Response) {
      res.json({ ready: true });
    },
  },
  async cleanup() {},
}));
jest.mock('../../srv/lib/rag-migration', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/rag-migration')>(
    '../../srv/lib/rag-migration',
  ),
  isRagMigrationReady: () =>
    order.includes('migrateRagData') && !migrationFailure.failed,
  runStartMigrations: async () => {
    order.push('migrateRagData');
    return migrationFailure.failed
      ? { ok: false, error: new Error('RAG migration reported findings') }
      : { ok: true, value: undefined };
  },
}));
jest.mock('../../srv/lib/providers', () => ({
  startProviders: async () => {
    order.push('startProviders');
    if (providersFailure.error) throw providersFailure.error;
    return {
      collections: collectionProvider,
      embedding: { fingerprint: COMMITTED_BUNDLE_FINGERPRINT },
      stores: {
        backendOf: (scope: string) =>
          scope === 'persistent' && collectionProvider
            ? 'hana-vector'
            : scope === 'session' && sessionProvider
              ? 'pg-vector'
              : 'in-memory',
      },
    };
  },
}));
jest.mock('../../srv/agent-manager', () => ({
  historyProvider: () => sessionProvider,
  initProviders: () => order.push('initProviders'),
  isProvidersReady: () => order.includes('initProviders'),
  // Initialisation fails here, as it does when AI Core is not reachable yet.
  initSmartAgents: () => {
    order.push('initSmartAgents');
    return Promise.reject(
      agentsFailure.error ?? new Error('AI Core not reachable'),
    );
  },
  getCollectionRegistry: () => ({
    sweepExpiredSessions: () => {},
    seedAgentConfiguration,
  }),
  startCollectionRestore: () => {
    order.push('startCollectionRestore');
    return Promise.resolve();
  },
  collectionsRestoreStatus: () => restoreStatus.value,
}));
jest.mock('../../srv/agent-mcp', () => ({ createAgentMcpServerForRequest }));
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
  requireLongSession: () => () => {},
}));
jest.mock('../../srv/lib/gatekeeper-metrics', () => ({
  installThrottleObserver: () => {},
}));
jest.mock('../../srv/lib/gatekeeper', () => ({}));

import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { COMMITTED_BUNDLE_FINGERPRINT } from '../../srv/lib/tool-corpus';

require('../../srv/server');

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  collectionProvider = undefined;
  sessionProvider = undefined;
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

it('mounts the migration guard before every bootstrap route and middleware', async () => {
  order.length = 0;
  const app = express();
  const originalUse = app.use.bind(app);
  // Keep the first middleware real; later handlers are mocked in this suite.
  const use = jest
    .spyOn(app, 'use')
    .mockReturnValue(app)
    .mockImplementationOnce(originalUse);
  const get = jest.spyOn(app, 'get').mockReturnValue(app);
  const post = jest.spyOn(app, 'post').mockReturnValue(app);
  const options = jest.spyOn(app, 'options').mockReturnValue(app);
  handlers.bootstrap(app);
  expect(use.mock.calls[0]).toHaveLength(1);
  expect(typeof use.mock.calls[0][0]).toBe('function');
  const firstUse = use.mock.invocationCallOrder[0];
  for (const calls of [get, post, options]) {
    expect(calls.mock.invocationCallOrder[0]).toBeGreaterThan(firstUse);
  }
  use.mockRestore();
  get.mockRestore();
  post.mockRestore();
  options.mockRestore();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing address');
    for (const route of [
      '/mcp/stream/http',
      '/V1/session',
      '/HEALTH',
      '/missing',
    ]) {
      expect(
        (
          await fetch(`http://127.0.0.1:${address.port}${route}`, {
            method: 'POST',
          })
        ).status,
      ).toBe(503);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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

describe('GET /health', () => {
  function health(): (req: unknown, res: unknown) => void {
    const gets: unknown[][] = [];
    const app = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            if (method === 'get') gets.push(args);
          },
      },
    );
    handlers.bootstrap(app);
    const route = gets.find((g) => g[0] === '/health');
    if (!route) throw new Error('no /health route was registered');
    return route[1] as (req: unknown, res: unknown) => void;
  }

  function call(state: { state: string; error?: string }) {
    restoreStatus.value = state;
    const out: { status: number; body: unknown } = { status: 0, body: null };
    const res = {
      status: (code: number) => {
        out.status = code;
        return res;
      },
      json: (b: unknown) => {
        out.body = b;
        return res;
      },
    };
    health()({}, res);
    return out;
  }

  afterEach(() => {
    restoreStatus.value = { state: 'off' };
  });

  it('200 { status: UP } when nothing persists, as CAP answers', () => {
    expect(call({ state: 'off' })).toEqual({
      status: 200,
      body: { status: 'UP' },
    });
  });

  it('503 with the state and cause while the restore has not succeeded', () => {
    expect(call({ state: 'pending' })).toEqual({
      status: 503,
      body: { status: 'DOWN', collections: { state: 'pending' } },
    });
    expect(call({ state: 'failed', error: 'connect ECONNREFUSED' })).toEqual({
      status: 503,
      body: {
        status: 'DOWN',
        collections: { state: 'failed', error: 'connect ECONNREFUSED' },
      },
    });
  });

  it('200 once restored', () => {
    expect(call({ state: 'ready' })).toEqual({
      status: 200,
      body: { status: 'UP' },
    });
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
  it('holds the agent MCP HTTP request until built-in profiles finish synchronizing', async () => {
    const profileSeeds = await import('../../srv/lib/agent-profile-seeds');
    const route = '/mcp/agent/stream/http';
    profiles = agentProfiles;
    let finish = () => {};
    const pendingSeed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    seedAgentConfiguration.mockImplementationOnce(() => pendingSeed);
    const createWaiter = profileSeeds.createAgentProfileWaiter;
    let entered = () => {};
    const enteredWait = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = jest
      .spyOn(profileSeeds, 'createAgentProfileWaiter')
      .mockImplementation((synchronization) => {
        const wait = createWaiter(synchronization);
        return (signal) => {
          entered();
          return wait(signal);
        };
      });
    const app = express();
    const post = app.post.bind(app);
    const use = app.use.bind(app);
    const useSpy = jest
      .spyOn(app, 'use')
      .mockReturnValue(app)
      .mockImplementationOnce(use);
    const postSpy = jest
      .spyOn(app, 'post')
      .mockImplementation((path, ...callbacks) =>
        path === route ? post(path, ...callbacks) : app,
      );
    const getSpy = jest.spyOn(app, 'get').mockReturnValue(app);
    const optionsSpy = jest.spyOn(app, 'options').mockReturnValue(app);
    const server = createServer(app);
    try {
      handlers.bootstrap(app);
      useSpy.mockRestore();
      postSpy.mockRestore();
      getSpy.mockRestore();
      optionsSpy.mockRestore();
      handlers.served();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing address');
      const response = fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: 'POST',
      });
      await Promise.race([
        enteredWait,
        response.then(() => {
          throw new Error('HTTP request returned before waiting for profiles');
        }),
      ]);
      expect(createAgentMcpServerForRequest).not.toHaveBeenCalled();
      finish();
      expect((await response).status).toBe(200);
      expect(seedAgentConfiguration).toHaveBeenCalledWith(
        'agents',
        'coordinator',
      );
      expect(createAgentMcpServerForRequest).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      wait.mockRestore();
      profiles = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
      'migrateRagData',
      'registerRagRoutes',
      'startCollectionRestore',
      'initSmartAgents',
    ]);
    expect(exits).toEqual([]);
  });

  it('exits non-zero on migration findings before routes, restore or agents', async () => {
    migrationFailure.failed = true;
    try {
      expect(await runServed()).toEqual([1]);
      expect(order).toEqual([
        'startProviders',
        'initProviders',
        'migrateRagData',
      ]);
    } finally {
      migrationFailure.failed = false;
    }
  });

  it('checks both persistent catalogs after migration and exits on a stale session store', async () => {
    collectionProvider = new InMemoryRagProvider({ name: 'collections' });
    sessionProvider = new InMemoryRagProvider({
      name: 'session-history',
      supportedScopes: ['global'],
    });
    const created = await sessionProvider.createCollection('h_planner_memory', {
      scope: 'global',
    });
    if (!created.ok) throw created.error;
    for (const provider of [collectionProvider, sessionProvider]) {
      const describe = provider.describeCollections.bind(provider);
      jest.spyOn(provider, 'describeCollections').mockImplementation(() => {
        order.push(provider.name);
        return describe();
      });
    }

    expect(await runServed()).toEqual([1]);
    expect(order).toEqual([
      'startProviders',
      'initProviders',
      'migrateRagData',
      'collections',
      'session-history',
    ]);
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
