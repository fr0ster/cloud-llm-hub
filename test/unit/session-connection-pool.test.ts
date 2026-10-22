import { inspect } from 'node:util';
import {
  NoCredentialsError,
  SessionConnectionFactory,
  SessionConnectionPool,
} from '../../srv/lib/session-connection-pool';

const headers = {
  authorization: 'Bearer secret',
  'x-sap-login': 'USER',
  'x-sap-password': 'secret',
  'x-sap-client': '100',
  'x-sap-destination': 'D',
  'x-sap-system-type': 'onpremise',
  'x-sap-responsible': 'OWNER',
  'x-sap-master-system': 'DEV',
};
function setup(max = 1) {
  const builder = jest.fn(
    async (
      _snapshot: import('../../srv/lib/session-connection-pool').ConnectionSnapshot,
    ) => ({
      connection: {
        close: jest.fn(),
        reset: jest.fn(),
      } as unknown as import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection,
      dumpScope: undefined,
      system: {},
    }),
  );
  const factory = new SessionConnectionFactory('u', 'key', { builder });
  factory.refresh({ headers }, 'D');
  return { builder, factory, pool: new SessionConnectionPool(factory, max) };
}
it('requires credentials after restart and forget', async () => {
  const factory = new SessionConnectionFactory('u', 'key');
  await expect(factory.open()).rejects.toThrow(new NoCredentialsError());
  expect(new NoCredentialsError().message).toBe(
    "no SAP credentials yet; they arrive with the user's next message",
  );
});
it('copies only the allow-list, refreshes latest headers and redacts inspection', async () => {
  const { factory, builder } = setup();
  const req = {
    headers: { ...headers, cookie: 'private', 'x-other': 'private' },
  };
  factory.refresh(req, 'D');
  req.headers.authorization = 'changed';
  await factory.open();
  expect(builder.mock.calls[0]).toEqual([
    { headers, userId: 'u', destination: 'D', exposition: [] },
  ]);
  factory.refresh({ headers: { authorization: 'latest' } }, 'E');
  await factory.open();
  expect(builder.mock.calls[1]).toEqual([
    {
      headers: { authorization: 'latest' },
      userId: 'u',
      destination: 'E',
      exposition: [],
    },
  ]);
  for (const rendered of [
    JSON.stringify(factory),
    inspect(factory),
    inspect(factory, { showHidden: true }),
    JSON.stringify({ ...factory }),
  ])
    expect(rendered).not.toMatch(/secret|latest|authorization|password/);
});
it('caps connections, serves FIFO and reuses healthy leases', async () => {
  const { pool, builder } = setup();
  const first = await pool.acquire();
  const order: number[] = [];
  const second = pool.acquire().then((x) => {
    order.push(2);
    return x;
  });
  const third = pool.acquire().then((x) => {
    order.push(3);
    return x;
  });
  expect(builder).toHaveBeenCalledTimes(1);
  await first.release(true);
  const b = await second;
  expect(b.connection).toBe(first.connection);
  expect(order).toEqual([2]);
  await b.release(true);
  const c = await third;
  expect(order).toEqual([2, 3]);
  await c.release(true);
  await pool.closeAll();
});
it('closes unhealthy connections and stops all leases, rejects waiters, forgets', async () => {
  const { pool, factory, builder } = setup();
  const a = await pool.acquire();
  await a.release(false);
  expect(
    (a.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  const b = await pool.acquire();
  expect(builder).toHaveBeenCalledTimes(2);
  const waiting = expect(pool.acquire()).rejects.toThrow('closed');
  await pool.closeAll();
  await waiting;
  expect(
    (b.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  expect(factory.hasCredentials()).toBe(false);
  await b.release(true);
  await expect(pool.acquire()).rejects.toThrow('closed');
});
it('removes aborted waiters without blocking the queue', async () => {
  const { pool } = setup();
  const a = await pool.acquire();
  const controller = new AbortController();
  const waiting = expect(pool.acquire(controller.signal)).rejects.toThrow();
  controller.abort();
  await waiting;
  await a.release(true);
  const b = await pool.acquire();
  await b.release(true);
  await pool.closeAll();
});
it('closes a connection that finishes opening after closeAll', async () => {
  const { factory, builder, pool } = setup(2);
  let finish!: (value: Awaited<ReturnType<typeof builder>>) => void;
  builder.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const waiting = expect(pool.acquire()).rejects.toThrow('closed');
  expect(builder).toHaveBeenCalledTimes(1);
  const closing = pool.closeAll();
  const connection = { close: jest.fn(), reset: jest.fn() };
  finish({
    connection:
      connection as unknown as import('@mcp-abap-adt/interfaces-adt-connection').IAbapConnection,
    dumpScope: undefined,
    system: {},
  });
  await closing;
  await waiting;
  expect(connection.close).toHaveBeenCalledTimes(1);
  expect(factory.hasCredentials()).toBe(false);
});
it('bounds simultaneous opens and replaces a failed open for the next waiter', async () => {
  const { builder, pool } = setup(2);
  let fail!: (error: Error) => void;
  builder.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const first = expect(pool.acquire()).rejects.toThrow('failed');
  fail(new Error('failed'));
  await first;
  const second = pool.acquire();
  expect(builder).toHaveBeenCalledTimes(2);
  await (await second).release(true);
  await pool.closeAll();
});
it('opens at most max connections for concurrent acquisitions', async () => {
  const { pool, builder } = setup(2);
  const first = await pool.acquire();
  const second = await pool.acquire();
  let acquired = false;
  const third = pool.acquire().then((lease) => {
    acquired = true;
    return lease;
  });
  await Promise.resolve();
  expect(builder).toHaveBeenCalledTimes(2);
  expect(acquired).toBe(false);
  await first.release(true);
  const next = await third;
  expect(next.connection).toBe(first.connection);
  await next.release(true);
  await second.release(true);
  await pool.closeAll();
});

it('captures principal exposition as metadata, ignores forged headers, copies it and refreshes roles', async () => {
  const { factory, builder } = setup();
  factory.refresh(
    {
      headers: { ...headers, 'x-exposition': 'high' },
      user: { is: (role) => role === 'MCP_Reader' },
    },
    'D',
  );
  await factory.open();
  expect(builder.mock.calls[0][0].exposition).toEqual([
    'readonly',
    'search',
    'system',
  ]);
  expect(builder.mock.calls[0][0].headers).toEqual(headers);
  const copy = factory.exposition;
  copy.push('high');
  expect(factory.exposition).not.toContain('high');
  factory.refresh({ headers, user: { is: () => false } }, 'D');
  expect(factory.exposition).toEqual([]);
  factory.forget();
  expect(factory.exposition).toEqual([]);
});
