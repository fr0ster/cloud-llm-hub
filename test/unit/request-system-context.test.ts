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
  resolveRequestSystem,
  runWithRequestSystem,
} from '../../srv/lib/request-system-context';

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
  it('x-sap-responsible wins over x-sap-login, and both values are uppercased', () => {
    expect(
      resolveRequestSystem({
        'x-sap-responsible': 'bob',
        'x-sap-login': 'alice',
        'x-sap-master-system': 'dev',
      }),
    ).toEqual({ responsible: 'BOB', masterSystem: 'DEV' });
  });

  it('falls back to x-sap-login, trimmed', () => {
    expect(
      resolveRequestSystem({ 'x-sap-login': '  developer ' }).responsible,
    ).toBe('DEVELOPER');
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
