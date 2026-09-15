/**
 * The SAP responsible person and master system, scoped to one request.
 *
 * Several SAP users share this process and their runs are admitted
 * concurrently, so `srv/lib/request-system-context.ts` resolves the values from
 * each request's headers and hands them to `@mcp-abap-adt/lib` through its own
 * request scope (`RequestContext`, lib 10.1.0, fr0ster/mcp-abap-adt#202).
 */

import { dirname, join } from 'node:path';
import {
  getSystemContext,
  getSystemInformation,
  setSystemContext,
} from '@mcp-abap-adt/lib/utils';
import {
  resolveRequestSystem,
  runWithRequestSystem,
} from '../../srv/lib/request-system-context';

type Ctx = {
  responsible?: string;
  masterSystem?: string;
  masterLanguage?: string;
};

const libDir = dirname(require.resolve('@mcp-abap-adt/lib/utils'));
// Test-only: `createAdtClient` is not in lib's `exports`, so it is required by
// path. It builds the real `AdtClient` from lib's own adt-clients, unmocked;
// the client records the context it was created with and sends nothing.
const libClients = require(join(libDir, 'clients.js')) as {
  createAdtClient: (c: unknown) => { systemContext: Ctx };
};
const libSystemContext = require(join(libDir, 'systemContext.js')) as {
  resetSystemContextCache: () => void;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  libSystemContext.resetSystemContextCache();
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
  /** What lib creates objects with, and what it reports, from inside a run. */
  async function whatLibSees() {
    return {
      client: libClients.createAdtClient({ makeAdtRequest: async () => ({}) })
        .systemContext,
      info: await getSystemInformation(),
    };
  }

  it('gives two concurrent runs their own responsible person and master system', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
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

    expect(alice.client).toMatchObject({
      responsible: 'ALICE',
      masterSystem: 'DEV',
    });
    expect(alice.info).toEqual({ systemID: 'DEV', userName: 'ALICE' });
    expect(bob.client).toMatchObject({
      responsible: 'BOB',
      masterSystem: 'QAS',
    });
    expect(bob.info).toEqual({ systemID: 'QAS', userName: 'BOB' });
  });

  it('a run with no responsible person does not inherit the process one', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
    const seen = await runWithRequestSystem(
      { responsible: undefined, masterSystem: 'DEV' },
      whatLibSees,
    );
    expect(seen.client.responsible).toBeUndefined();
    expect(seen.client.masterSystem).toBe('DEV');

    const none = await runWithRequestSystem({}, whatLibSees);
    expect(none.client.responsible).toBeUndefined();
    expect(none.client.masterSystem).toBeUndefined();
    expect(none.info).toBeNull();
  });

  it('outside a run, lib sees the process values', async () => {
    setSystemContext({ responsible: 'PROCESS', masterSystem: 'PRC' });
    const seen = await whatLibSees();
    expect(seen.client).toMatchObject({
      responsible: 'PROCESS',
      masterSystem: 'PRC',
    });
    expect(getSystemContext().responsible).toBe('PROCESS');
  });

  it('carries the process master language into the run', async () => {
    setSystemContext({ masterLanguage: 'EN' });
    const seen = await runWithRequestSystem(
      { responsible: 'ALICE' },
      whatLibSees,
    );
    expect(seen.client.masterLanguage).toBe('EN');
    expect(seen.client.responsible).toBe('ALICE');
  });
});
