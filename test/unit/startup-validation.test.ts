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
  getCollectionRegistry: () => ({}),
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
