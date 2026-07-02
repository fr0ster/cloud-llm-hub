/**
 * Unit tests for CloudSdkAbapConnection.makeAdtRequest() timeout forwarding.
 *
 * The SAP Cloud SDK's executeHttpRequest does NOT time out on its own, so the
 * per-request timeout MUST reach every executeHttpRequest call — otherwise a
 * hung BTP-destination request blocks the whole tool call indefinitely (the
 * agent-level Promise.race that used to backstop this was removed).
 *
 * Guarantees under test:
 * - the caller-supplied `timeout` is forwarded to the main request
 * - when the caller omits it, a bounded fallback (120 s) is used instead
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

describe('CloudSdkAbapConnection.makeAdtRequest timeout forwarding', () => {
  it('forwards the caller-supplied timeout to executeHttpRequest', async () => {
    mockExec.mockResolvedValue({ status: 200, data: '<ok/>', headers: {} });

    await makeConn().makeAdtRequest({
      url: '/sap/bc/adt/repository/informationsystem/search',
      method: 'GET',
      timeout: 90_000,
    } as never);

    expect(mockExec).toHaveBeenCalled();
    expect(lastOpts().timeout).toBe(90_000);
  });

  it('falls back to a bounded 120 s timeout when none is supplied', async () => {
    mockExec.mockResolvedValue({ status: 200, data: '<ok/>', headers: {} });

    await makeConn().makeAdtRequest({
      url: '/sap/bc/adt/repository/informationsystem/search',
      method: 'GET',
    } as never);

    expect(mockExec).toHaveBeenCalled();
    expect(lastOpts().timeout).toBe(120_000);
  });
});
