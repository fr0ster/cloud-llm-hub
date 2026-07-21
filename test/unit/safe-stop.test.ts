/**
 * Unit tests for Task 11: safe-stop + per-request telemetry lifecycle.
 *
 * - `safeStop` (srv/lib/request-connection.ts): idempotent, never-throwing ADT
 *   session teardown — closeSession() then reset(), each independently
 *   swallowed on error.
 * - `RecordingRequestLogger` lifecycle: the contract the channel handlers rely
 *   on in their `finally` — `dropRequest(traceId)` frees the per-trace bucket,
 *   and concurrent traceIds never cross-contaminate.
 */

import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import { RecordingRequestLogger } from '../../srv/lib/recording-request-logger';
import { safeStop } from '../../srv/lib/request-connection';

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

describe('per-request telemetry lifecycle (RecordingRequestLogger)', () => {
  test('dropRequest(traceId) frees the per-trace bucket after a run', () => {
    const logger = new RecordingRequestLogger();
    const traceId = 't1';

    logger.startRequest(traceId);
    logger.logToolCall({
      toolName: 'ReadTable',
      success: true,
      durationMs: 1,
      cached: false,
      requestId: traceId,
    });
    expect(logger.executedToolNames(traceId)).toEqual(['ReadTable']);

    logger.endRequest(traceId);
    logger.dropRequest(traceId);

    expect(logger.executedToolNames(traceId)).toEqual([]);
  });

  test('two concurrent traceIds do not cross-contaminate, and dropping one leaves the other intact', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.startRequest('t2');
    logger.logToolCall({
      toolName: 'ReadTable',
      success: true,
      durationMs: 1,
      cached: false,
      requestId: 't1',
    });
    logger.logToolCall({
      toolName: 'GetObject',
      success: true,
      durationMs: 1,
      cached: false,
      requestId: 't2',
    });

    expect(logger.executedToolNames('t1')).toEqual(['ReadTable']);
    expect(logger.executedToolNames('t2')).toEqual(['GetObject']);

    logger.endRequest('t1');
    logger.dropRequest('t1');

    expect(logger.executedToolNames('t1')).toEqual([]);
    // t2's bucket must be untouched by t1's drop.
    expect(logger.executedToolNames('t2')).toEqual(['GetObject']);
  });
});
