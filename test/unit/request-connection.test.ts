/**
 * Unit tests for establishRequestConnection — the fail-closed per-request SAP
 * connection policy shared by /v1/chat/completions and /v1/messages.
 *
 * Policy under test:
 * - on-premise / NoAuthentication destination + no creds  → 401, no connection
 * - on-premise destination + x-sap-login/password         → basic-auth connection
 * - cloud destination + no creds                          → resolved auth (JWT) connection
 * - connect() failure                                     → 401, error written to res
 * - no destination                                        → no-op
 */

import type { Request, Response } from 'express';

// --- mocks ---------------------------------------------------------------

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

const mockResolve = jest.fn();
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: (...args: unknown[]) => mockResolve(...args),
}));

const mockConnect = jest.fn();
const mockCreateConnection = jest.fn((_opts: Record<string, unknown>) => ({
  connect: mockConnect,
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: (opts: Record<string, unknown>) =>
    mockCreateConnection(opts),
}));

const mockSetRequestConnection = jest.fn();
jest.mock('../../srv/agent-manager', () => ({
  setRequestConnection: (...args: unknown[]) =>
    mockSetRequestConnection(...args),
}));

import { establishRequestConnection } from '../../srv/lib/request-connection';

// --- helpers -------------------------------------------------------------

function makeReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request;
}

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  writeHead: jest.Mock;
  end: jest.Mock;
}

function makeRes(): FakeRes {
  const res: Partial<FakeRes> = {};
  res.writeHead = jest.fn((code: number) => {
    res.statusCode = code;
    return res as unknown as Response;
  });
  res.end = jest.fn((payload?: string) => {
    res.body = payload ? JSON.parse(payload) : undefined;
    return res as unknown as Response;
  });
  return res as FakeRes;
}

beforeEach(() => {
  mockResolve.mockReset();
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockCreateConnection.mockClear();
  mockSetRequestConnection.mockReset();
});

// --- tests ---------------------------------------------------------------

describe('establishRequestConnection', () => {
  test('no destination → no-op, no connection, not handled', async () => {
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({}),
      res as unknown as Response,
      undefined,
    );
    expect(result).toEqual({ handled: false });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockSetRequestConnection).not.toHaveBeenCalled();
  });

  test('on-premise destination without credentials → 401, no connection', async () => {
    mockResolve.mockResolvedValue({
      destinationName: 'S4HANA_DEV',
      sapConfig: { url: 'http://onprem', authType: 'basic' },
      proxyType: 'OnPremise',
      authenticationType: 'BasicAuthentication',
    });
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({}),
      res as unknown as Response,
      'S4HANA_DEV',
    );
    expect(result.handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { type: string } }).error.type).toBe(
      'SAP_CREDENTIALS_REQUIRED',
    );
    expect(mockCreateConnection).not.toHaveBeenCalled();
    expect(mockSetRequestConnection).not.toHaveBeenCalled();
  });

  test('NoAuthentication destination without credentials → 401', async () => {
    mockResolve.mockResolvedValue({
      destinationName: 'NOAUTH',
      sapConfig: { url: 'http://noauth', authType: 'basic' },
      proxyType: 'Internet',
      authenticationType: 'NoAuthentication',
    });
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({}),
      res as unknown as Response,
      'NOAUTH',
    );
    expect(result.handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  test('on-premise destination WITH credentials → basic-auth connection', async () => {
    mockResolve.mockResolvedValue({
      destinationName: 'S4HANA_DEV',
      sapConfig: { url: 'http://onprem', authType: 'basic' },
      proxyType: 'OnPremise',
      authenticationType: 'BasicAuthentication',
    });
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({ 'x-sap-login': 'MCPUSER', 'x-sap-password': 'secret' }),
      res as unknown as Response,
      'S4HANA_DEV',
    );
    expect(result.handled).toBe(false);
    expect(result.connection).toBeDefined();
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    const passedConfig = (
      mockCreateConnection.mock.calls[0][0] as {
        sapConfig: Record<string, unknown>;
      }
    ).sapConfig;
    expect(passedConfig.authType).toBe('basic');
    expect(passedConfig.username).toBe('MCPUSER');
    expect(passedConfig.password).toBe('secret');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockSetRequestConnection).toHaveBeenCalledTimes(1);
  });

  test('cloud destination without credentials → uses resolved auth (no 401)', async () => {
    mockResolve.mockResolvedValue({
      destinationName: 'S4HANA_CLOUD',
      sapConfig: { url: 'https://cloud', authType: 'jwt', jwtToken: 'tok' },
      proxyType: 'Internet',
      authenticationType: 'OAuth2ClientCredentials',
    });
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({}),
      res as unknown as Response,
      'S4HANA_CLOUD',
    );
    expect(result.handled).toBe(false);
    expect(result.connection).toBeDefined();
    const passedConfig = (
      mockCreateConnection.mock.calls[0][0] as {
        sapConfig: Record<string, unknown>;
      }
    ).sapConfig;
    // No caller creds → keep the resolved JWT auth untouched.
    expect(passedConfig.authType).toBe('jwt');
    expect(passedConfig.jwtToken).toBe('tok');
    expect(mockSetRequestConnection).toHaveBeenCalledTimes(1);
  });

  test('connect() failure → 401 SAP connection error, not registered', async () => {
    mockResolve.mockResolvedValue({
      destinationName: 'S4HANA_DEV',
      sapConfig: { url: 'http://onprem', authType: 'basic' },
      proxyType: 'OnPremise',
      authenticationType: 'BasicAuthentication',
    });
    mockConnect.mockRejectedValue(new Error('401 Unauthorized'));
    const res = makeRes();
    const result = await establishRequestConnection(
      makeReq({ 'x-sap-login': 'BAD', 'x-sap-password': 'wrong' }),
      res as unknown as Response,
      'S4HANA_DEV',
    );
    expect(result.handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(mockSetRequestConnection).not.toHaveBeenCalled();
  });
});
