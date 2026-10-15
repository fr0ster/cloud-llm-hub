import { getSystemInformation as lookup } from '@mcp-abap-adt/adt-clients/core';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import { withResolvedSystemContext } from '@mcp-abap-adt/lib/request-context';
/**
 * The SAP responsible person and master system, scoped to one request.
 *
 * Several SAP users share this process and their runs are admitted
 * concurrently, so `srv/lib/request-system-context.ts` resolves the values from
 * each request's headers and hands them to `@mcp-abap-adt/lib` through its own
 * request scope (`RequestContext`, fr0ster/mcp-abap-adt#202). What lib sees is
 * read through its public API only: `getSystemInformation()` reports the
 * responsible person and master system lib creates objects with.
 */

import { getRequestContext } from '@mcp-abap-adt/lib/request-context';
import {
  getSystemContext,
  getSystemInformation,
  setSystemContext,
} from '@mcp-abap-adt/lib/utils';
import {
  requestSystemContextResolver,
  resolveRequestSystem,
  runWithRequestSystem,
} from '../../srv/lib/request-system-context';

import {
  bindSystemIdentity,
  warmSystemIdentity,
} from '../../srv/lib/system-identity-cache';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  setSystemContext({
    responsible: undefined,
    masterSystem: undefined,
    masterLanguage: undefined,
  });
});

describe('the values come from the request headers', () => {
  it('x-sap-responsible is the stated responsible, x-sap-login the login — both uppercased', () => {
    expect(
      resolveRequestSystem({
        'x-sap-responsible': 'bob',
        'x-sap-login': 'alice',
        'x-sap-master-system': 'dev',
      }),
    ).toEqual({ responsible: 'BOB', login: 'ALICE', masterSystem: 'DEV' });
  });

  it('x-sap-login alone is the login, trimmed and uppercased; nothing is stated', () => {
    expect(resolveRequestSystem({ 'x-sap-login': '  developer ' })).toEqual({
      responsible: undefined,
      login: 'DEVELOPER',
      masterSystem: undefined,
    });
  });

  it('a missing or blank value stays undefined', () => {
    const r = resolveRequestSystem({
      'x-sap-login': '   ',
      'x-sap-master-system': '',
    });
    expect(r.responsible).toBeUndefined();
    expect(r.masterSystem).toBeUndefined();
    expect(resolveRequestSystem({})).toEqual({
      responsible: undefined,
      login: undefined,
      masterSystem: undefined,
    });
  });

  it('reads the first of repeated headers', () => {
    expect(
      resolveRequestSystem({ 'x-sap-master-system': ['qas', 'dev'] })
        .masterSystem,
    ).toBe('QAS');
  });
});

