/**
 * The raw MCP route (`/mcp/stream/http`) runs its tool calls inside the
 * request's system scope, like the agent channels.
 *
 * lib 16 refuses a create that finds no responsible person
 * (`system_context_missing`) before any request is sent. The raw route builds
 * an `EmbeddableMcpServer` per request and hands the HTTP request to the MCP
 * SDK transport; the scope must survive the SDK's dispatch into lib's handler.
 * So this drives the real server, the real transport and the real `CreateClass`
 * handler over HTTP, faking only the destination lookup and the ABAP
 * connection (which records what would go on the wire).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

jest.mock('../../srv/connections/destinationResolver', () => ({
  // DEST: per-user credentials (the in-scope deployments). DEST_SVC: a
  // destination with its own auth, the only way to reach a create with no
  // x-sap-login and so no responsible at all.
  resolveDestinationSapConfig: async (destinationName: string) =>
    destinationName === 'DEST_SVC'
      ? {
          destinationName,
          proxyType: 'Internet',
          authenticationType: 'BasicAuthentication',
          sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
        }
      : {
          destinationName,
          proxyType: 'OnPremise',
          authenticationType: 'NoAuthentication',
          sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
        },
}));

type Sent = { method: string; url: string; data?: unknown };
const wire: Sent[] = [];

jest.mock('../../srv/connections/connectionFactory', () => {
  const actual = jest.requireActual('../../srv/connections/connectionFactory');
  return {
    ...actual,
    createConnection: () => ({
      connect: async () => {},
      getBaseUrl: async () => 'http://sap.invalid',
      getSessionId: () => 'session',
      setSessionType: () => {},
      makeAdtRequest: async (o: {
        method: string;
        url: string;
        data?: unknown;
      }) => {
        wire.push({ method: o.method, url: o.url, data: o.data });
        return { status: 201, statusText: 'Created', headers: {}, data: '' };
      },
    }),
  };
});

import type { Request } from 'express';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const result = await createMCPServerForRequest(req as unknown as Request, {
      establish: false,
    });
    try {
      await result.handle(req, res, body);
    } finally {
      await result.cleanup();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  wire.length = 0;
});

async function createClass(headers: Record<string, string>) {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sap-destination': 'DEST',
      'x-sap-password': 'secret',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'CreateClass',
        arguments: { class_name: 'ZCL_SCOPE_PROBE', package_name: '$TMP' },
      },
    }),
  });
  return { status: res.status, text: await res.text() };
}

describe('raw /mcp/stream/http create — the request system scope', () => {
  it('the uppercased x-sap-login reaches lib as the responsible person', async () => {
    const r = await createClass({ 'x-sap-login': 'developer' });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('system_context_missing');
    const post = wire.find((s) => s.method === 'POST');
    expect(post).toBeDefined();
    expect(String(post?.data)).toContain('adtcore:responsible="DEVELOPER"');
  });

  it('x-sap-responsible overrides the login', async () => {
    await createClass({
      'x-sap-login': 'developer',
      'x-sap-responsible': 'owner',
    });
    const post = wire.find((s) => s.method === 'POST');
    expect(String(post?.data)).toContain('adtcore:responsible="OWNER"');
  });

  it('a create with no responsible is refused, and nothing reaches the wire', async () => {
    const r = await createClass({ 'x-sap-destination': 'DEST_SVC' });
    expect(r.text).toContain('system_context_missing');
    expect(wire.filter((s) => s.method === 'POST')).toHaveLength(0);
    expect(wire.some((s) => /_action=LOCK/.test(s.url))).toBe(false);
    expect(wire).toHaveLength(0);
  });

  it('an unknown x-sap-system-type is refused with a 400', async () => {
    let caught: unknown;
    try {
      await createMCPServerForRequest({
        headers: {
          'x-sap-destination': 'DEST',
          'x-sap-login': 'developer',
          'x-sap-password': 'secret',
          'x-sap-system-type': 'bogus',
        },
      } as unknown as Request);
    } catch (e) {
      caught = e;
    }
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    expect((caught as Error).message).toMatch(/x-sap-system-type/);
    expect(wire).toHaveLength(0);
  });
});
