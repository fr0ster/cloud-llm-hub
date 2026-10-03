/**
 * The SAP client (mandant) follows the same precedence as the system kind:
 * the request's `x-sap-client` wins over the destination's `sap-client`, which
 * applies when no header is sent. Checked on each channel's config path:
 * - raw MCP route — `extractSapContext` (mcp-manager.ts);
 * - /v1/chat/completions and /v1/messages — `establishRequestConnection`;
 * - execute_step — `buildConnectionForDestination` (agent-mcp.ts).
 * Each path also refuses an unknown `x-sap-system-type` before building a
 * connection.
 */

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: { user: { id: 'alice', is: () => true } },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-manager', () =>
  require('./helpers/channel-harness').agentManagerMock(),
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async (destinationName: string) => ({
    destinationName,
    proxyType: 'OnPremise',
    authenticationType: 'NoAuthentication',
    sapConfig: { url: 'http://sap.invalid', authType: 'basic', client: '100' },
  }),
}));

const built: Array<{ sapConfig: { client?: string } }> = [];
jest.mock('../../srv/connections/connectionFactory', () => {
  const actual = jest.requireActual('../../srv/connections/connectionFactory');
  return {
    ...actual,
    createConnection: (opts: { sapConfig: { client?: string } }) => {
      built.push(opts);
      return { connect: async () => {} };
    },
  };
});

import type { Request, Response } from 'express';
import { buildConnectionForDestination } from '../../srv/agent-mcp';
import { establishRequestConnection } from '../../srv/lib/request-connection';
import { extractSapContext } from '../../srv/mcp-manager';

const creds = {
  'x-sap-destination': 'DEST',
  'x-sap-login': 'developer',
  'x-sap-password': 'secret',
};
const req = (headers: Record<string, string>) =>
  ({ headers }) as unknown as Request;

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    writeHead(code: number) {
      res.status = code;
      return res;
    },
    end(payload: string) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  built.length = 0;
});

describe('raw MCP route — extractSapContext', () => {
  it('x-sap-client overrides the destination client', async () => {
    const ctx = await extractSapContext(
      req({ ...creds, 'x-sap-client': '999' }),
    );
    expect(ctx.sapConfig.client).toBe('999');
  });

  it('the destination client applies without the header', async () => {
    const ctx = await extractSapContext(req(creds));
    expect(ctx.sapConfig.client).toBe('100');
    expect(ctx.systemType).toBe('onprem');
  });
});

describe('/v1 channels — establishRequestConnection', () => {
  it('x-sap-client overrides the destination client', async () => {
    const r = await establishRequestConnection(
      req({ ...creds, 'x-sap-client': '999' }),
      fakeRes() as unknown as Response,
      'DEST',
    );
    expect(r.handled).toBe(false);
    expect(built[0].sapConfig.client).toBe('999');
  });

  it('the destination client applies without the header', async () => {
    await establishRequestConnection(
      req(creds),
      fakeRes() as unknown as Response,
      'DEST',
    );
    expect(built[0].sapConfig.client).toBe('100');
  });

  it('an unknown x-sap-system-type is answered 400, with no connection built', async () => {
    const res = fakeRes();
    const r = await establishRequestConnection(
      req({ ...creds, 'x-sap-system-type': 'bogus' }),
      res as unknown as Response,
      'DEST',
    );
    expect(r.handled).toBe(true);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('INVALID_SYSTEM_TYPE');
    expect(built).toHaveLength(0);
  });
});

describe('execute_step — buildConnectionForDestination', () => {
  it('x-sap-client overrides the destination client', async () => {
    const b = await buildConnectionForDestination(
      req({ ...creds, 'x-sap-client': '999' }),
      'DEST',
    );
    expect(b.sapConfig.client).toBe('999');
    expect(built[0].sapConfig.client).toBe('999');
  });

  it('the destination client applies without the header', async () => {
    const b = await buildConnectionForDestination(req(creds), 'DEST');
    expect(b.sapConfig.client).toBe('100');
  });

  it('an unknown x-sap-system-type is refused, with no connection built', async () => {
    await expect(
      buildConnectionForDestination(
        req({ ...creds, 'x-sap-system-type': 'bogus' }),
        'DEST',
      ),
    ).rejects.toThrow(/x-sap-system-type must be one of/);
    expect(built).toHaveLength(0);
  });
});
