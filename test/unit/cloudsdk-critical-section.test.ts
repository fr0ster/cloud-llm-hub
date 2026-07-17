jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn(async () => ({
    status: 200,
    data: '',
    headers: {},
  })),
}));

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';

const mockExec = executeHttpRequest as jest.Mock;

// The BTP-destination connection `implements AbapConnection` (does NOT extend the
// base), so core's `conn?.beginCriticalSection?.()` wrapping was a silent no-op and
// a slow write on a BTP destination got cut mid-flight, orphaning the lock. These
// tests cover the ref-counted critical-section primitives we added.
function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'https://example',
      authType: 'basic',
      username: 'U',
      password: 'P',
    } as any,
    'S4HANA_TEST',
  );
}

describe('CloudSdkAbapConnection critical section', () => {
  it('starts outside a critical section', () => {
    expect(makeConn().isInCriticalSection()).toBe(false);
  });

  it('begin enters, end leaves', () => {
    const c = makeConn();
    c.beginCriticalSection();
    expect(c.isInCriticalSection()).toBe(true);
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false);
  });

  it('is reference-counted — a nested pair does not leave early', () => {
    const c = makeConn();
    c.beginCriticalSection();
    c.beginCriticalSection();
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(true); // still inside (depth 1)
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false); // outermost ended
  });

  it('over-ending is clamped and never throws', () => {
    const c = makeConn();
    c.endCriticalSection();
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false);
  });
});

describe('CloudSdkAbapConnection closeSession', () => {
  beforeEach(() => mockExec.mockClear());

  it('is a no-op (no network call) when the connection was never stateful', async () => {
    const c = makeConn();
    await c.closeSession();
    expect(mockExec).not.toHaveBeenCalled(); // nothing to release
  });

  it('sends ONE stateless GET carrying the connection-id to drop the ADT session', async () => {
    const c = makeConn();
    c.setSessionType('stateful');
    await c.closeSession();
    expect(mockExec).toHaveBeenCalledTimes(1);
    const [, opts] = mockExec.mock.calls[0];
    expect(opts.method).toBe('GET');
    expect(opts.headers['x-sap-adt-sessiontype']).toBe('stateless');
    expect(opts.headers['sap-adt-connection-id']).toBe(c.getSessionId());
  });

  it('is idempotent — a second closeSession does not fire again', async () => {
    const c = makeConn();
    c.setSessionType('stateful');
    await c.closeSession();
    await c.closeSession();
    expect(mockExec).toHaveBeenCalledTimes(1); // wentStateful cleared after first
  });
});
