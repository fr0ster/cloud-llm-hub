/**
 * The raw route's server setup ends what it opened on every exit path:
 * - a caller with no MCP role is refused before any connection is built, so
 *   the refusal costs no SAP session;
 * - a setup step that throws after the connection exists (the MCP server's
 *   `connect(transport)`) ends the session before the error propagates.
 */

import { AdtOnPremConnector } from '@mcp-abap-adt/connection';
import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';

const mockUser = { roles: true };
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return {
          user: {
            id: 'alice',
            is: (role: string) => mockUser.roles && role !== 'system-user',
          },
        };
      },
    },
  }),
  { virtual: true },
);

import type { Request } from 'express';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

const direct = {
  'x-sap-url': 'https://sap.example.invalid',
  'x-sap-auth-type': 'basic',
  'x-sap-login': 'developer',
  'x-sap-password': 'secret',
};
const build = (establish: boolean) =>
  createMCPServerForRequest({ headers: direct } as unknown as Request, {
    establish,
  });

afterEach(() => {
  jest.restoreAllMocks();
  mockUser.roles = true;
});

it('a caller with no MCP role is refused before a connection is opened', async () => {
  mockUser.roles = false;
  const connect = jest
    .spyOn(AdtOnPremConnector.prototype, 'connect')
    .mockResolvedValue(undefined);
  const disconnect = jest
    .spyOn(AdtOnPremConnector.prototype, 'disconnect')
    .mockResolvedValue(undefined);
  await expect(build(true)).rejects.toThrow(/Access denied/);
  expect(connect).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
});

it('a setup failure after connect() ends the session', async () => {
  jest
    .spyOn(AdtOnPremConnector.prototype, 'connect')
    .mockResolvedValue(undefined);
  const disconnect = jest
    .spyOn(AdtOnPremConnector.prototype, 'disconnect')
    .mockResolvedValue(undefined);
  jest
    .spyOn(EmbeddableMcpServer.prototype, 'connect')
    .mockRejectedValue(new Error('transport refused'));
  await expect(build(true)).rejects.toThrow(/transport refused/);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
