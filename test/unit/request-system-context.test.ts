/**
 * The SAP responsible person and master system, per request.
 *
 * `@mcp-abap-adt/lib` 10.0.1 reads both from a process singleton, so two
 * admitted runs raced on it. `srv/lib/request-system-context.ts` resolves the
 * values per request and delivers them to lib inside a scope that only that
 * request's run sees (workaround for fr0ster/mcp-abap-adt#202).
 */

const mockLog = { info: jest.fn(), warn: jest.fn() };
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({
        info: (...a: unknown[]) => mockLog.info(...a),
        warn: (...a: unknown[]) => mockLog.warn(...a),
        error() {},
        debug() {},
      }),
    },
  }),
  { virtual: true },
);
// Pass-through: lib's own modules require the same file, so the real function
// must keep working for them; the spy only records what cloud-llm-hub passed.
jest.mock('@mcp-abap-adt/lib/request-context', () => {
  const actual = jest.requireActual('@mcp-abap-adt/lib/request-context');
  return {
    ...actual,
    runWithRequestContext: jest.fn(actual.runWithRequestContext),
  };
});

import { dirname, join } from 'node:path';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import {
  getRequestContext,
  runWithRequestContext,
} from '@mcp-abap-adt/lib/request-context';
import {
  defaultSystemInfoLookup,
  installRequestSystemContext,
  type LibSystemContextModule,
  type RequestSystemInput,
  resetRequestSystemContextForTest,
  resolveRequestSystem,
  runWithRequestSystem,
  type SystemInfoLookup,
  setSystemInfoLookup,
} from '../../srv/lib/request-system-context';

type Ctx = {
  responsible?: string;
  masterSystem?: string;
  masterLanguage?: string;
  isLegacy?: boolean;
};

const libDir = dirname(require.resolve('@mcp-abap-adt/lib/utils'));
// The same absolute-path require the workaround uses: the subpath is not in
// lib's `exports`, and this is the instance lib's own modules hold.
const libSystemContext = require(join(libDir, 'systemContext.js')) as {
  getSystemContext: () => Ctx;
  setSystemContext: (c: Ctx) => void;
  resetSystemContextCache: () => void;
};
const libUtils = require('@mcp-abap-adt/lib/utils') as {
  getSystemContext: () => Ctx;
  getSystemInformation: () => Promise<{
    systemID?: string;
    userName?: string;
  } | null>;
};
const libClients = require(join(libDir, 'clients.js')) as {
  createAdtClient: (c: unknown) => { systemContext: Ctx };
};
const originalGetSystemContext = libSystemContext.getSystemContext;

const connection = { id: 'conn' } as unknown as IAbapConnection;

function input(
  overrides: Partial<RequestSystemInput> = {},
): RequestSystemInput {
  return {
    headers: {},
    proxyType: 'Internet',
    connection,
    destinationName: 'DEST',
    callerIdentity: 'principal-a',
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  (runWithRequestContext as jest.Mock).mockClear();
});

afterEach(() => {
  resetRequestSystemContextForTest();
  libSystemContext.resetSystemContextCache();
});

