/**
 * The ABAP connection a long session holds across its requests: bound to the
 * credential it was opened with, kept between requests, replaced on a new JWT
 * of the same user or a destination switch, never stopped by a request.
 */

import type { Request, Response } from 'express';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
      context: { user: { id: 'alice' } },
    },
  }),
  { virtual: true },
);

// The real module's credential reading is under test; its connection
// machinery (and the .env loading behind it) is not.
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => {
    throw new Error('not in this test');
  },
  isDirectConnector: () => false,
}));
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => {
    throw new Error('not in this test');
  },
}));

let connections = 0;
const mockEstablish = jest.fn(
  async (_req: unknown, _res: unknown, destination: string | undefined) => ({
    handled: false,
    connection: { id: `conn-${++connections}`, destination },
    dumpScope: undefined,
  }),
);
const mockSafeStop = jest.fn(async (_c?: unknown) => {});
jest.mock('../../srv/lib/request-connection', () => ({
  ...jest.requireActual('../../srv/lib/request-connection'),
  establishRequestConnection: (req: unknown, res: unknown, d?: string) =>
    mockEstablish(req, res, d),
  safeStop: (c?: unknown) => mockSafeStop(c),
}));

import type { LongSession } from '../../srv/lib/long-session';
import {
  acquireSessionConnection,
  dropSessionConnection,
  releaseRequestConnection,
} from '../../srv/lib/session-connection';

function session(): LongSession {
  return {
    userId: 'alice',
    key: 'ls-1',
    createdAt: 0,
    lastActivity: 0,
    revived: false,
  };
}

const basic = (login = 'ALICE') =>
  ({
    headers: { 'x-sap-login': login, 'x-sap-password': 'pw' },
  }) as unknown as Request;
const jwt = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

function makeRes() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      r.headers[name] = value;
    },
    writeHead(code: number) {
      r.statusCode = code;
      return r;
    },
    end(payload?: string) {
      r.body = payload ? JSON.parse(payload) : undefined;
      return r;
    },
  };
  return r;
}
const res = () => makeRes() as unknown as Response;

beforeEach(() => {
  connections = 0;
  mockEstablish.mockClear();
  mockSafeStop.mockClear();
});

