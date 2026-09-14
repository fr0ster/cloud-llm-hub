/**
 * Every JSON-RPC POST to /mcp/stream/http used to build a connection AND
 * connect() it — and connect() is an authenticated GET /sap/bc/adt/discovery,
 * i.e. an ABAP logon, i.e. one SM05 session. A connected MCP client pings on a
 * ~10 s cadence and lists tools on every reconnect, so the hub minted a session
 * every few seconds that nothing ever used ("created, never used" in SM05).
 *
 * Only `tools/call` can touch SAP. `initialize`, `notifications/*`,
 * `tools/list` and `ping` are protocol chatter and must cost NO SAP session.
 *
 * A connect() that FAILS must also give back whatever session the attempt
 * already opened — the CSRF fetch retries, so a failed connect can be several
 * logons — instead of dropping the connection object on the floor.
 */

// --- mocks ---------------------------------------------------------------

jest.mock('../../srv/env-setup', () => ({}), { virtual: true });

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
      context: { user: { id: 'u', is: () => true } },
    },
  }),
  { virtual: true },
);

jest.mock(
  '@mcp-abap-adt/core/server',
  () => ({
    EmbeddableMcpServer: class {
      connect = jest.fn(async () => undefined);
    },
  }),
  { virtual: true },
);

jest.mock(
  '@mcp-abap-adt/core/handlers',
  () => ({ ReadVsGetDedupStrategy: class {} }),
  { virtual: true },
);

jest.mock(
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  () => ({
    StreamableHTTPServerTransport: class {
      close = jest.fn(async () => undefined);
    },
  }),
  { virtual: true },
);

jest.mock('../../srv/lib/exposition', () => ({
  resolveExposition: () => ['read'],
}));

jest.mock('../../srv/connections', () => ({
  extractConnectivityContext: () => ({ locationId: undefined }),
  shouldUseConnectivity: () => false,
}));

const mockConnect = jest.fn(async () => undefined);
const mockCloseSession = jest.fn(async () => undefined);
const mockReset = jest.fn();
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => ({
    connect: mockConnect,
    closeSession: mockCloseSession,
    reset: mockReset,
  }),
}));

jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    destinationName: 'E19',
    proxyType: 'OnPremise',
    authenticationType: 'BasicAuthentication',
    sapConfig: { url: 'http://e19:8000', authType: 'basic', client: '100' },
  }),
}));

import type { Request } from 'express';
import {
  createMCPServerForRequest,
  requiresSapSession,
} from '../../srv/mcp-manager';

function makeReq(): Request {
  return {
    headers: {
      'x-sap-destination': 'E19',
      'x-sap-login': 'DEVELOPER',
      'x-sap-password': 'secret',
      'x-sap-client': '100',
    },
  } as unknown as Request;
}

describe('requiresSapSession — which JSON-RPC methods may touch SAP', () => {
  test('tools/call does', () => {
    expect(requiresSapSession({ method: 'tools/call', id: 1 })).toBe(true);
  });

  test.each([
    'initialize',
    'notifications/initialized',
    'tools/list',
    'ping',
    'resources/list',
    'prompts/list',
  ])('%s does not', (method) => {
    expect(requiresSapSession({ method, id: 1 })).toBe(false);
  });

  test('an unparsable body does not', () => {
    expect(requiresSapSession(null)).toBe(false);
    expect(requiresSapSession('not json')).toBe(false);
  });
});

describe('createMCPServerForRequest — SAP session cost', () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockCloseSession.mockClear();
    mockReset.mockClear();
    mockConnect.mockResolvedValue(undefined);
  });

  test('protocol chatter opens NO SAP session', async () => {
    await createMCPServerForRequest(makeReq(), { needsSapSession: false });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('a tool call still validates the connection up front', async () => {
    await createMCPServerForRequest(makeReq(), { needsSapSession: true });
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('defaults to connecting when the caller says nothing', async () => {
    await createMCPServerForRequest(makeReq());
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('a failed connect gives back the session the attempt opened', async () => {
    mockConnect.mockRejectedValueOnce(new Error('401 logon failed'));
    await expect(
      createMCPServerForRequest(makeReq(), { needsSapSession: true }),
    ).rejects.toThrow(/SAP connection failed/);
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });
});
