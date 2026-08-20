jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn(async () => ({
    status: 200,
    data: '',
    // The generated SAP_SESSIONID is only injected once the server's
    // sap-XSRF_<SID>_<CLIENT> cookie has been seen, so the mock returns one.
    headers: { 'set-cookie': ['sap-XSRF_DEV_100=abc; path=/'] },
  })),
}));

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';

const mockExec = executeHttpRequest as jest.Mock;

// A connection costs one SAP session the moment it presents a SAP_SESSIONID of
// its own — SAP holds a session per distinct value until it times out. Sessions
// were piling up on the ABAP system because closeSession() only released
// connections that had gone STATEFUL, while read-only and probe connections
// minted a session and walked away. Anything we open must be closeable.
function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'https://example',
      authType: 'basic',
      username: 'U',
      password: 'P',
      client: '100',
    } as never,
    'S4HANA_TEST',
  );
}

/** Requests whose headers ask ADT to end the session for this connection-id. */
function releaseCalls(): unknown[] {
  return mockExec.mock.calls.filter(
    (c) => c[1]?.headers?.['x-sap-adt-sessiontype'] === 'stateless',
  );
}

describe('CloudSdkAbapConnection session release', () => {
  beforeEach(() => mockExec.mockClear());

  it('releases a session opened by a read-only request', async () => {
    const c = makeConn();
    // Two GETs: the first only captures the server's sap-XSRF_<SID>_<CLIENT>
    // cookie, and our SAP_SESSIONID is minted while building the second. From
    // that point the connection costs a session on the server, even though it
    // never went stateful.
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    expect(releaseCalls()).toHaveLength(0);

    await c.closeSession();
    expect(releaseCalls()).toHaveLength(1);
  });

  it('still releases a stateful session', async () => {
    const c = makeConn();
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    c.setSessionType('stateful');

    await c.closeSession();
    expect(releaseCalls()).toHaveLength(1);
  });

  it('a single request opens nothing — the id is minted on the next one', async () => {
    const c = makeConn();
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    await c.closeSession();
    expect(releaseCalls()).toHaveLength(0);
  });

  it('a probe alone opens nothing — it never merges cookies', async () => {
    const c = makeConn();
    await c.probe('/sap/bc/adt/compatibility/graph');
    await c.closeSession();
    expect(releaseCalls()).toHaveLength(0);
  });

  it('does nothing when no session was ever opened', async () => {
    const c = makeConn();
    await c.closeSession();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('is idempotent — a second close does not re-present the session', async () => {
    const c = makeConn();
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });
    await c.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });

    await c.closeSession();
    await c.closeSession();
    expect(releaseCalls()).toHaveLength(1);
  });
});
