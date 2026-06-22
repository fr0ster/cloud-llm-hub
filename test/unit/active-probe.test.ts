/**
 * Unit tests for runActiveDestinationProbe — the active-destination probe that
 * runs under the CALLER's own SAP identity.
 *
 * Under test:
 * - missing destination / incomplete credentials → 400 (no destination-auth fallback)
 * - caller Basic auth + client are applied to the connection config
 * - the factory is called WITH destinationName (so it selects CloudSdkAbapConnection)
 * - exactly one probe() call; result is classified with the 'caller' identity
 */

// --- mocks ---------------------------------------------------------------

const mockResolve = jest.fn();
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: (...args: unknown[]) => mockResolve(...args),
}));

const mockProbe = jest.fn();
const mockCreateConnection = jest.fn((_opts: Record<string, unknown>) => ({
  probe: mockProbe,
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: (opts: Record<string, unknown>) =>
    mockCreateConnection(opts),
}));

import {
  ActiveProbeBadRequest,
  runActiveDestinationProbe,
} from '../../srv/lib/active-probe';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({
    sapConfig: { url: 'http://sap.example.com:44300', authType: 'basic' },
    proxyType: 'OnPremise',
    destinationName: 'S4HANA_QAS',
  });
  mockProbe.mockResolvedValue({ httpCode: 200, rawMessage: '' });
});

const creds = {
  destination: 'S4HANA_QAS',
  login: 'DEVELOPER',
  password: 'secret',
  client: '600',
};

describe('runActiveDestinationProbe', () => {
  it('rejects with 400 when destination header is missing', async () => {
    await expect(
      runActiveDestinationProbe({ login: 'u', password: 'p' }),
    ).rejects.toBeInstanceOf(ActiveProbeBadRequest);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it('rejects with 400 when only one credential is provided (no destination-auth fallback)', async () => {
    await expect(
      runActiveDestinationProbe({ destination: 'S4HANA_QAS', login: 'u' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      runActiveDestinationProbe({ destination: 'S4HANA_QAS', password: 'p' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("applies the caller's Basic auth + client to the connection config", async () => {
    await runActiveDestinationProbe(creds);
    const opts = mockCreateConnection.mock.calls[0][0] as {
      destinationName: string;
      sapConfig: Record<string, unknown>;
    };
    // factory MUST get destinationName → selects CloudSdkAbapConnection
    expect(opts.destinationName).toBe('S4HANA_QAS');
    expect(opts.sapConfig.authType).toBe('basic');
    expect(opts.sapConfig.username).toBe('DEVELOPER');
    expect(opts.sapConfig.password).toBe('secret');
    expect(opts.sapConfig.client).toBe('600');
    expect(opts.sapConfig.jwtToken).toBeUndefined();
  });

  it('probes exactly once and returns ok for a 2xx', async () => {
    const r = await runActiveDestinationProbe(creds);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockProbe).toHaveBeenCalledWith('/sap/bc/adt/discovery');
    expect(r.status).toBe('ok');
    expect(r.name).toBe('S4HANA_QAS');
  });

  it('classifies a 401 with the caller-identity hint (blames the user, not the destination)', async () => {
    mockProbe.mockResolvedValue({
      httpCode: 401,
      rawMessage: 'Anmeldung fehlgeschlagen',
    });
    const r = await runActiveDestinationProbe(creds);
    expect(r.status).toBe('backend_auth_failed');
    expect(r.hint).toMatch(/your SAP login|client number|log in again/i);
    expect(r.hint).not.toMatch(/destination User\/Password/i);
  });

  it('surfaces a TLS certificate failure via classifyProbe', async () => {
    mockProbe.mockResolvedValue({
      httpCode: 500,
      rawMessage: 'SSLHandshakeException: certificate_expired',
    });
    const r = await runActiveDestinationProbe(creds);
    expect(r.hint).toMatch(/certificate|TLS/i);
  });

  it('computes latency from the injected clock', async () => {
    let t = 1000;
    const clock = () => t;
    mockProbe.mockImplementation(async () => {
      t = 1175;
      return { httpCode: 200, rawMessage: '' };
    });
    const r = await runActiveDestinationProbe(creds, clock);
    expect(r.latencyMs).toBe(175);
  });
});
