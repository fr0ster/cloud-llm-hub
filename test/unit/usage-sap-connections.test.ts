import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IUsageSink } from '@mcp-abap-adt/llm-agent';
import type { IUsageReader } from '@mcp-abap-adt/llm-usage';
import { memorySink } from '@mcp-abap-adt/llm-usage';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import express from 'express';
import ts from 'typescript';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { runActiveDestinationProbe } from '../../srv/lib/active-probe';
import { buildConnectionForDestination } from '../../srv/lib/background-connection';
import type { LongSession } from '../../srv/lib/long-session';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  establishRequestConnection,
  safeStop,
} from '../../srv/lib/request-connection';
import {
  acquireSessionConnection,
  dropSessionConnection,
  releaseRequestConnection,
} from '../../srv/lib/session-connection';
import {
  SessionConnectionFactory,
  SessionConnectionPool,
} from '../../srv/lib/session-connection-pool';
import { readUsageConfig } from '../../srv/lib/usage/config';
import {
  processCounters,
  startProcessMeter,
} from '../../srv/lib/usage/process-meter';
import {
  processConnectionClosed,
  processConnectionCount,
  processConnectionOpened,
} from '../../srv/lib/usage/process-resources';
import { initUsage } from '../../srv/lib/usage/runtime';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

type ServerOptions = ConstructorParameters<
  typeof import('@mcp-abap-adt/lib/embeddable').EmbeddableMcpServer
>[0];
const optionsSeen: ServerOptions[] = [];
const connections: ReturnType<typeof makeConnection>[] = [];
let failConnect = false;
let failClose = false;
let duringWarmup: () => Promise<void> = async (): Promise<void> => {};
let duringProbe: () => void = (): void => {};
function makeConnection() {
  return {
    connect: jest.fn(async (): Promise<void> => {
      if (failConnect) throw new Error('connect failed');
    }),
    disconnect: jest.fn(async (): Promise<void> => {}),
    close: jest.fn(async (): Promise<void> => {
      if (failClose) throw new Error('close failed');
    }),
    closeSession: jest.fn(async (): Promise<void> => {
      if (failClose) throw new Error('close failed');
    }),
    probe: async (
      _path: string,
    ): Promise<{ httpCode: number; rawMessage: string }> => {
      duringProbe();
      return { httpCode: 200, rawMessage: '' };
    },
    reset: (): void => {},
    getBaseUrl: async (): Promise<string> => 'http://sap',
    getSessionId: (): string => 'test',
    setSessionType: (): void => {},
    makeAdtRequest: async (): Promise<never> => {
      throw new Error('unused');
    },
  };
}
jest.mock('../../srv/env-setup', (): object => ({}));
jest.mock('@sap-cloud-sdk/http-client', (): object => ({
  executeHttpRequest: jest.fn(),
}));
jest.mock('@sap/cds', (): object => ({
  __esModule: true,
  default: {
    log: (): { info(): void; warn(): void; error(): void; debug(): void } => ({
      info(): void {},
      warn(): void {},
      error(): void {},
      debug(): void {},
    }),
    context: {
      user: {
        id: 'reader',
        is: (role: string): boolean => role === 'MCP_Reader',
      },
    },
  },
}));
jest.mock('../../srv/connections/destinationResolver', (): object => ({
  resolveDestinationSapConfig: async (
    destinationName: string,
  ): Promise<{
    destinationName: string;
    authenticationType: string;
    sapConfig: { url: string; authType: string };
  }> => ({
    destinationName,
    authenticationType: 'NoAuthentication',
    sapConfig: { url: 'http://sap', authType: 'basic' },
  }),
}));
jest.mock('../../srv/lib/system-identity-cache', (): object => ({
  cachedSystemIdentity: (): null => null,
  bindSystemIdentity: (): void => {},
  warmSystemIdentity: async (): Promise<void> => duringWarmup(),
}));
jest.mock('../../srv/connections/connectionFactory', (): object => ({
  ...jest.requireActual<
    typeof import('../../srv/connections/connectionFactory')
  >('../../srv/connections/connectionFactory'),
  createConnection: (): {
    connect: jest.Mock<Promise<void>, [], void>;
    disconnect: jest.Mock<Promise<void>, [], void>;
    close: jest.Mock<Promise<void>, [], void>;
    closeSession: jest.Mock<Promise<void>, [], void>;
    probe: (_path: string) => Promise<{ httpCode: number; rawMessage: string }>;
    reset: () => void;
    getBaseUrl: () => Promise<string>;
    getSessionId: () => string;
    setSessionType: () => void;
    makeAdtRequest: () => Promise<never>;
  } => {
    const connection = makeConnection();
    connections.push(connection);
    return connection;
  },
}));
jest.mock('@mcp-abap-adt/lib/embeddable', (): object => ({
  EmbeddableMcpServer: class {
    constructor(options: ServerOptions) {
      optionsSeen.push(options);
    }
    async connect(): Promise<void> {}
    async dispose(): Promise<void> {}
    async terminalClose(): Promise<void> {}
  },
}));
const headers = {
  'x-sap-url': 'http://sap',
  'x-sap-auth-type': 'basic',
  'x-sap-login': 'dev',
  'x-sap-password': 'secret',
};
beforeEach((): void => {
  optionsSeen.length = 0;
  connections.length = 0;
  failConnect = false;
  failClose = false;
  duringWarmup = async (): Promise<void> => {};
  duringProbe = (): void => {};
  express.request.headers = { ...headers };
});
afterEach((): void => {
  setLongSessionsForTest(undefined);
});
let recordingSink = memorySink({ limit: 100 });
async function start(mode = 'on', measure = 'process') {
  recordingSink = memorySink({ limit: 100 });
  return initUsage(
    readUsageConfig({
      LLM_AGENT_USAGE: mode,
      LLM_AGENT_USAGE_SINKS: 'memory',
      LLM_AGENT_USAGE_MEASURE: measure,
    }),
    { factories: { memory: (): IUsageSink & IUsageReader => recordingSink } },
  );
}

