/**
 * CloudSdkAbapConnection.makeAdtRequest() sets no deadline.
 *
 * A timeout here is a problem the connector creates: a long ADT request means
 * a lot of data or a loaded system, and cutting it makes the outcome
 * unpredictable. The consumer that wants a bound closes the connection itself,
 * so no `timeout` — not even the one the ADT client passes — reaches
 * executeHttpRequest, inside a critical section or out of it.
 */

const mockExec = jest.fn();
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: (...args: unknown[]) => mockExec(...args),
}));
jest.mock('../../srv/env-setup', () => ({}), { virtual: true });

import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';

function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'http://sap.example.com:44300',
      authType: 'basic',
      username: 'DEVELOPER',
      password: 'secret',
      client: '600',
    } as never,
    'S4HANA_QAS',
  );
}

function lastOpts() {
  const calls = mockExec.mock.calls;
  return calls[calls.length - 1][1] as { timeout?: number };
}

beforeEach(() => jest.clearAllMocks());

describe('CloudSdkAbapConnection.makeAdtRequest deadline', () => {
  const send = (conn: CloudSdkAbapConnection, timeout: number | undefined) =>
    conn.makeAdtRequest({
      url: '/sap/bc/adt/repository/informationsystem/search',
      method: 'GET',
      timeout,
    } as never);

  beforeEach(() =>
    mockExec.mockResolvedValue({ status: 200, data: '<ok/>', headers: {} }),
  );

  it.each([
    ['set by the caller', 90_000],
    ['0 from the ADT client', 0],
    ['omitted', undefined],
  ])('sends no timeout when it is %s', async (_label, timeout) => {
    await send(makeConn(), timeout);
    expect(mockExec).toHaveBeenCalled();
    expect(lastOpts().timeout).toBeUndefined();
  });

  it('sends none inside a critical section either', async () => {
    const conn = makeConn();
    conn.beginCriticalSection();
    await send(conn, 30_000);
    expect(lastOpts().timeout).toBeUndefined();
    conn.endCriticalSection();
  });
});