describe('delivery through the installed @mcp-abap-adt/lib request scope', () => {
  it('gives two concurrent runs their own responsible person and master system', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
    const bothEntered = deferred();
    let entered = 0;
    const run = (responsible: string, masterSystem: string) =>
      runWithRequestSystem({ responsible, masterSystem }, async () => {
        entered++;
        if (entered === 2) bothEntered.resolve();
        await bothEntered.promise;
        return getSystemInformation();
      });

    const [alice, bob] = await Promise.all([
      run('ALICE', 'DEV'),
      run('BOB', 'QAS'),
    ]);

    expect(alice).toEqual({ systemID: 'DEV', userName: 'ALICE' });
    expect(bob).toEqual({ systemID: 'QAS', userName: 'BOB' });
  });

  it('a run with no responsible person does not inherit the process one', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
    const seen = await runWithRequestSystem(
      { responsible: undefined, masterSystem: 'DEV' },
      getSystemInformation,
    );
    expect(seen?.userName).toBeUndefined();
    expect(seen?.systemID).toBe('DEV');

    const none = await runWithRequestSystem({}, getSystemInformation);
    expect(none).toBeNull();
  });

  it('the login is the responsible when none is stated (lib 16, on-premise)', async () => {
    const seen = await runWithRequestSystem(
      resolveRequestSystem({ 'x-sap-login': 'developer' }),
      getSystemInformation,
    );
    // The observable responsible on-premise stays the UPPERCASED login.
    expect(seen?.userName).toBe('DEVELOPER');
  });

  it('x-sap-responsible overrides the login', async () => {
    const seen = await runWithRequestSystem(
      resolveRequestSystem({
        'x-sap-login': 'developer',
        'x-sap-responsible': 'owner',
      }),
      getSystemInformation,
    );
    expect(seen?.userName).toBe('OWNER');
  });

  it('a stated process responsible never stands in for a request with only a login', async () => {
    setSystemContext({ responsible: 'PROCESS' });
    const seen = await runWithRequestSystem(
      resolveRequestSystem({ 'x-sap-login': 'developer' }),
      getSystemInformation,
    );
    expect(seen?.userName).toBe('DEVELOPER');
  });

  it('outside a run, lib sees the process values', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
    expect(await getSystemInformation()).toEqual({
      systemID: 'PRC',
      userName: 'PROCESS',
    });
    expect(getSystemContext().responsible).toBe('PROCESS');
  });

  it('carries the process master language into the run', async () => {
    setSystemContext({ masterLanguage: 'EN' });
    const scope = await runWithRequestSystem(
      { responsible: 'ALICE' },
      async () => getRequestContext(),
    );
    expect(scope).toMatchObject({ responsible: 'ALICE', masterLanguage: 'EN' });
  });
});