test.each(['on', 'off', 'disabled'])(
  'request and background handoff/release (%s)',
  async (mode: string): Promise<void> => {
    const runtime = await start(
      mode === 'off' ? 'off' : 'on',
      mode === 'disabled' ? 'llm' : 'process',
    );
    const expected = mode === 'on' ? 1 : 0;
    try {
      const built = await buildConnectionForDestination({ headers }, 'D');
      expect(processConnectionCount()).toBe(expected);
      await safeStop(built.connection);
      expect(processConnectionCount()).toBe(0);
      const acquired = await establishRequestConnection(
        express.request,
        express.response,
        'D',
      );
      expect(acquired.handled).toBe(false);
      expect(processConnectionCount()).toBe(expected);
      try {
        throw new Error('owner failed');
      } catch {
      } finally {
        await releaseRequestConnection(acquired.connection);
      }
      expect(processConnectionCount()).toBe(0);
    } finally {
      await runtime?.close(1000);
    }
  },
);

test.each([false, true])(
  'MCP server counts only its hub-owned identity until terminal teardown (close error=%s)',
  async (error: boolean): Promise<void> => {
    const runtime = await start();
    try {
      const owner = await createMCPServerForRequest(express.request);
      expect(processConnectionCount()).toBe(1);
      try {
        const factory = optionsSeen[0].freshConnection;
        if (!factory) throw new Error('missing fresh factory');
        const fresh = await factory();
        await fresh.connect();
        expect(processCounters().openSapConnections).toBe(1);
        if ('disconnect' in fresh && typeof fresh.disconnect === 'function')
          await fresh.disconnect();
        expect(processCounters().openSapConnections).toBe(1);
        failClose = error;
      } finally {
        await owner.cleanup();
      }
      expect(processConnectionCount()).toBe(0);
      await owner.cleanup();
    } finally {
      await runtime?.close(1000);
    }
  },
);

