/**
 * A client abort never cuts LOCK..UNLOCK on a direct (`x-sap-url`) connection.
 *
 * The raw route ends the connection from the response's `close` listener as
 * well as from its `finally`. connection 10's `disconnect()` shuts admission at
 * once, so called mid-chain it would refuse the chain's next request (UNLOCK,
 * activate) and log the session off with the object still locked. The hub's
 * direct connectors wait for the critical section to end first.
 *
 * Driven against a local HTTP server standing in for ABAP: it hands out a CSRF
 * token and a session cookie, answers every request, and records the order.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import {
  AdtOnPremConnector,
  getTimeout,
  OnPremHttpTransport,
} from '@mcp-abap-adt/connection';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

import { createConnection } from '../../srv/connections/connectionFactory';
import { HubOnPremConnector } from '../../srv/connections/directConnectors';
import { safeStop } from '../../srv/lib/request-connection';

const seen: string[] = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, {
      'x-csrf-token': 'csrf-1',
      'set-cookie': 'SAP_SESSIONID_T01_100=session-1; path=/',
      'content-type': 'text/plain',
    });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
});

const tick = () => new Promise((r) => setTimeout(r, 50));
const isLogoff = (s: string) => s.includes('/sap/public/bc/icf/logoff');
const unlock = {
  url: '/sap/bc/adt/oo/classes/zcl_probe?_action=UNLOCK&lockHandle=h',
  method: 'POST',
  timeout: getTimeout('default'),
};
const sapConfig = () => ({
  url,
  authType: 'basic' as const,
  username: 'U',
  password: 'P',
  client: '100',
});

describe('direct connector teardown during a critical section', () => {
  it('an abort mid-chain does not cut the next request; the logoff follows the section end', async () => {
    const conn = createConnection({
      sapConfig: sapConfig(),
      systemType: 'onprem',
    });
    expect(conn).toBeInstanceOf(HubOnPremConnector);
    if (!(conn instanceof HubOnPremConnector)) return;
    await conn.connect();
    conn.beginCriticalSection();

    // The client aborts: the raw route's `close` listener ends the connection.
    let stopped = false;
    const stop = safeStop(conn).then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    expect(seen.some(isLogoff)).toBe(false);

    // The chain carries on: its UNLOCK goes out on the same session.
    const r = await conn.makeAdtRequest(unlock);
    expect(r.status).toBe(200);

    conn.endCriticalSection();
    await stop;
    expect(stopped).toBe(true);
    await tick(); // the logoff is dispatched, not awaited, by connection 10
    const unlockAt = seen.findIndex((s) => s.includes('_action=UNLOCK'));
    const logoffAt = seen.findIndex(isLogoff);
    expect(unlockAt).toBeGreaterThanOrEqual(0);
    expect(logoffAt).toBeGreaterThan(unlockAt);
  });

  it('with no critical section open, teardown logs off at once', async () => {
    const conn = createConnection({
      sapConfig: sapConfig(),
      systemType: 'onprem',
    });
    await conn.connect();
    await safeStop(conn);
    await tick();
    expect(seen.some(isLogoff)).toBe(true);
  });

  it('control: the base connector’s disconnect() alone refuses the chain’s next request', async () => {
    // Why the hub's connectors exist: without the wait, the UNLOCK is refused.
    const cfg = sapConfig();
    const conn = new AdtOnPremConnector(
      cfg,
      new BasicAuthProvider('U', 'P'),
      new OnPremHttpTransport(() => ({}), null, {
        client: cfg.client,
        baseUrl: url,
      }),
      null,
    );
    await conn.connect();
    conn.beginCriticalSection();
    void conn.disconnect();
    await expect(conn.makeAdtRequest(unlock)).rejects.toBeDefined();
    conn.endCriticalSection();
  });
});