jest.mock('@mcp-abap-adt/adt-clients/core', () => ({
  getSystemInformation: jest.fn(),
}));
describe('lazy resolver', () => {
  const connection = () => ({}) as IAbapConnection;
  beforeEach(() => {
    jest.mocked(lookup).mockReset();
  });
  it('resolves on-premise user and master system', async () => {
    jest
      .mocked(lookup)
      .mockResolvedValue({ userName: 'USER', systemID: 'DEV' });
    await expect(requestSystemContextResolver(connection())).resolves.toEqual({
      responsible: 'USER',
      masterSystem: 'DEV',
    });
  });
  it.each([null, {}])('returns null for missing user (%s)', async (info) => {
    jest.mocked(lookup).mockResolvedValue(info as never);
    await expect(
      requestSystemContextResolver(connection()),
    ).resolves.toBeNull();
  });
  it('falls back on on-premise errors', async () => {
    jest.mocked(lookup).mockRejectedValue(new Error('private body'));
    await expect(
      requestSystemContextResolver(connection()),
    ).resolves.toBeNull();
  });
  let sessionId = 0;
  const declaredConnection = (systemType: 'cloud' | 'onprem') => {
    const conn = connection();
    bindSystemIdentity(conn, {
      systemType,
      sapConfig: {
        url: `https://sap/${sessionId++}`,
        authType: 'basic',
        username: 'USER',
      },
    });
    return conn;
  };
  it.each(['cloud', 'onprem'] as const)(
    'keeps a systemID-only %s identity and applies request precedence',
    async (systemType) => {
      const conn = declaredConnection(systemType);
      jest.mocked(lookup).mockResolvedValue({ systemID: 'DEV' });
      await warmSystemIdentity(conn, systemType);
      expect(await requestSystemContextResolver(conn)).toEqual({
        masterSystem: 'DEV',
      });
      for (const responsible of [undefined, 'owner']) {
        const info = await runWithRequestSystem(
          resolveRequestSystem({
            'x-sap-login': 'alice',
            'x-sap-responsible': responsible,
          }),
          () =>
            withResolvedSystemContext(
              conn,
              getSystemInformation,
              requestSystemContextResolver,
            ),
        );
        expect(info?.systemID).toBe('DEV');
        expect(info?.userName).toBe(
          responsible ? 'OWNER' : systemType === 'cloud' ? undefined : 'ALICE',
        );
      }
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['cloud', 'onprem'] as const)(
    'keeps a userName-only %s identity',
    async (systemType) => {
      const conn = declaredConnection(systemType);
      jest.mocked(lookup).mockResolvedValue({ userName: 'USER' });
      await expect(requestSystemContextResolver(conn)).resolves.toEqual({
        responsible: 'USER',
      });
    },
  );
  it.each([404, 405, 500])(
    'retries declared cloud warm-up and resolver failures (%s)',
    async (status) => {
      const conn = declaredConnection('cloud');
      const error = Object.assign(new Error('lookup failed'), { status });
      jest.mocked(lookup).mockRejectedValue(error);
      await warmSystemIdentity(conn, 'cloud');
      await expect(requestSystemContextResolver(conn)).rejects.toBe(error);
      const info = await runWithRequestSystem({ login: 'HINT' }, () =>
        withResolvedSystemContext(
          conn,
          getSystemInformation,
          requestSystemContextResolver,
        ),
      );
      expect(info?.userName).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(3);
    },
  );
  it.each(['cloud', 'onprem'] as const)(
    'applies declared %s semantics to an empty lookup',
    async (systemType) => {
      const conn = declaredConnection(systemType);
      jest.mocked(lookup).mockResolvedValue(null as never);
      expect(await requestSystemContextResolver(conn)).toEqual(
        systemType === 'cloud' ? {} : null,
      );
      const info = await runWithRequestSystem({ login: 'HINT' }, () =>
        withResolvedSystemContext(
          conn,
          getSystemInformation,
          requestSystemContextResolver,
        ),
      );
      expect(info?.userName).toBe(systemType === 'cloud' ? undefined : 'HINT');
    },
  );
  it('keeps declared on-premise fallback after warm-up and resolver failures', async () => {
    const conn = declaredConnection('onprem');
    jest.mocked(lookup).mockRejectedValue(new Error('lookup failed'));
    await warmSystemIdentity(conn, 'onprem');
    const info = await runWithRequestSystem({ login: 'HINT' }, () =>
      withResolvedSystemContext(
        conn,
        getSystemInformation,
        requestSystemContextResolver,
      ),
    );
    expect(info?.userName).toBe('HINT');
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('retains cloud kind when a session cannot be cached', async () => {
    const conn = connection();
    bindSystemIdentity(conn, {
      systemType: 'cloud',
      sapConfig: { url: 'https://sap', authType: 'jwt' },
    });
    jest.mocked(lookup).mockRejectedValue(new Error('lookup failed'));
    await expect(requestSystemContextResolver(conn)).rejects.toThrow(
      'lookup failed',
    );
    jest.mocked(lookup).mockResolvedValue(null as never);
    await expect(requestSystemContextResolver(conn)).resolves.toEqual({});
  });
  it('lib keeps explicit responsible and memoizes lazily', async () => {
    const conn = connection();
    jest
      .mocked(lookup)
      .mockResolvedValue({ userName: 'USER', systemID: 'DEV' });
    await runWithRequestSystem(
      { responsible: 'STATED', login: 'HINT' },
      async () => {
        expect(lookup).not.toHaveBeenCalled();
        for (let i = 0; i < 2; i++) {
          const info = await withResolvedSystemContext(
            conn,
            getSystemInformation,
            requestSystemContextResolver,
          );
          expect(info?.userName).toBe('STATED');
        }
      },
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('lib applies user then login (%s)', async (found) => {
    jest
      .mocked(lookup)
      .mockResolvedValue(found ? { userName: 'USER', systemID: 'DEV' } : null);
    const info = await runWithRequestSystem({ login: 'HINT' }, () =>
      withResolvedSystemContext(
        connection(),
        getSystemInformation,
        requestSystemContextResolver,
      ),
    );
    expect(info?.userName).toBe(found ? 'USER' : 'HINT');
  });
});