test.each(['success', 'error', 'abort', 'connect-error'])(
  'MCP request excludes library-owned fresh operations on %s',
  async (outcome: string): Promise<void> => {
    const runtime = await start();
    const owner = await createMCPServerForRequest(express.request);
    try {
      jest
        .spyOn(owner.transport, 'handleRequest')
        .mockImplementation(async (): Promise<void> => {
          const factory = optionsSeen[0].freshConnection;
          if (!factory) throw new Error('missing fresh factory');
          expect(processCounters().openSapConnections).toBe(1);
          // Simulate the tool library owning acquisition and endConnection.
          // Repeated operations must not accumulate in the HTTP owner's count.
          for (let operation = 0; operation < 2; operation++) {
            const fresh = await factory();
            expect(processCounters().openSapConnections).toBe(1);
            failConnect = outcome === 'connect-error';
            try {
              await fresh.connect();
              expect(processCounters().openSapConnections).toBe(1);
              if (outcome !== 'success') throw new Error(outcome);
            } finally {
              if (
                'disconnect' in fresh &&
                typeof fresh.disconnect === 'function'
              )
                await fresh.disconnect();
              expect(processCounters().openSapConnections).toBe(1);
            }
          }
        });
      const handling = owner.handle(express.request, express.response, {});
      if (outcome === 'success') await handling;
      else
        await expect(handling).rejects.toThrow(
          outcome === 'connect-error' ? 'connect failed' : outcome,
        );
      expect(processCounters().openSapConnections).toBe(1);
      await owner.cleanup();
      expect(processConnectionCount()).toBe(0);
    } finally {
      await owner.cleanup();
      await runtime?.close(1000);
    }
    expect(processConnectionCount()).toBe(0);
  },
);

test.each([false, true])(
  'probe registration is paired with finally (close error=%s)',
  async (error: boolean): Promise<void> => {
    const runtime = await start();
    try {
      duringProbe = (): void => {
        expect(processConnectionCount()).toBe(1);
      };
      failClose = error;
      const pending = runActiveDestinationProbe({
        destination: 'D',
        login: 'dev',
        password: 'secret',
      });
      if (error) await expect(pending).rejects.toThrow('close failed');
      else await pending;
      expect(processConnectionCount()).toBe(0);
    } finally {
      await runtime?.close(1000);
    }
  },
);

test.each([false, true])(
  'probe stays counted until deferred close settles (close error=%s)',
  async (error: boolean): Promise<void> => {
    const runtime = await start();
    const closing = deferred();
    const entered = deferred();
    const closeError = new Error('deferred close failed');
    duringProbe = (): void => {
      const connection = connections[connections.length - 1];
      connection.closeSession.mockImplementation(async (): Promise<void> => {
        entered.resolve();
        await closing.promise;
        if (error) throw closeError;
      });
    };
    const pending = runActiveDestinationProbe({
      destination: 'D',
      login: 'dev',
      password: 'secret',
    });
    const settled = error
      ? expect(pending).rejects.toBe(closeError)
      : expect(pending).resolves.toMatchObject({ httpCode: 200 });
    try {
      await entered.promise;
      expect(processConnectionCount()).toBe(1);
      closing.resolve();
      await settled;
      expect(processConnectionCount()).toBe(0);
    } finally {
      closing.resolve();
      await settled;
      await runtime?.close(1000);
    }
  },
);

test('failed acquisition registers nothing; throwing release unregisters', async (): Promise<void> => {
  const runtime = await start();
  try {
    failConnect = true;
    await expect(
      buildConnectionForDestination({ headers }, 'D'),
    ).rejects.toThrow('connect failed');
    expect(processConnectionCount()).toBe(0);
    failConnect = false;
    const built = await buildConnectionForDestination({ headers }, 'D');
    expect(processConnectionCount()).toBe(1);
    failClose = true;
    await safeStop(built.connection);
    expect(processConnectionCount()).toBe(0);
  } finally {
    await runtime?.close(1000);
  }
});

