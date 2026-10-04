/**
 * Unit tests for createConnection's direct path (no BTP destination).
 *
 * The connector class is how `@mcp-abap-adt/connection` is told which system
 * it dials, so the hub picks it from the DECLARED kind (`lib/system-type.ts`),
 * never from the credential:
 * - systemType cloud → AdtCloudConnector
 * - systemType onprem / legacy → AdtOnPremConnector
 * The credential follows the auth type, from `@mcp-abap-adt/auth-providers` 5:
 * - basic → BasicAuthProvider
 * - jwt   → TokenAuthProvider.fixed (the hub holds no refresher)
 * - any other auth type → refused (use a destination)
 * - a destination name → CloudSdkAbapConnection, whatever the auth type
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BasicAuthProvider,
  TokenAuthProvider,
} from '@mcp-abap-adt/auth-providers';
import {
  AdtCloudConnector,
  AdtOnPremConnector,
  AuthRefusedError,
} from '@mcp-abap-adt/connection';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import {
  createConnection,
  getConnectionTypeName,
  isDirectConnector,
} from '../../srv/connections/connectionFactory';

const URL = 'https://sap.example.com:443';
const basic = {
  url: URL,
  authType: 'basic' as const,
  username: 'U',
  password: 'P',
};
const jwt = { url: URL, authType: 'jwt' as const, jwtToken: 'token' };

describe('createConnection — direct path: the declared kind picks the connector', () => {
  it('onprem → on-prem connector, with a BasicAuthProvider for basic auth', () => {
    const conn = createConnection({ sapConfig: basic, systemType: 'onprem' });
    expect(conn).toBeInstanceOf(AdtOnPremConnector);
    expect((conn as AdtOnPremConnector).credential).toBeInstanceOf(
      BasicAuthProvider,
    );
    expect(getConnectionTypeName(conn)).toBe(
      'AdtOnPremConnector (Direct, on-premise)',
    );
  });

  it('legacy is an on-premise system → on-prem connector', () => {
    const conn = createConnection({ sapConfig: basic, systemType: 'legacy' });
    expect(conn).toBeInstanceOf(AdtOnPremConnector);
  });

  it('cloud → cloud connector, with a fixed TokenAuthProvider for jwt auth', () => {
    const conn = createConnection({ sapConfig: jwt, systemType: 'cloud' });
    expect(conn).toBeInstanceOf(AdtCloudConnector);
    const credential = (conn as AdtCloudConnector).credential;
    expect(credential).toBeInstanceOf(TokenAuthProvider);
    expect(credential.kind).toBe('token');
    expect(getConnectionTypeName(conn)).toBe(
      'AdtCloudConnector (Direct, ABAP Cloud)',
    );
  });

  it('the credential decides nothing: jwt on onprem → on-prem connector, basic on cloud → cloud connector', () => {
    const tokenOnPrem = createConnection({
      sapConfig: jwt,
      systemType: 'onprem',
    });
    expect(tokenOnPrem).toBeInstanceOf(AdtOnPremConnector);
    expect((tokenOnPrem as AdtOnPremConnector).credential).toBeInstanceOf(
      TokenAuthProvider,
    );
    const basicOnCloud = createConnection({
      sapConfig: basic,
      systemType: 'cloud',
    });
    expect(basicOnCloud).toBeInstanceOf(AdtCloudConnector);
    expect((basicOnCloud as AdtCloudConnector).credential).toBeInstanceOf(
      BasicAuthProvider,
    );
  });

  it('refuses an auth type it has no connector for', () => {
    expect(() =>
      createConnection({
        sapConfig: { url: URL, authType: 'saml' } as never,
        systemType: 'onprem',
      }),
    ).toThrow(/Unsupported authType "saml"/);
  });

  it('uses CloudSdkAbapConnection when a destination is named', () => {
    const conn = createConnection({
      sapConfig: { url: '', authType: 'basic', username: 'U', password: 'P' },
      destinationName: 'S4HANA_DEV',
    });
    expect(conn).toBeInstanceOf(CloudSdkAbapConnection);
    expect(isDirectConnector(conn)).toBe(false);
  });

  it('isDirectConnector recognises both direct connectors', () => {
    expect(
      isDirectConnector(
        createConnection({ sapConfig: basic, systemType: 'onprem' }),
      ),
    ).toBe(true);
    expect(
      isDirectConnector(
        createConnection({ sapConfig: jwt, systemType: 'cloud' }),
      ),
    ).toBe(true);
  });
});

describe('a refused Basic logon on a direct connector', () => {
  it('rejects with AuthRefusedError after exactly one logon request (no retry loop)', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(401, { 'www-authenticate': 'Basic realm="SAP"' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const conn = createConnection({
        sapConfig: { ...basic, url: `http://127.0.0.1:${port}` },
        systemType: 'onprem',
      });
      const err = await conn.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AuthRefusedError);
      expect((err as AuthRefusedError).at).toBe('logon');
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
