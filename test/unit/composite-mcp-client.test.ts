import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { compositeMcpClient } from '../../srv/lib/composite-mcp-client';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { withToolResultCap } from '../../srv/lib/tool-result-cap';

function part(name: string, cacheable = true): IMcpClient {
  return {
    cacheable,
    listTools: async () => ({
      ok: true,
      value: [{ name, description: name, inputSchema: { type: 'object' } }],
    }),
    callTool: jest.fn(async () => ({
      ok: true as const,
      value: { content: name.repeat(100) },
    })),
  };
}

test('concurrent discovery returns full catalogues with the first owner winning', async () => {
  const docs = part('shared');
  const sap = part('GetTable');
  const listSap = sap.listTools;
  sap.listTools = async () => {
    const result = await listSap();
    if (!result.ok) return result;
    return {
      ok: true,
      value: [
        ...result.value,
        { name: 'shared', description: 'duplicate', inputSchema: {} },
      ],
    };
  };
  const client = compositeMcpClient([docs, sap]);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => client.listTools()),
  );
  for (const result of results) {
    expect(result).toEqual({
      ok: true,
      value: [
        {
          name: 'shared',
          description: 'shared',
          inputSchema: { type: 'object' },
        },
        {
          name: 'GetTable',
          description: 'GetTable',
          inputSchema: { type: 'object' },
        },
      ],
    });
  }
  await client.callTool('shared', {});
  expect(docs.callTool).toHaveBeenCalledTimes(1);
  expect(sap.callTool).not.toHaveBeenCalled();
});

test('routes a secondary tool using published owners while discovery is in flight', async () => {
  const docs = part('docs_search');
  const sap = part('GetTable');
  const catalogue = await docs.listTools();
  let release = () => {};
  const pending = new Promise<Awaited<ReturnType<IMcpClient['listTools']>>>(
    (resolve) => {
      release = () => resolve(catalogue);
    },
  );
  docs.listTools = jest
    .fn<
      ReturnType<IMcpClient['listTools']>,
      Parameters<IMcpClient['listTools']>
    >()
    .mockResolvedValueOnce(catalogue)
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ ok: true, value: [] });
  const client = compositeMcpClient([docs, sap]);
  await client.listTools();
  const refresh = client.listTools();
  try {
    await client.callTool('docs_search', {});
    expect(docs.callTool).toHaveBeenCalledTimes(1);
    expect(sap.callTool).not.toHaveBeenCalled();
  } finally {
    release();
    await refresh;
  }
});

test.each(['planner', 'controller'])(
  '%s caps docs and preserves cache policy',
  async (role) => {
    const docs = part('docs_search', false);
    const sap = part('GetTable');
    const composite = compositeMcpClient([docs, sap]);
    const client =
      role === 'planner'
        ? new RecordingMcpClient(composite, undefined, 10, false)
        : withToolResultCap(composite, 10);
    expect(client.cacheable).toBe(false);
    await client.listTools();
    const result = await client.callTool(
      'docs_search',
      {},
      { trace: { traceId: 'planner' } },
    );
    expect(result.ok && result.value.content).toEqual(
      expect.stringContaining('result truncated'),
    );
    expect(docs.callTool).toHaveBeenCalledTimes(1);
    expect(sap.callTool).not.toHaveBeenCalled();
    if (client instanceof RecordingMcpClient)
      expect(client.getToolRecords('planner')).toEqual([]);
  },
);

test('composite lists and routes parts, retaining health failures', async () => {
  const docs = part('docs_search');
  const sap = part('GetTable');
  sap.healthCheck = jest.fn(async () => ({ ok: true as const, value: false }));
  const client = compositeMcpClient([docs, sap]);
  expect(await client.listTools()).toEqual({
    ok: true,
    value: expect.arrayContaining([
      expect.objectContaining({ name: 'docs_search' }),
      expect.objectContaining({ name: 'GetTable' }),
    ]),
  });
  await client.callTool('GetTable', {});
  expect(sap.callTool).toHaveBeenCalledTimes(1);
  expect(docs.callTool).not.toHaveBeenCalled();
  expect(await client.healthCheck?.()).toEqual({
    ok: true as const,
    value: false,
  });
});