test('long-session registry retains ownership across requests and clears on drop', async (): Promise<void> => {
  const runtime = await start();
  const registry = new LongSessionRegistry(
    { ttlMs: 1000, maxSessions: 4, maxPerUser: 4, queueLength: 1 },
    {
      onClose: async (session: LongSession): Promise<void> => {
        await dropSessionConnection(session);
      },
    },
  );
  setLongSessionsForTest(registry);
  const session = registry.open('reader', {});
  if ('refused' in session) throw new Error('open refused');
  try {
    const result = await acquireSessionConnection(
      session,
      express.request,
      express.response,
      'D',
    );
    expect(processConnectionCount()).toBe(1);
    if (result.handled) throw new Error('connection refused');
    await releaseRequestConnection(result.connection, session);
    expect(processConnectionCount()).toBe(1);
    failClose = true;
    await registry.close('reader', session.key, 'explicit');
    expect(processConnectionCount()).toBe(0);
  } finally {
    await registry.closeAll('shutdown');
    await runtime?.close(1000);
  }
});

test.each(['healthy', 'error', 'abort'])(
  'pool derives retained identities and clears on %s teardown',
  async (outcome: string): Promise<void> => {
    const runtime = await start();
    const factory = new SessionConnectionFactory('reader', 'key', {
      builder: async (): Promise<{
        connection: {
          connect: jest.Mock<Promise<void>, [], void>;
          disconnect: jest.Mock<Promise<void>, [], void>;
          close: jest.Mock<Promise<void>, [], void>;
          closeSession: jest.Mock<Promise<void>, [], void>;
          probe: (
            _path: string,
          ) => Promise<{ httpCode: number; rawMessage: string }>;
          reset: () => void;
          getBaseUrl: () => Promise<string>;
          getSessionId: () => string;
          setSessionType: () => void;
          makeAdtRequest: () => Promise<never>;
        };
        dumpScope: undefined;
        system: Record<string, never>;
      }> => ({
        connection: makeConnection(),
        dumpScope: undefined,
        system: {},
      }),
    });
    await factory.refresh({ headers }, 'D');
    const pool = new SessionConnectionPool(factory, 1);
    try {
      const lease = await pool.acquire();
      expect(processConnectionCount()).toBe(1);
      if (outcome === 'abort') {
        const abort = new AbortController();
        const waiting = pool.acquire(abort.signal);
        abort.abort();
        await expect(waiting).rejects.toThrow('aborted');
        expect(processConnectionCount()).toBe(1);
      }
      failClose = outcome === 'error';
      await lease.release(outcome !== 'error');
      expect(processConnectionCount()).toBe(outcome === 'error' ? 0 : 1);
    } finally {
      await pool.closeAll();
      await runtime?.close(1000);
    }
    expect(processConnectionCount()).toBe(0);
  },
);

test.each([false, true])(
  'pool counts each settled close while another is pending (failure: %s)',
  async (closeFails: boolean): Promise<void> => {
    const runtime = await start();
    const first = makeConnection();
    const remaining = makeConnection();
    let finishClose: () => void = (): void => {};
    const deferredClose = new Promise<void>((resolve: () => void): void => {
      finishClose = resolve;
    });
    remaining.close.mockImplementation(async (): Promise<void> => {
      await deferredClose;
      if (closeFails) throw new Error('close failed');
    });
    let built = 0;
    const factory = new SessionConnectionFactory('reader', 'key', {
      builder: async (): Promise<{
        connection: {
          connect: jest.Mock<Promise<void>, [], void>;
          disconnect: jest.Mock<Promise<void>, [], void>;
          close: jest.Mock<Promise<void>, [], void>;
          closeSession: jest.Mock<Promise<void>, [], void>;
          probe: (
            _path: string,
          ) => Promise<{ httpCode: number; rawMessage: string }>;
          reset: () => void;
          getBaseUrl: () => Promise<string>;
          getSessionId: () => string;
          setSessionType: () => void;
          makeAdtRequest: () => Promise<never>;
        };
        dumpScope: undefined;
        system: Record<string, never>;
      }> => ({
        connection: built++ === 0 ? first : remaining,
        dumpScope: undefined,
        system: {},
      }),
    });
    await factory.refresh({ headers }, 'D');
    const pool = new SessionConnectionPool(factory, 2);
    try {
      await pool.acquire();
      await pool.acquire();
      expect(processConnectionCount()).toBe(2);
      const closing = pool.closeAll();
      // Drain the successful connection's teardown while its peer stays blocked.
      await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
      });
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(remaining.close).toHaveBeenCalledTimes(1);
      expect(processConnectionCount()).toBe(1);
      finishClose();
      await closing;
      expect(processConnectionCount()).toBe(0);
    } finally {
      finishClose();
      await pool.closeAll();
      await runtime?.close(1000);
    }
  },
);

