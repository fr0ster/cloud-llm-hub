/**
 * One client, one system, one session.
 *
 * The hub used to build a connection per HTTP request and close it again at the
 * end — so a client doing ten reads paid for ten ABAP logons, i.e. ten SM05
 * sessions, each used once. The pool keeps ONE connection per
 * (caller, destination, mandant, credential) and hands it out; the session it
 * opened lives as long as the caller keeps working and is given back when the
 * caller goes idle.
 *
 * What the pool must guarantee:
 * - the same caller against the same system gets the SAME connection, connected once;
 * - a different user, credential, mandant or destination NEVER shares one;
 * - concurrent work on one key is serialized (an ADT session is not re-entrant);
 * - a discarded or idle connection is released properly (closeSession + reset);
 * - a failed connect() is not cached, and gives its session back.
 */

jest.mock('../../srv/lib/logger', () => ({
  logger: { info() {}, warn() {}, debug() {}, error() {} },
}));

import {
  acquireConnection,
  closeAllPooledConnections,
  pooledConnectionCount,
  sweepIdleConnections,
} from '../../srv/lib/connection-pool';

interface FakeConn {
  connect: jest.Mock;
  closeSession: jest.Mock;
  endStatefulChain: jest.Mock;
  reset: jest.Mock;
  id: number;
}

let built: FakeConn[] = [];
function makeConn(): FakeConn {
  const conn: FakeConn = {
    connect: jest.fn(async () => undefined),
    closeSession: jest.fn(async () => undefined),
    endStatefulChain: jest.fn(async () => undefined),
    reset: jest.fn(),
    id: built.length,
  };
  built.push(conn);
  return conn;
}

const KEY = {
  userId: 'alice',
  destination: 'E19',
  client: '100',
  authFingerprint: 'fp-alice',
};

// biome-ignore lint/suspicious/noExplicitAny: the pool is typed against AbapConnection; the fake only needs the four methods it calls
const create = () => makeConn() as any;

beforeEach(async () => {
  await closeAllPooledConnections();
  built = [];
});

afterAll(async () => {
  await closeAllPooledConnections();
});

describe('connection pool — reuse', () => {
  test('the same caller and system reuse one connection, connected once', async () => {
    const a = await acquireConnection(KEY, create);
    await a.release();
    const b = await acquireConnection(KEY, create);
    await b.release();

    expect(built).toHaveLength(1);
    expect(built[0].connect).toHaveBeenCalledTimes(1);
    expect(a.connection).toBe(b.connection);
    // Reuse means the session is NOT handed back between requests.
    expect(built[0].closeSession).not.toHaveBeenCalled();
  });

  test('a stateful chain is ended on release, the platform session is kept', async () => {
    const a = await acquireConnection(KEY, create);
    await a.release();
    // The edit-lock must not outlive the request; the logon may.
    expect(built[0].endStatefulChain).toHaveBeenCalledTimes(1);
    expect(built[0].closeSession).not.toHaveBeenCalled();
  });

  test.each([
    ['a different user', { ...KEY, userId: 'bob' }],
    ['a different destination', { ...KEY, destination: 'DS4' }],
    ['a different mandant', { ...KEY, client: '600' }],
    ['a different credential', { ...KEY, authFingerprint: 'fp-other' }],
  ])('%s never shares a connection', async (_label, other) => {
    const a = await acquireConnection(KEY, create);
    await a.release();
    const b = await acquireConnection(other, create);
    await b.release();
    expect(built).toHaveLength(2);
    expect(a.connection).not.toBe(b.connection);
  });

  test('an explicit client session id separates two clients of one user', async () => {
    const a = await acquireConnection({ ...KEY, sessionId: 'cline-1' }, create);
    await a.release();
    const b = await acquireConnection({ ...KEY, sessionId: 'cline-2' }, create);
    await b.release();
    expect(built).toHaveLength(2);
  });
});

describe('connection pool — serialization', () => {
  test('concurrent acquires on one key queue instead of opening a second session', async () => {
    const first = await acquireConnection(KEY, create);
    let secondArrived = false;
    const second = acquireConnection(KEY, create).then((h) => {
      secondArrived = true;
      return h;
    });

    await Promise.resolve();
    expect(secondArrived).toBe(false); // still held by the first caller

    await first.release();
    const h = await second;
    expect(secondArrived).toBe(true);
    expect(h.connection).toBe(first.connection);
    expect(built).toHaveLength(1);
    await h.release();
  });
});

describe('connection pool — release of the session', () => {
  test('discard closes the session and the next caller gets a fresh one', async () => {
    const a = await acquireConnection(KEY, create);
    await a.release({ discard: true });
    expect(built[0].closeSession).toHaveBeenCalledTimes(1);
    expect(built[0].reset).toHaveBeenCalledTimes(1);
    expect(pooledConnectionCount()).toBe(0);

    const b = await acquireConnection(KEY, create);
    await b.release();
    expect(built).toHaveLength(2);
  });

  test('an idle connection is given back once it is older than the TTL', async () => {
    const a = await acquireConnection(KEY, create);
    await a.release();
    const idleSince = Date.now();
    expect(pooledConnectionCount()).toBe(1);

    await sweepIdleConnections(idleSince + 60_000, 600_000); // 1 min idle, 10 min TTL
    expect(built[0].closeSession).not.toHaveBeenCalled();
    expect(pooledConnectionCount()).toBe(1);

    await sweepIdleConnections(idleSince + 900_000, 600_000); // 15 min idle
    expect(built[0].closeSession).toHaveBeenCalledTimes(1);
    expect(built[0].reset).toHaveBeenCalledTimes(1);
    expect(pooledConnectionCount()).toBe(0);
  });

  test('a connection in use is never swept from under its caller', async () => {
    const a = await acquireConnection(KEY, create);
    await sweepIdleConnections(Date.now() + 900_000, 600_000);
    expect(built[0].closeSession).not.toHaveBeenCalled();
    expect(pooledConnectionCount()).toBe(1);
    await a.release();
  });

  test('closeAll hands every session back', async () => {
    const a = await acquireConnection(KEY, create);
    await a.release();
    const b = await acquireConnection({ ...KEY, userId: 'bob' }, create);
    await b.release();

    await closeAllPooledConnections();
    expect(built[0].closeSession).toHaveBeenCalledTimes(1);
    expect(built[1].closeSession).toHaveBeenCalledTimes(1);
    expect(pooledConnectionCount()).toBe(0);
  });
});

describe('connection pool — failures', () => {
  test('a failed connect is not pooled and gives its session back', async () => {
    const failing = () => {
      const c = makeConn();
      c.connect.mockRejectedValueOnce(new Error('401 logon failed'));
      // biome-ignore lint/suspicious/noExplicitAny: see `create`
      return c as any;
    };
    await expect(acquireConnection(KEY, failing)).rejects.toThrow(/401/);
    expect(built[0].closeSession).toHaveBeenCalledTimes(1);
    expect(pooledConnectionCount()).toBe(0);

    // The failure must not wedge the key either.
    const ok = await acquireConnection(KEY, create);
    await ok.release();
    expect(pooledConnectionCount()).toBe(1);
  });

  test('a release that throws still frees the key', async () => {
    const a = await acquireConnection(KEY, create);
    built[0].endStatefulChain.mockRejectedValueOnce(new Error('network gone'));
    await a.release();
    const b = await acquireConnection(KEY, create);
    expect(b.connection).toBe(a.connection);
    await b.release();
  });
});
