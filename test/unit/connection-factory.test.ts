/**
 * Unit tests for createConnection's direct path (no BTP destination).
 *
 * connection 6.0 removed createAbapConnection, which picked the connector from
 * the auth type. The hub now states that mapping itself:
 * - basic → AdtOnPremConnector
 * - jwt   → AdtCloudConnector
 * - any other auth type → refused (use a destination)
 * - a destination name → CloudSdkAbapConnection, whatever the auth type
 */

import {
  AdtCloudConnector,
  AdtOnPremConnector,
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
} from '../../srv/connections/connectionFactory';

const URL = 'https://sap.example.com:443';

describe('createConnection — direct path', () => {
  it('builds an on-prem connector for basic auth', () => {
    const conn = createConnection({
      sapConfig: { url: URL, authType: 'basic', username: 'U', password: 'P' },
    });
    expect(conn).toBeInstanceOf(AdtOnPremConnector);
    expect(getConnectionTypeName(conn)).toBe(
      'AdtOnPremConnector (Direct Basic)',
    );
  });

  it('builds a cloud connector for jwt auth', () => {
    const conn = createConnection({
      sapConfig: { url: URL, authType: 'jwt', jwtToken: 'token' },
    });
    expect(conn).toBeInstanceOf(AdtCloudConnector);
    expect(getConnectionTypeName(conn)).toBe('AdtCloudConnector (Direct JWT)');
  });

  it('refuses an auth type it has no connector for', () => {
    expect(() =>
      createConnection({
        sapConfig: { url: URL, authType: 'saml' } as never,
      }),
    ).toThrow(/Unsupported authType "saml"/);
  });

  it('uses CloudSdkAbapConnection when a destination is named', () => {
    const conn = createConnection({
      sapConfig: { url: '', authType: 'basic', username: 'U', password: 'P' },
      destinationName: 'S4HANA_DEV',
    });
    expect(conn).toBeInstanceOf(CloudSdkAbapConnection);
  });
});