test('real SAP lifecycle connect -> closeSession -> connect still serves SAP calls', async (): Promise<void> => {
  const runtime = await start();
  jest.mocked(executeHttpRequest).mockResolvedValue({
    request: {},
    status: 200,
    data: 'SAP response',
    headers: {
      'x-csrf-token': 'csrf',
      'set-cookie': ['SAP_SESSIONID_DEV_100=SESSION; path=/'],
    },
  });
  const factory = jest.requireActual<
    typeof import('../../srv/connections/connectionFactory')
  >('../../srv/connections/connectionFactory');
  const connection = factory.createConnection({
    sapConfig: {
      url: 'https://sap',
      authType: 'basic',
      username: 'dev',
      password: 'secret',
      client: '100',
    },
    destinationName: 'D',
  });
  if (!(connection instanceof CloudSdkAbapConnection))
    throw new Error('expected real destination connection');
  const connect = connection.connect;
  const close = connection.closeSession;
  try {
    await connection.connect();
    processConnectionOpened(connection);
    expect(processConnectionCount()).toBe(1);
    try {
      await connection.closeSession();
    } finally {
      processConnectionClosed(connection);
    }
    expect(processConnectionCount()).toBe(0);
    await connection.connect();
    processConnectionOpened(connection);
    expect(processConnectionCount()).toBe(1);
    const response = await connection.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    expect(response.data).toBe('SAP response');
    expect(connection.connect).toBe(connect);
    expect(connection.closeSession).toBe(close);
  } finally {
    await safeStop(connection);
    await runtime?.close(1000);
  }
  expect(processConnectionCount()).toBe(0);
});

test.each(['off', 'disabled'])(
  'all retained and MCP owners remain unregistered (%s)',
  async (mode: string): Promise<void> => {
    const runtime = await start(
      mode === 'off' ? 'off' : 'on',
      mode === 'disabled' ? 'llm' : 'process',
    );
    const factory = new SessionConnectionFactory('reader', 'off', {
      builder: async (): Promise<{
        connection: {
          connect: jest.Mock<Promise<void>, [], void>;
          disconnect: jest.Mock<Promise<void>, [], void>;
          close: jest.Mock<Promise<void>, [], void>;
          closeSession: jest.Mock<Promise<void>, [], void>;
          probe: (
            _path: string,
          ) => Promise<{ httpCode: number; rawMessage: string }>;
          reset: () => void;
          getBaseUrl: () => Promise<string>;
          getSessionId: () => string;
          setSessionType: () => void;
          makeAdtRequest: () => Promise<never>;
        };
        dumpScope: undefined;
        system: Record<string, never>;
      }> => ({
        connection: makeConnection(),
        dumpScope: undefined,
        system: {},
      }),
    });
    await factory.refresh({ headers }, 'D');
    const pool = new SessionConnectionPool(factory, 1);
    const owner = await createMCPServerForRequest(express.request);
    const registry = new LongSessionRegistry(
      { ttlMs: 1000, maxSessions: 4, maxPerUser: 4, queueLength: 1 },
      {
        onClose: async (session: LongSession): Promise<void> => {
          await dropSessionConnection(session);
        },
      },
    );
    setLongSessionsForTest(registry);
    try {
      const lease = await pool.acquire();
      const freshFactory = optionsSeen[0].freshConnection;
      if (!freshFactory) throw new Error('missing fresh factory');
      const fresh = await freshFactory();
      const connect = fresh.connect;
      await fresh.connect();
      expect(fresh.connect).toBe(connect);
      const session = registry.open('reader', {});
      if ('refused' in session) throw new Error('open refused');
      await acquireSessionConnection(
        session,
        express.request,
        express.response,
        'D',
      );
      duringProbe = (): void => {
        expect(processConnectionCount()).toBe(0);
      };
      await runActiveDestinationProbe({
        destination: 'D',
        login: 'dev',
        password: 'secret',
      });
      expect(processConnectionCount()).toBe(0);
      await lease.release(false);
      await registry.closeAll('shutdown');
    } finally {
      await owner.cleanup();
      await pool.closeAll();
      await registry.closeAll('shutdown');
      await runtime?.close(1000);
    }
    expect(processConnectionCount()).toBe(0);
  },
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: Dirent): string[] =>
      entry.isDirectory()
        ? sourceFiles(join(directory, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(directory, entry.name)]
          : [],
  );
}
function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && child.expression.getText() === name)
      found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}
