import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';

function fakeInner(): IMcpClient {
  return {
    listTools: jest.fn(),
    callTool: jest.fn(),
    healthCheck: jest.fn(),
  };
}

describe('RecordingMcpClient', () => {
  test('callTool delegates to inner and returns its ok result unchanged', async () => {
    const inner = fakeInner();
    const okResult = { ok: true as const, value: { content: 'hello' } };
    (inner.callTool as jest.Mock).mockResolvedValue(okResult);

    const client = new RecordingMcpClient(inner);
    const res = await client.callTool(
      'ReadTable',
      { table: 'T000' },
      { trace: { traceId: 't1' } },
    );

    expect(inner.callTool).toHaveBeenCalledWith(
      'ReadTable',
      { table: 'T000' },
      { trace: { traceId: 't1' } },
    );
    expect(res).toBe(okResult);
  });

  test('callTool delegates to inner and returns its error result unchanged', async () => {
    const inner = fakeInner();
    const errResult = { ok: false as const, error: new Error('boom') };
    (inner.callTool as jest.Mock).mockResolvedValue(errResult);

    const client = new RecordingMcpClient(inner);
    const res = await client.callTool(
      'ReadTable',
      {},
      { trace: { traceId: 't1' } },
    );

    expect(res).toBe(errResult);
  });

  test('a successful callTool is recorded under its traceId', async () => {
    const inner = fakeInner();
    const okResult = {
      ok: true as const,
      value: { content: 'hello', isError: false },
    };
    (inner.callTool as jest.Mock).mockResolvedValue(okResult);

    const client = new RecordingMcpClient(inner);
    await client.callTool(
      'ReadTable',
      { table: 'T000' },
      { trace: { traceId: 't1' } },
    );

    const records = client.getToolRecords('t1');
    expect(records).toHaveLength(1);
    expect(records[0].call.name).toBe('ReadTable');
    expect(records[0].call.arguments).toEqual({ table: 'T000' });
    expect(records[0].result).toEqual({ content: 'hello', isError: false });
  });

  test('an error result is recorded as a synthesized isError McpToolResult', async () => {
    const inner = fakeInner();
    const errResult = {
      ok: false as const,
      error: new Error('backend unreachable'),
    };
    (inner.callTool as jest.Mock).mockResolvedValue(errResult);

    const client = new RecordingMcpClient(inner);
    await client.callTool(
      'DeleteObject',
      { name: 'ZFOO' },
      { trace: { traceId: 't1' } },
    );

    const records = client.getToolRecords('t1');
    expect(records).toHaveLength(1);
    expect(records[0].call.name).toBe('DeleteObject');
    expect(records[0].result).toEqual({
      content: 'backend unreachable',
      isError: true,
    });
  });

  test('two traceIds stay isolated; getToolRecords() with no id is always empty', async () => {
    const inner = fakeInner();
    (inner.callTool as jest.Mock)
      .mockResolvedValueOnce({ ok: true, value: { content: 'a' } })
      .mockResolvedValueOnce({ ok: true, value: { content: 'b' } })
      .mockResolvedValueOnce({ ok: true, value: { content: 'c' } });

    const client = new RecordingMcpClient(inner);
    await client.callTool('ToolA', {}, { trace: { traceId: 't1' } });
    await client.callTool('ToolB', {}, { trace: { traceId: 't2' } });
    await client.callTool('ToolC', {}, { trace: { traceId: 't2' } });

    expect(client.getToolRecords('t1').map((r) => r.call.name)).toEqual([
      'ToolA',
    ]);
    expect(client.getToolRecords('t2').map((r) => r.call.name)).toEqual([
      'ToolB',
      'ToolC',
    ]);
    expect(client.getToolRecords()).toEqual([]);
  });

  test('dropRequest(t1) frees only that bucket; t2 is unaffected', async () => {
    const inner = fakeInner();
    (inner.callTool as jest.Mock)
      .mockResolvedValueOnce({ ok: true, value: { content: 'a' } })
      .mockResolvedValueOnce({ ok: true, value: { content: 'b' } });

    const client = new RecordingMcpClient(inner);
    await client.callTool('ToolA', {}, { trace: { traceId: 't1' } });
    await client.callTool('ToolB', {}, { trace: { traceId: 't2' } });

    client.dropRequest('t1');

    expect(client.getToolRecords('t1')).toEqual([]);
    expect(client.getToolRecords('t2').map((r) => r.call.name)).toEqual([
      'ToolB',
    ]);
  });

  test('a call with no traceId retains nothing', async () => {
    const inner = fakeInner();
    (inner.callTool as jest.Mock).mockResolvedValue({
      ok: true,
      value: { content: 'x' },
    });

    const client = new RecordingMcpClient(inner);
    await client.callTool('ToolX', {});

    expect(client.getToolRecords()).toEqual([]);
    expect(client.getToolRecords('anything')).toEqual([]);
  });

  test('reset clears all buckets', async () => {
    const inner = fakeInner();
    (inner.callTool as jest.Mock).mockResolvedValue({
      ok: true,
      value: { content: 'x' },
    });

    const client = new RecordingMcpClient(inner);
    await client.callTool('ToolX', {}, { trace: { traceId: 't1' } });
    client.reset();

    expect(client.getToolRecords('t1')).toEqual([]);
    expect(client.getToolRecords()).toEqual([]);
  });

  test('listTools delegates to inner', async () => {
    const inner = fakeInner();
    const listResult = { ok: true as const, value: [] };
    (inner.listTools as jest.Mock).mockResolvedValue(listResult);

    const client = new RecordingMcpClient(inner);
    const res = await client.listTools({ sessionId: 's1' });

    expect(inner.listTools).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(res).toBe(listResult);
  });

  test('healthCheck delegates to inner when present', async () => {
    const inner = fakeInner();
    const hcResult = { ok: true as const, value: true };
    (inner.healthCheck as jest.Mock).mockResolvedValue(hcResult);

    const client = new RecordingMcpClient(inner);
    const res = await client.healthCheck?.({ sessionId: 's1' });

    expect(inner.healthCheck).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(res).toBe(hcResult);
  });

  test('healthCheck is undefined when inner does not implement it', () => {
    const inner: IMcpClient = {
      listTools: jest.fn(),
      callTool: jest.fn(),
    };

    const client = new RecordingMcpClient(inner);
    expect(client.healthCheck).toBeUndefined();
  });
});
