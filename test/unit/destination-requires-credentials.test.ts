/**
 * Unit tests for destinationRequiresCredentials — decides whether the chat UI
 * must prompt for the caller's own SAP login/password on connect.
 *
 * Policy (mirrors srv/lib/request-connection.ts):
 * - on-premise (Cloud Connector) → true
 * - NoAuthentication             → true
 * - cloud / Internet with JWT    → false
 */

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

import { destinationRequiresCredentials } from '../../srv/agent-manager';

describe('destinationRequiresCredentials', () => {
  test('on-premise destination → true', () => {
    expect(
      destinationRequiresCredentials('OnPremise', 'BasicAuthentication'),
    ).toBe(true);
  });

  test('OnPremise is case-insensitive → true', () => {
    expect(
      destinationRequiresCredentials('onpremise', 'BasicAuthentication'),
    ).toBe(true);
  });

  test('NoAuthentication (even on Internet proxy) → true', () => {
    expect(destinationRequiresCredentials('Internet', 'NoAuthentication')).toBe(
      true,
    );
  });

  test('cloud Internet destination with OAuth2 JWT → false', () => {
    expect(
      destinationRequiresCredentials('Internet', 'OAuth2ClientCredentials'),
    ).toBe(false);
  });

  test('cloud principal propagation → false', () => {
    expect(
      destinationRequiresCredentials('Internet', 'OAuth2SAMLBearerAssertion'),
    ).toBe(false);
  });

  test('undefined metadata → false (no spurious prompt)', () => {
    expect(destinationRequiresCredentials(undefined, undefined)).toBe(false);
  });
});