test('site audit pairs every owner registration with a release and preserves channel finally cleanup', (): void => {
  const root = join(__dirname, '../../srv');
  const sources = new Map<string, ts.SourceFile>();
  for (const file of sourceFiles(root))
    sources.set(
      relative(root, file).replaceAll('\\', '/'),
      ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      ),
    );
  // Library-owned: freshConnection returns unconnected instances; the library
  // connects/ends them without a lifecycle hook observable by the hub.
  const excludedAcquisitions = [
    'mcp-manager.ts:freshConnection',
    'mcp-manager.ts:freshConnection',
  ];
  const acquisitions: string[] = [];
  for (const [file, source] of sources) {
    for (const call of calls(source, 'createConnection')) {
      let parent: ts.Node | undefined = call.parent;
      let site = file;
      while (parent) {
        if (
          ts.isPropertyAssignment(parent) &&
          parent.name.getText() === 'freshConnection'
        ) {
          site += ':freshConnection';
          break;
        }
        parent = parent.parent;
      }
      acquisitions.push(site);
    }
  }
  const expectedAcquisitions = [
    'lib/active-probe.ts',
    'lib/background-connection.ts',
    'lib/request-connection.ts',
    'mcp-manager.ts',
    'mcp-manager.ts',
    ...excludedAcquisitions,
  ].sort();
  const auditAcquisitions = (sites: string[]): void => {
    expect([...sites].sort()).toEqual(expectedAcquisitions);
  };
  auditAcquisitions(acquisitions);
  expect((): void =>
    auditAcquisitions([...acquisitions, 'unlisted.ts']),
  ).toThrow();
  const boundaries = [
    [
      'lib/request-connection.ts',
      'processConnectionOpened',
      'lib/request-connection.ts',
      'processConnectionClosed',
    ],
    [
      'lib/background-connection.ts',
      'processConnectionOpened',
      'lib/request-connection.ts',
      'processConnectionClosed',
    ],
    [
      'lib/active-probe.ts',
      'processConnectionOpened',
      'lib/active-probe.ts',
      'processConnectionClosed',
    ],
    [
      'lib/session-connection.ts',
      'processConnectionOpened',
      'lib/request-connection.ts',
      'processConnectionClosed',
    ],
    [
      'lib/session-connection-pool.ts',
      'processConnectionOpened',
      'lib/request-connection.ts',
      'processConnectionClosed',
    ],
    [
      'lib/session-connection-pool.ts',
      'processConnectionSource',
      'lib/session-connection-pool.ts',
      'this.#releaseSource',
    ],
    [
      'mcp-manager.ts',
      'processConnectionOpened',
      'lib/request-connection.ts',
      'processConnectionClosed',
    ],
  ];
  const registrations: string[] = [];
  for (const [file, source] of sources) {
    if (file === 'lib/usage/process-resources.ts') continue;
    for (const name of ['processConnectionOpened', 'processConnectionSource']) {
      for (const registration of calls(source, name)) {
        registrations.push(`${file}:${name}`);
        expect(registration.arguments.length).toBe(1);
      }
    }
  }
  expect(registrations.sort()).toEqual(
    boundaries
      .map(([file, name]: string[]): string => `${file}:${name}`)
      .sort(),
  );
  for (const [_file, _register, releaseFile, release] of boundaries) {
    const source = sources.get(releaseFile);
    if (!source) throw new Error(`missing ${releaseFile}`);
    const releases = calls(source, release);
    expect(releases.length).toBeGreaterThan(0);
  }
  // Follow transient acquisition into the channel owners, rather than accepting
  // an unrelated finally elsewhere in the acquisition module.
  for (const [file, acquire, release] of [
    [
      'openai-handler.ts',
      'establishRequestConnection',
      'releaseRequestConnection',
    ],
    [
      'anthropic-handler.ts',
      'establishRequestConnection',
      'releaseRequestConnection',
    ],
    ['agent-mcp.ts', 'buildConnectionForDestination', 'safeStop'],
  ]) {
    const source = sources.get(file);
    if (!source) throw new Error(`missing owner ${file}`);
    expect(calls(source, acquire).length).toBeGreaterThan(0);
    const finallyReleases: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isTryStatement(node) && node.finallyBlock)
        finallyReleases.push(...calls(node.finallyBlock, release));
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(finallyReleases.length).toBeGreaterThan(0);
  }
  const factory = sources.get('connections/connectionFactory.ts');
  expect(factory?.text).not.toMatch(/processConnection|trackSapConnection/);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = (): void => {};
  const promise = new Promise<void>(
    (done: (value: void | PromiseLike<void>) => void): void => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

test.each(['on', 'off', 'disabled'])(
  'deferred teardown clears session binding before concurrent acquisition (%s)',
  async (mode: string): Promise<void> => {
    const runtime = await start(
      mode === 'off' ? 'off' : 'on',
      mode === 'disabled' ? 'llm' : 'process',
    );
    const registry = new LongSessionRegistry(
      { ttlMs: 1000, maxSessions: 4, maxPerUser: 4, queueLength: 1 },
      { onClose: dropSessionConnection },
    );
    setLongSessionsForTest(registry);
    const session = registry.open('reader', {});
    if ('refused' in session) throw new Error('open refused');
    const closing = deferred();
    const entered = deferred();
    try {
      await acquireSessionConnection(
        session,
        express.request,
        express.response,
        'D',
      );
      const old = connections[0];
      old.close.mockImplementation(async (): Promise<void> => {
        entered.resolve();
        await closing.promise;
      });
      const switching = acquireSessionConnection(
        session,
        express.request,
        express.response,
        'OTHER',
      );
      await entered.promise;
      expect(session.connection).toBeUndefined();
      expect(session.binding).toBeUndefined();
      expect(session.dumpScope).toBeUndefined();
      expect(processCounters().openSapConnections).toBe(mode === 'on' ? 2 : 0);
      const concurrent = await acquireSessionConnection(
        session,
        express.request,
        express.response,
        'D',
      );
      if (concurrent.handled) throw new Error('concurrent acquisition refused');
      expect(concurrent.connection).not.toBe(old);
      expect(old.close).toHaveBeenCalledTimes(1);
      closing.resolve();
      await switching;
      await safeStop(concurrent.connection);
      expect(processCounters().openSapConnections).toBe(mode === 'on' ? 1 : 0);
    } finally {
      closing.resolve();
      await registry.closeAll('shutdown');
      await runtime?.close(1000);
    }
  },
);

test.each(['request', 'background'])(
  'successful %s connect is counted during deferred identity warmup',
  async (owner: string): Promise<void> => {
    jest.useFakeTimers();
    const runtime = await start();
    if (!runtime) throw new Error('missing runtime');
    startProcessMeter(runtime, 30000);
    const warmup = deferred();
    const entered = deferred();
    duringWarmup = async (): Promise<void> => {
      entered.resolve();
      await warmup.promise;
    };
    try {
      const pending =
        owner === 'request'
          ? establishRequestConnection(express.request, express.response, 'D')
          : buildConnectionForDestination({ headers }, 'D');
      await entered.promise;
      await jest.advanceTimersByTimeAsync(90000);
      let ticks = 0;
      for await (const row of recordingSink.read({
        from: 0,
        to: Number.MAX_SAFE_INTEGER,
      })) {
        if (row.kind !== 'x.hub.process' || !('values' in row)) continue;
        expect(row.values.openSapConnections).toBe(1);
        ticks++;
      }
      expect(ticks).toBe(3);
      warmup.resolve();
      const result = await pending;
      await safeStop(result.connection);
      expect(processCounters().openSapConnections).toBe(0);
    } finally {
      warmup.resolve();
      await runtime.close(1000);
      jest.useRealTimers();
    }
  },
);
