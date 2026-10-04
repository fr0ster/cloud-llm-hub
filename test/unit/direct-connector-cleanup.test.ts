/**
 * A direct (`x-sap-url`) connection on the raw MCP route:
 * - is built for the DECLARED kind — `x-sap-system-type`, else on-premise; the
 *   auth type and the URL decide nothing;
 * - ends its session with `disconnect()` (the logoff) when the request is
 *   cleaned up. The direct connectors have no `closeSession` / `reset`, so
 *   before this the session — and a lock it kept — lived until SAP's timeout.
 */

import {
  AdtCloudConnector,
  AdtOnPremConnector,
} from '@mcp-abap-adt/connection';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {
        user: { id: 'alice', is: (role: string) => role !== 'system-user' },
      },
    },
  }),
  { virtual: true },
);

import type { Request } from 'express';
import { safeStop } from '../../srv/lib/request-connection';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

const direct = {
  'x-sap-url': 'https://sap.example.invalid',
  'x-sap-auth-type': 'basic',
  'x-sap-login': 'developer',
  'x-sap-password': 'secret',
};

afterEach(() => jest.restoreAllMocks());

async function build(headers: Record<string, string>) {
  return createMCPServerForRequest({ headers } as unknown as Request, {
    establish: false,
  });
}

describe('raw route, direct connection', () => {
  it('an x-sap-url connection is on-premise unless declared — even with an https URL', async () => {
    const r = await build(direct);
    expect(r.connection).toBeInstanceOf(AdtOnPremConnector);
    await r.cleanup();
  });

  it('x-sap-system-type: cloud builds the cloud connector', async () => {
    const r = await build({ ...direct, 'x-sap-system-type': 'cloud' });
    expect(r.connection).toBeInstanceOf(AdtCloudConnector);
    await r.cleanup();
  });

  it('an unknown x-sap-system-type is refused with a 400', async () => {
    const err = await build({ ...direct, 'x-sap-system-type': 'bogus' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { statusCode?: number }).statusCode).toBe(400);
  });

  it('cleanup calls disconnect() on the direct connector', async () => {
    const disconnect = jest
      .spyOn(AdtOnPremConnector.prototype, 'disconnect')
      .mockResolvedValue(undefined);
    const r = await build(direct);
    await r.cleanup();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('safeStop on a direct connector', () => {
  it('calls disconnect() and never throws, even when disconnect rejects', async () => {
    const disconnect = jest
      .spyOn(AdtCloudConnector.prototype, 'disconnect')
      .mockRejectedValue(new Error('boom'));
    const r = await build({ ...direct, 'x-sap-system-type': 'cloud' });
    await expect(safeStop(r.connection)).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