describe('acquireSessionConnection', () => {
  it('first acquire establishes and binds', async () => {
    const s = session();
    const r = await acquireSessionConnection(s, basic(), res(), 'DEST');
    expect(r.handled).toBe(false);
    if (r.handled) return;
    expect(r.connection).toEqual({ id: 'conn-1', destination: 'DEST' });
    expect(r.notice).toBeUndefined();
    expect(s.connection).toBe(r.connection);
    expect(s.destination).toBe('DEST');
    expect(s.binding).toEqual({ kind: 'basic', sapLogin: 'ALICE' });
  });

  it('second acquire with the same login reuses the connection (establish called once)', async () => {
    const s = session();
    const first = await acquireSessionConnection(s, basic(), res(), 'DEST');
    const second = await acquireSessionConnection(s, basic(), res(), 'DEST');
    expect(mockEstablish).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(mockSafeStop).not.toHaveBeenCalled();
  });

  it('another SAP login → 403 SESSION_CREDENTIAL_MISMATCH, connection kept', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const held = s.connection;
    const out = makeRes();
    const r = await acquireSessionConnection(
      s,
      basic('BOB'),
      out as unknown as Response,
      'DEST',
    );
    expect(r).toEqual({ handled: true });
    expect(out.statusCode).toBe(403);
    expect(out.body).toEqual({
      error: {
        type: 'SESSION_CREDENTIAL_MISMATCH',
        message: expect.any(String),
        destination: 'DEST',
      },
    });
    expect(s.connection).toBe(held);
    expect(mockSafeStop).not.toHaveBeenCalled();
    expect(mockEstablish).toHaveBeenCalledTimes(1);
  });

  it('another SAP client → 403 SESSION_CREDENTIAL_MISMATCH', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const req = basic();
    req.headers['x-sap-client'] = '200';
    const out = makeRes();
    await acquireSessionConnection(s, req, out as unknown as Response, 'DEST');
    expect(out.statusCode).toBe(403);
  });

  it('no credential → 401 SAP_CREDENTIALS_REQUIRED', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const held = s.connection;
    const out = makeRes();
    const r = await acquireSessionConnection(
      s,
      { headers: {} } as unknown as Request,
      out as unknown as Response,
      'DEST',
    );
    expect(r).toEqual({ handled: true });
    // The shape `establishRequestConnection` writes for missing credentials.
    expect(out.statusCode).toBe(401);
    expect(out.body).toEqual({
      error: {
        type: 'SAP_CREDENTIALS_REQUIRED',
        message: expect.any(String),
        destination: 'DEST',
      },
    });
    expect(s.connection).toBe(held);
  });

  it('a JWT alone where the session was opened with SAP basic → 401', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const out = makeRes();
    await acquireSessionConnection(
      s,
      jwt('t1'),
      out as unknown as Response,
      'DEST',
    );
    expect(out.statusCode).toBe(401);
  });

  it('same JWT user, new token → reconnect with notice abap_session_renewed, old one safeStopped', async () => {
    const s = session();
    await acquireSessionConnection(s, jwt('t1'), res(), 'DEST');
    const old = s.connection;
    expect(s.binding).toMatchObject({ kind: 'jwt', jwtUser: 'alice' });

    const same = await acquireSessionConnection(s, jwt('t1'), res(), 'DEST');
    expect(same).toMatchObject({ handled: false, connection: old });

    const out = makeRes();
    const r = await acquireSessionConnection(
      s,
      jwt('t2'),
      out as unknown as Response,
      'DEST',
    );
    expect(r).toMatchObject({
      handled: false,
      notice: 'abap_session_renewed',
    });
    expect(out.headers['x-clh-session-notice']).toBe('abap_session_renewed');
    expect(mockSafeStop).toHaveBeenCalledTimes(1);
    expect(mockSafeStop).toHaveBeenCalledWith(old);
    expect(s.connection).not.toBe(old);
    expect(s.binding).toMatchObject({ kind: 'jwt', jwt: 't2' });
  });

  it('destination change drops the held connection and establishes a new one', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const old = s.connection;
    const r = await acquireSessionConnection(s, basic(), res(), 'OTHER');
    expect(mockSafeStop).toHaveBeenCalledWith(old);
    expect(mockEstablish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'OTHER',
    );
    expect(r).toMatchObject({
      handled: false,
      connection: { id: 'conn-2', destination: 'OTHER' },
    });
    expect(r.handled === false && r.notice).toBeFalsy();
    expect(s.destination).toBe('OTHER');
  });

  it('a failed establish leaves the session without a connection', async () => {
    const s = session();
    mockEstablish.mockImplementationOnce(async () => ({
      handled: true,
      connection: undefined as never,
      dumpScope: undefined,
    }));
    const r = await acquireSessionConnection(s, basic(), res(), 'DEST');
    expect(r).toEqual({ handled: true });
    expect(s.connection).toBeUndefined();
    expect(s.binding).toBeUndefined();
  });
});

describe('releaseRequestConnection', () => {
  it('releaseRequestConnection does not stop a held connection', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    await releaseRequestConnection(s.connection, s);
    expect(mockSafeStop).not.toHaveBeenCalled();
    expect(s.connection).toBeDefined();
  });

  it('stops an unheld one', async () => {
    const conn = { id: 'per-request' } as never;
    await releaseRequestConnection(conn);
    expect(mockSafeStop).toHaveBeenCalledWith(conn);

    // Held by another session's slot is not this session's: stopped too.
    const s = session();
    await releaseRequestConnection(conn, s);
    expect(mockSafeStop).toHaveBeenCalledTimes(2);
  });
});

describe('dropSessionConnection', () => {
  it('stops the held connection and clears connection and binding', async () => {
    const s = session();
    await acquireSessionConnection(s, basic(), res(), 'DEST');
    const held = s.connection;
    await dropSessionConnection(s);
    expect(mockSafeStop).toHaveBeenCalledWith(held);
    expect(s.connection).toBeUndefined();
    expect(s.binding).toBeUndefined();
    expect(s.dumpScope).toBeUndefined();
  });
});
