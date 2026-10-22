import cds from '@sap/cds';
import { resolveDestinationSapConfig } from '../../srv/connections/destinationResolver';

jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: jest.fn(async () => ({
    authenticationType: 'BasicAuthentication',
  })),
}));

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
async function setup(max = 1) {
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
  await factory.refresh({ headers }, 'D');
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
  const { factory, builder } = await setup();
  const req = {
    headers: { ...headers, cookie: 'private', 'x-other': 'private' },
  };
  await factory.refresh(req, 'D');
  req.headers.authorization = 'changed';
  await factory.open();
  expect(builder.mock.calls[0]).toEqual([
    { headers, userId: 'u', destination: 'D', exposition: [] },
  ]);
  await factory.refresh(
    { headers: { ...headers, authorization: 'latest' } },
    'E',
  );
  await factory.open();
  expect(builder.mock.calls[1]).toEqual([
    {
      headers: { ...headers, authorization: 'latest' },
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
  const { pool, builder } = await setup();
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
  const { pool, factory, builder } = await setup();
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
  const { pool } = await setup();
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
  const { factory, builder, pool } = await setup(2);
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
  const { builder, pool } = await setup(2);
  let fail!: (error: Error) => void;
  builder.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const first = expect(pool.acquire()).rejects.toThrow('SAP connection failed');
  fail(new Error('failed'));
  await first;
  const second = pool.acquire();
  expect(builder).toHaveBeenCalledTimes(2);
  await (await second).release(true);
  await pool.closeAll();
});
it('opens at most max connections for concurrent acquisitions', async () => {
  const { pool, builder } = await setup(2);
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
  const { factory, builder } = await setup();
  await factory.refresh(
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
  await factory.refresh({ headers, user: { is: () => false } }, 'D');
  expect(factory.exposition).toEqual([]);
  factory.forget();
  expect(factory.exposition).toEqual([]);
});

it('retires idle and leased connections when credentials change', async () => {
  const { pool, factory, builder } = await setup(2);
  const idle = await pool.acquire();
  const busy = await pool.acquire();
  await idle.release(true);
  await factory.refresh(
    { headers: { ...headers, authorization: 'Bearer renewed' } },
    'D',
  );
  await Promise.resolve();
  expect(
    (idle.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  expect(
    (busy.connection as unknown as { close: jest.Mock }).close,
  ).not.toHaveBeenCalled();
  await busy.release(true);
  expect(
    (busy.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  const next = await pool.acquire();
  expect(next.connection).not.toBe(idle.connection);
  expect(builder.mock.calls[2][0].headers.authorization).toBe('Bearer renewed');
  await next.release(true);
  await pool.closeAll();
});
it.each([401, 403, 500])(
  'sanitizes connection opening failures (%s)',
  async (status) => {
    const { pool, builder } = await setup();
    builder.mockRejectedValueOnce(
      Object.assign(
        new Error('password=sentinel Bearer sentinel Authorization: sentinel'),
        { status },
      ),
    );
    await expect(pool.acquire()).rejects.toThrow(
      status === 500
        ? 'SAP connection failed'
        : 'SAP connection failed: authentication rejected',
    );
    await pool.closeAll();
  },
);

it('keeps identical bindings and retires when credentials are removed', async () => {
  const { pool, factory } = await setup();
  const first = await pool.acquire();
  await first.release(true);
  await factory.refresh({ headers: { ...headers } }, 'D');
  const same = await pool.acquire();
  expect(same.connection).toBe(first.connection);
  expect(same.version).toBe(first.version);
  await same.release(true);
  await factory.refresh({ headers: {} }, 'D');
  expect(
    (same.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  await expect(pool.acquire()).rejects.toThrow(NoCredentialsError);
  await pool.closeAll();
});

it.each(['x-sap-login', 'x-sap-client'])(
  'rejects changes to fixed basic principal: %s',
  async (field) => {
    const { factory } = await setup();
    const version = factory.version;
    await expect(
      factory.refresh({ headers: { ...headers, [field]: 'OTHER' } }, 'D'),
    ).rejects.toMatchObject({
      code: 'DIALOGUE_PRINCIPAL_FIXED',
      statusCode: 409,
    });
    expect(factory.version).toBe(version);
  },
);
it('binds authenticated user while allowing secret rotation and credential removal', async () => {
  const token = (sub: string, nonce: number) =>
    `Bearer e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.sig`;
  const factory = new SessionConnectionFactory('u', 'key');
  cds.context = { user: new cds.User('alice') } as typeof cds.context;
  await factory.refresh({ headers: { authorization: token('alice', 1) } }, 'D');
  await factory.refresh({ headers: { authorization: token('alice', 2) } }, 'D');
  cds.context = { user: new cds.User('bob') } as typeof cds.context;
  await expect(
    factory.refresh({ headers: { authorization: token('bob', 3) } }, 'D'),
  ).rejects.toMatchObject({
    code: 'DIALOGUE_PRINCIPAL_FIXED',
    statusCode: 409,
  });
  await factory.refresh({ headers: {} }, 'D');
  await expect(factory.open()).rejects.toThrow(NoCredentialsError);
  await expect(
    factory.refresh({ headers: { authorization: token('bob', 4) } }, 'D'),
  ).rejects.toMatchObject({
    code: 'DIALOGUE_PRINCIPAL_FIXED',
    statusCode: 409,
  });
});

it('basic password rotation retains the principal and rejects switching after removal', async () => {
  const { factory, builder, pool } = await setup();
  const old = await pool.acquire();
  await old.release(true);
  const version = factory.version;
  await factory.refresh(
    { headers: { ...headers, 'x-sap-password': 'rotated' } },
    'D',
  );
  expect(factory.version).toBeGreaterThan(version);
  await factory.open();
  expect(builder.mock.calls[1][0].headers['x-sap-password']).toBe('rotated');
  expect(
    (old.connection as unknown as { close: jest.Mock }).close,
  ).toHaveBeenCalledTimes(1);
  await factory.refresh({ headers: {} }, 'D');
  await expect(
    factory.refresh({ headers: { ...headers, 'x-sap-login': 'OTHER' } }, 'D'),
  ).rejects.toMatchObject({
    code: 'DIALOGUE_PRINCIPAL_FIXED',
    statusCode: 409,
  });
  await factory.refresh({ headers }, 'D');
  expect(factory.hasCredentials()).toBe(true);
  await pool.closeAll();
});

it('uses the authenticated JWT user for PrincipalPropagation despite changed or removed SAP headers', async () => {
  jest.mocked(resolveDestinationSapConfig).mockResolvedValue({
    destinationName: 'PP',
    sapConfig: { url: 'https://sap', authType: 'basic' },
    authenticationType: 'PrincipalPropagation',
  });
  jest.mocked(resolveDestinationSapConfig).mockClear();
  cds.context = { user: new cds.User('alice') } as typeof cds.context;
  const factory = new SessionConnectionFactory('alice', 'key');
  await factory.refresh({ headers }, 'PP');
  await expect(
    factory.refresh(
      {
        headers: {
          ...headers,
          'x-sap-login': 'OTHER',
          'x-sap-password': 'other',
        },
      },
      'PP',
    ),
  ).resolves.toBeUndefined();
  await expect(
    factory.refresh(
      { headers: { authorization: 'Bearer renewed', 'x-sap-client': '100' } },
      'PP',
    ),
  ).resolves.toBeUndefined();
  expect(resolveDestinationSapConfig).toHaveBeenCalledTimes(1);
  cds.context = { user: new cds.User('bob') } as typeof cds.context;
  await expect(factory.refresh({ headers }, 'PP')).rejects.toMatchObject({
    code: 'DIALOGUE_PRINCIPAL_FIXED',
    statusCode: 409,
  });
});