describe('on-premise values come from the caller', () => {
  const onPrem = (headers: Record<string, unknown>) =>
    input({ proxyType: 'OnPremise', headers });

  it('x-sap-responsible wins over x-sap-login, and both are uppercased', async () => {
    const lookup = jest.fn();
    setSystemInfoLookup(lookup);
    await expect(
      resolveRequestSystem(
        onPrem({
          'x-sap-responsible': 'bob',
          'x-sap-login': 'alice',
          'x-sap-master-system': 'dev',
        }),
      ),
    ).resolves.toEqual({ responsible: 'BOB', masterSystem: 'DEV' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to x-sap-login, trimmed', async () => {
    const r = await resolveRequestSystem(
      onPrem({ 'x-sap-login': '  developer ' }),
    );
    expect(r.responsible).toBe('DEVELOPER');
  });

  it('a missing or blank value stays undefined, and nothing is looked up', async () => {
    const lookup = jest.fn();
    setSystemInfoLookup(lookup);
    const r = await resolveRequestSystem(
      onPrem({ 'x-sap-login': '   ', 'x-sap-master-system': '' }),
    );
    expect(r.responsible).toBeUndefined();
    expect(r.masterSystem).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('matches the proxy type case-insensitively and reads the first of repeated headers', async () => {
    const lookup = jest.fn();
    setSystemInfoLookup(lookup);
    const r = await resolveRequestSystem(
      input({
        proxyType: 'onpremise',
        headers: { 'x-sap-master-system': ['qas', 'dev'] },
      }),
    );
    expect(r.masterSystem).toBe('QAS');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('cloud values: headers first, then the system information', () => {
  it('headers win, and a complete set looks nothing up', async () => {
    const lookup = jest.fn();
    setSystemInfoLookup(lookup);
    await expect(
      resolveRequestSystem(
        input({
          headers: { 'x-sap-login': 'carol', 'x-sap-master-system': 'abc' },
        }),
      ),
    ).resolves.toEqual({ responsible: 'CAROL', masterSystem: 'ABC' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fills only the missing values from the lookup', async () => {
    const lookup: SystemInfoLookup = jest.fn(async () => ({
      userName: 'cb9980000123',
      systemID: 'XYZ',
    }));
    setSystemInfoLookup(lookup);
    await expect(
      resolveRequestSystem(
        input({ headers: { 'x-sap-master-system': 'abc' } }),
      ),
    ).resolves.toEqual({ responsible: 'CB9980000123', masterSystem: 'ABC' });
    await expect(resolveRequestSystem(input())).resolves.toEqual({
      responsible: 'CB9980000123',
      masterSystem: 'XYZ',
    });
    expect(lookup).toHaveBeenCalledWith(connection);
  });

  it('looks up once per destination and caller, across repeated and concurrent requests', async () => {
    const gate = deferred();
    const lookup = jest.fn(async () => {
      await gate.promise;
      return { userName: 'u', systemID: 'S' };
    });
    setSystemInfoLookup(lookup);

    const concurrent = [1, 2, 3].map(() => resolveRequestSystem(input()));
    gate.resolve();
    await Promise.all(concurrent);
    await resolveRequestSystem(input());
    expect(lookup).toHaveBeenCalledTimes(1);

    await resolveRequestSystem(input({ callerIdentity: 'principal-b' }));
    await resolveRequestSystem(input({ destinationName: 'OTHER' }));
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('caches nothing for a caller with no stable identity', async () => {
    const lookup = jest.fn(async () => ({ userName: 'u', systemID: 'S' }));
    setSystemInfoLookup(lookup);
    await resolveRequestSystem(input({ callerIdentity: undefined }));
    await resolveRequestSystem(input({ callerIdentity: undefined }));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is logged, leaves the values undefined, is not cached, and is retried', async () => {
    const lookup = jest
      .fn()
      .mockRejectedValueOnce(new Error('systeminformation 500'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ userName: 'u', systemID: 'S' });
    setSystemInfoLookup(lookup);

    const failed = await resolveRequestSystem(input());
    expect(failed.responsible).toBeUndefined();
    expect(failed.masterSystem).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLog.warn.mock.calls[0])).toContain(
      'systeminformation 500',
    );

    const empty = await resolveRequestSystem(input());
    expect(empty.masterSystem).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledTimes(2);

    await expect(resolveRequestSystem(input())).resolves.toEqual({
      responsible: 'U',
      masterSystem: 'S',
    });
    await resolveRequestSystem(input());
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('until a lookup is wired, cloud values are the headers alone, quietly', async () => {
    // Open item: the production lookup is not wired yet (see
    // `defaultSystemInfoLookup`), so cloud keeps today's header-only behaviour.
    expect(defaultSystemInfoLookup).toBeNull();
    const r = await resolveRequestSystem(
      input({ headers: { 'x-sap-login': 'dave' } }),
    );
    expect(r).toEqual({ responsible: 'DAVE', masterSystem: undefined });
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

describe('overlay delivery on the installed @mcp-abap-adt/lib 10.0.1', () => {
  /** Everything lib reads the two values through, from inside a scope. */
  async function whatLibSees() {
    return {
      ctx: libUtils.getSystemContext(),
      info: await libUtils.getSystemInformation(),
      // The real client over lib's nested adt-clients: it wraps the request
      // function at construction and sends nothing.
      client: libClients.createAdtClient({ makeAdtRequest: async () => ({}) })
        .systemContext,
    };
  }

  it('is the delivery chosen for the installed lib', () => {
    expect(installRequestSystemContext()).toBe('overlay');
    expect(libSystemContext.getSystemContext).not.toBe(
      originalGetSystemContext,
    );
    // lib's public `utils` export is a getter onto the same module.
    expect(libUtils.getSystemContext).toBe(libSystemContext.getSystemContext);
    expect(mockLog.info).toHaveBeenCalledTimes(1);
  });

  it('gives two concurrent runs their own responsible person and master system', async () => {
    installRequestSystemContext();
    libSystemContext.setSystemContext({
      responsible: 'PROCESS',
      masterSystem: 'PRC',
    });
    const bothEntered = deferred();
    let entered = 0;
    const run = (responsible: string, masterSystem: string) =>
      runWithRequestSystem({ responsible, masterSystem }, async () => {
        entered++;
        if (entered === 2) bothEntered.resolve();
        await bothEntered.promise;
        return whatLibSees();
      });

    const [alice, bob] = await Promise.all([
      run('ALICE', 'DEV'),
      run('BOB', 'QAS'),
    ]);

    expect(alice.ctx).toMatchObject({
      responsible: 'ALICE',
      masterSystem: 'DEV',
    });
    expect(alice.info).toEqual({ systemID: 'DEV', userName: 'ALICE' });
    expect(alice.client).toMatchObject({
      responsible: 'ALICE',
      masterSystem: 'DEV',
    });
    expect(bob.ctx).toMatchObject({ responsible: 'BOB', masterSystem: 'QAS' });
    expect(bob.info).toEqual({ systemID: 'QAS', userName: 'BOB' });
    expect(bob.client).toMatchObject({
      responsible: 'BOB',
      masterSystem: 'QAS',
    });
  });

  it('a scope with no values does not inherit the process ones, but keeps the rest', async () => {
    installRequestSystemContext();
    libSystemContext.setSystemContext({
      responsible: 'PROCESS',
      masterSystem: 'PRC',
      masterLanguage: 'EN',
    });
    const seen = await runWithRequestSystem({}, async () => whatLibSees());
    expect(seen.ctx.responsible).toBeUndefined();
    expect(seen.ctx.masterSystem).toBeUndefined();
    expect(seen.ctx.masterLanguage).toBe('EN');
    expect(seen.info).toBeNull();
    expect(seen.client.responsible).toBeUndefined();
  });

  it('outside a scope, lib sees the process value', async () => {
    installRequestSystemContext();
    libSystemContext.setSystemContext({ responsible: 'PROCESS' });
    expect(libUtils.getSystemContext().responsible).toBe('PROCESS');
    expect((await libUtils.getSystemInformation())?.userName).toBe('PROCESS');
  });

  it("agent-manager's setSystemContext({}) at init still reaches the base", async () => {
    installRequestSystemContext();
    libSystemContext.setSystemContext({});
    expect(libUtils.getSystemContext().responsible).toBeUndefined();
    const inside = await runWithRequestSystem(
      { responsible: 'ALICE' },
      async () => libUtils.getSystemContext(),
    );
    expect(inside.responsible).toBe('ALICE');
    expect(typeof inside.isLegacy).toBe('boolean');
  });

  it('installing twice does not wrap twice', async () => {
    installRequestSystemContext();
    const overlay = libSystemContext.getSystemContext;
    expect(installRequestSystemContext()).toBe('overlay');
    expect(libSystemContext.getSystemContext).toBe(overlay);
    expect(mockLog.info).toHaveBeenCalledTimes(1);
    const inside = await runWithRequestSystem(
      { responsible: 'ALICE' },
      async () => libUtils.getSystemContext(),
    );
    expect(inside.responsible).toBe('ALICE');
  });

  it('the test reset restores the original export', () => {
    installRequestSystemContext();
    resetRequestSystemContextForTest();
    expect(libSystemContext.getSystemContext).toBe(originalGetSystemContext);
  });
});

describe('delivery selection', () => {
  it('a lib with getEffectiveSystemContext is not overlaid: the run goes through runWithRequestContext', async () => {
    const getSystemContext = () => ({
      masterLanguage: 'DE',
      responsible: 'PROCESS',
    });
    const lib: LibSystemContextModule = {
      getSystemContext,
      getEffectiveSystemContext: () => ({}),
    };
    expect(installRequestSystemContext(lib)).toBe('request-context');
    expect(lib.getSystemContext).toBe(getSystemContext);

    const seen = await runWithRequestSystem(
      { responsible: 'ALICE', masterSystem: 'DEV' },
      async () => getRequestContext(),
    );
    expect(runWithRequestContext).toHaveBeenCalledTimes(1);
    expect((runWithRequestContext as jest.Mock).mock.calls[0][0]).toEqual({
      responsible: 'ALICE',
      masterSystem: 'DEV',
      masterLanguage: 'DE',
    });
    expect(seen).toEqual({
      responsible: 'ALICE',
      masterSystem: 'DEV',
      masterLanguage: 'DE',
    });
  });

  it('the overlay delivery never enters a lib request scope', async () => {
    installRequestSystemContext();
    await runWithRequestSystem({ responsible: 'ALICE' }, async () => {});
    expect(runWithRequestContext).not.toHaveBeenCalled();
  });

  const documented = /@mcp-abap-adt\/lib[\s\S]*fr0ster\/mcp-abap-adt#202/;

  it('a lib with no getSystemContext function fails the install', () => {
    expect(() => installRequestSystemContext({})).toThrow(documented);
    expect(() =>
      installRequestSystemContext({ getSystemContext: 'nope' }),
    ).toThrow(documented);
  });

  it('a non-writable getSystemContext fails the install', () => {
    const frozen = {};
    Object.defineProperty(frozen, 'getSystemContext', {
      value: () => ({}),
      writable: false,
    });
    expect(() => installRequestSystemContext(frozen)).toThrow(documented);

    const getterOnly = {};
    Object.defineProperty(getterOnly, 'getSystemContext', {
      get: () => () => ({}),
    });
    expect(() => installRequestSystemContext(getterOnly)).toThrow(documented);
  });

  it('a run before install fails loudly instead of running unscoped', async () => {
    const fn = jest.fn(async () => 'ran');
    await expect(runWithRequestSystem({}, fn)).rejects.toThrow(documented);
    expect(fn).not.toHaveBeenCalled();
  });
});
