/**
 * Unit tests for CloudSdkAbapConnection.probe() — the single-shot connectivity
 * probe used by the active-destination probe.
 *
 * Under test (the correctness guarantees from review):
 * - sends the caller's Basic auth, the X-SAP-Client header AND the
 *   sap-usercontext cookie for the configured client (header alone is ignored
 *   by ABAP → wrong mandant)
 * - passes a server-side timeout
 * - makes EXACTLY ONE executeHttpRequest call — no retry on any status
 *   (401/403 lockout safety; pointless to retry TLS/5xx for a diagnostic)
 */

const mockExec = jest.fn();
jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: (...args: unknown[]) => mockExec(...args),
}));
// env-setup just primes process.env; stub it so the import is inert under jest.
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

beforeEach(() => jest.clearAllMocks());

describe('CloudSdkAbapConnection.probe', () => {
  it('sends caller Basic auth, X-SAP-Client header, sap-usercontext cookie and a timeout — in one call', async () => {
    mockExec.mockResolvedValue({ status: 200, data: '<discovery/>' });
    const r = await makeConn().probe('/sap/bc/adt/discovery');

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [dest, opts] = mockExec.mock.calls[0] as [
      { destinationName: string },
      {
        method: string;
        url: string;
        timeout: number;
        headers: Record<string, string>;
      },
    ];
    expect(dest).toEqual({ destinationName: 'S4HANA_QAS' });
    expect(opts.method).toBe('GET');
    expect(opts.url).toBe('http://sap.example.com:44300/sap/bc/adt/discovery');
    expect(opts.timeout).toBe(12_000);
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.headers['X-SAP-Client']).toBe('600');
    expect(opts.headers.Cookie).toContain('sap-usercontext=sap-client=600');

    expect(r).toEqual({ httpCode: 200, rawMessage: '<discovery/>' });
  });

  it('does NOT retry on 401 (lockout safety) and returns the classified-ready result', async () => {
    mockExec.mockRejectedValue({
      response: { status: 401, data: 'Anmeldung fehlgeschlagen' },
    });
    const r = await makeConn().probe('/sap/bc/adt/discovery');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(r.httpCode).toBe(401);
    expect(r.rawMessage).toContain('Anmeldung fehlgeschlagen');
  });

  it('does NOT retry on 500 either — single attempt for diagnostics', async () => {
    mockExec.mockRejectedValue({
      response: {
        status: 500,
        data: 'SSLHandshakeException: certificate_expired',
      },
    });
    const r = await makeConn().probe('/sap/bc/adt/discovery');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(r.httpCode).toBe(500);
    expect(r.rawMessage).toContain('certificate_expired');
  });
});
