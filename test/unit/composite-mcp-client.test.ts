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
