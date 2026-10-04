/**
 * Exactly one ICF logoff per request.
 *
 * A request's teardown runs from both the client's `close` listener and the
 * handler's `finally`, usually at the same time. Each read the server-issued
 * `SAP_SESSIONID` before the other had dropped it, so each sent a logoff — two
 * per request on a destination connection (measured on a local env
 * destination, ~100 ms each). `closeSession` is now single-flight, and the raw
 * route's `cleanup` runs its teardown once.
 */

jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn(),
}));
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {
        user: { id: 'alice', is: (role: string) => role !== 'system-user' },
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async (destinationName: string) => ({
    destinationName,
    proxyType: 'Internet',
    authenticationType: 'NoAuthentication',
    sapConfig: { url: 'https://example', authType: 'basic', client: '100' },
  }),
}));

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { Request } from 'express';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { safeStop } from '../../srv/lib/request-connection';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

const mockExec = executeHttpRequest as jest.Mock;
const logoffs = () =>
  mockExec.mock.calls.filter((c) =>
    String(c[1]?.url ?? '').includes('/sap/public/bc/icf/logoff'),
  ).length;

beforeEach(() => {
  mockExec.mockReset();
  // An on-premise answer: the logon is the establishing call and a real
  // SAP_SESSIONID arrives with it.
  mockExec.mockImplementation(async () => ({
    status: 200,
    data: '',
    headers: {
      'x-csrf-token': 'csrf',
      'set-cookie': [
        'sap-XSRF_DEV_100=abc; path=/',
        'SAP_SESSIONID_DEV_100=SERVER_ISSUED; path=/',
      ],
    },
  }));
});

it('CloudSdkAbapConnection: concurrent closeSession calls send one logoff', async () => {
  const c = new CloudSdkAbapConnection(
    { url: 'https://example', authType: 'basic', client: '100' } as never,
    'DEST',
  );
  await c.connect();
  await Promise.all([c.closeSession(), c.closeSession(), safeStop(c)]);
  expect(logoffs()).toBe(1);
  // A later call finds no session left and sends nothing.
  await c.closeSession();
  expect(logoffs()).toBe(1);
});

it('raw route: close listener + finally teardown sends one logoff per request', async () => {
  const r = await createMCPServerForRequest({
    headers: {
      'x-sap-destination': 'DEST',
      'x-sap-login': 'developer',
      'x-sap-password': 'secret',
    },
  } as unknown as Request);
  expect(r.connection).toBeInstanceOf(CloudSdkAbapConnection);
  // What server.ts does: `res.on('close', cleanup)` and `finally { cleanup() }`.
  await Promise.all([r.cleanup(), r.cleanup()]);
  expect(logoffs()).toBe(1);
});

const get = (c: CloudSdkAbapConnection) =>
  c.makeAdtRequest({
    url: '/sap/bc/adt/discovery',
    method: 'GET',
    timeout: 5000,
  });

it('a session reopened after a completed closeSession gets its own logoff', async () => {
  const c = new CloudSdkAbapConnection(
    { url: 'https://example', authType: 'basic', client: '100' } as never,
    'DEST',
  );
  await c.connect();
  await c.closeSession();
  expect(logoffs()).toBe(1);
  // closeSession alone does not end the connection: a new request reopens a
  // session, and the next close must give that one back too.
  await get(c);
  await c.closeSession();
  expect(logoffs()).toBe(2);
});

describe('after the teardown (safeStop → close) nothing reopens a session', () => {
  const conn = () =>
    new CloudSdkAbapConnection(
      { url: 'https://example', authType: 'basic', client: '100' } as never,
      'DEST',
    );

  it('an early client abort: the handler reaching SAP afterwards is refused, nothing is sent', async () => {
    const r = await createMCPServerForRequest(
      {
        headers: {
          'x-sap-destination': 'DEST',
          'x-sap-login': 'developer',
          'x-sap-password': 'secret',
        },
      } as unknown as Request,
      { establish: false },
    );
    await r.cleanup(); // the client left before the handler reached SAP
    const sent = mockExec.mock.calls.length;
    await expect(
      r.connection.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 5000,
      }),
    ).rejects.toThrow(/is closed/);
    await expect(r.connection.connect()).rejects.toThrow(/is closed/);
    expect(mockExec.mock.calls.length).toBe(sent);
    await r.cleanup();
    expect(logoffs()).toBe(0);
  });

  it('a request inside an open section still runs; the logoff follows the section', async () => {
    const c = conn();
    await c.connect();
    c.beginCriticalSection();
    const stop = safeStop(c);
    await new Promise((r) => setTimeout(r, 20));
    await expect(get(c)).resolves.toBeDefined(); // e.g. the chain's UNLOCK
    expect(logoffs()).toBe(0);
    c.endCriticalSection();
    await stop;
    expect(logoffs()).toBe(1);
    await expect(get(c)).rejects.toThrow(/is closed/);
  });
});
