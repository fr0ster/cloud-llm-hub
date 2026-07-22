/**
 * Unit tests for safe-stop + per-request tool-record telemetry lifecycle.
 *
 * - `safeStop` (srv/lib/request-connection.ts): idempotent, never-throwing ADT
 *   session teardown — closeSession() then reset(), each independently
 *   swallowed on error.
 * - `RecordingMcpClient` lifecycle: the contract the channel handlers rely
 *   on in their `finally` — `dropRequest(traceId)` frees the per-trace bucket,
 *   and concurrent traceIds never cross-contaminate.
 */

import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { safeStop } from '../../srv/lib/request-connection';

function fakeInner(): IMcpClient {
  return {
    listTools: jest.fn(),
    callTool: jest.fn(async (name: string) => ({
      ok: true as const,
      value: { content: `${name}-result` },
    })),
  };
}

type FakeConnection = {
  closeSession: jest.Mock;
  reset: jest.Mock;
};

function makeConnection(): FakeConnection {
  return {
    closeSession: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn(),
  };
}

describe('safeStop', () => {
  test('calls closeSession then reset, in order', async () => {
    const conn = makeConnection();
    const order: string[] = [];
    conn.closeSession.mockImplementation(async () => {
      order.push('closeSession');
    });
    conn.reset.mockImplementation(() => {
      order.push('reset');
    });

    await safeStop(conn as unknown as IAbapConnection);

    expect(order).toEqual(['closeSession', 'reset']);
    expect(conn.closeSession).toHaveBeenCalledTimes(1);
    expect(conn.reset).toHaveBeenCalledTimes(1);
  });

  test('a throwing closeSession is swallowed and reset still runs', async () => {
    const conn = makeConnection();
    conn.closeSession.mockRejectedValue(new Error('session already gone'));

    await expect(
      safeStop(conn as unknown as IAbapConnection),
    ).resolves.toBeUndefined();

    expect(conn.reset).toHaveBeenCalledTimes(1);
  });

  test('a throwing reset is swallowed', async () => {
    const conn = makeConnection();
    conn.reset.mockImplementation(() => {
      throw new Error('reset failed');
    });

    await expect(
      safeStop(conn as unknown as IAbapConnection),
    ).resolves.toBeUndefined();

    expect(conn.closeSession).toHaveBeenCalledTimes(1);
  });

  test('calling twice is safe (idempotent)', async () => {
    const conn = makeConnection();

    await safeStop(conn as unknown as IAbapConnection);
    await safeStop(conn as unknown as IAbapConnection);

    expect(conn.closeSession).toHaveBeenCalledTimes(2);
    expect(conn.reset).toHaveBeenCalledTimes(2);
  });

  test('safeStop(undefined) is a no-op that does not throw', async () => {
    await expect(safeStop(undefined)).resolves.toBeUndefined();
  });

  test('connection missing closeSession/reset methods is a no-op', async () => {
    await expect(
      safeStop({} as unknown as IAbapConnection),
    ).resolves.toBeUndefined();
  });
});

describe('per-request telemetry lifecycle (RecordingMcpClient)', () => {
  test('dropRequest(traceId) frees the per-trace bucket after a run', async () => {
    const client = new RecordingMcpClient(fakeInner());
    const traceId = 't1';

    await client.callTool('ReadTable', {}, { trace: { traceId } });
    expect(client.getToolRecords(traceId).map((r) => r.call.name)).toEqual([
      'ReadTable',
    ]);

    client.dropRequest(traceId);

    expect(client.getToolRecords(traceId)).toEqual([]);
  });

  test('two concurrent traceIds do not cross-contaminate, and dropping one leaves the other intact', async () => {
    const client = new RecordingMcpClient(fakeInner());

    await client.callTool('ReadTable', {}, { trace: { traceId: 't1' } });
    await client.callTool('GetObject', {}, { trace: { traceId: 't2' } });

    expect(client.getToolRecords('t1').map((r) => r.call.name)).toEqual([
      'ReadTable',
    ]);
    expect(client.getToolRecords('t2').map((r) => r.call.name)).toEqual([
      'GetObject',
    ]);

    client.dropRequest('t1');

    expect(client.getToolRecords('t1')).toEqual([]);
    // t2's bucket must be untouched by t1's drop.
    expect(client.getToolRecords('t2').map((r) => r.call.name)).toEqual([
      'GetObject',
    ]);
  });
});
