import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  parseMaxToolCalls,
  parseToolResultMaxChars,
} from '../../srv/agent-config';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { journalOutcome } from '../../srv/lib/tool-journal';
import {
  capToolResult,
  withToolResultCap,
} from '../../srv/lib/tool-result-cap';

const notice = 'returned 6 characters, exceeding the limit of 5.';

test.each([
  { success: false, status: 'inactive', error: 'Create rejected' },
  { success: true, status: 'active', error: undefined },
])(
  'records the same size-limit error for every oversized envelope: %j',
  async (facts) => {
    const content = JSON.stringify({ padding: 'x'.repeat(1000), ...facts });
    const worker = new RecordingMcpClient(
      {
        listTools: async () => ({ ok: true, value: [] }),
        callTool: async () => ({
          ok: true,
          value: { content, isError: false },
        }),
      },
      undefined,
      50,
    );
    const result = await worker.callTool(
      'CreateClass',
      {},
      { trace: { traceId: 'create' } },
    );
    const records = worker.getToolRecords('create');
    expect(result.ok && result.value.content).toBe(records[0].result.content);
    expect(records[0].result.content).toBe(
      capToolResult({ content }, 50, 'CreateClass').result.content,
    );
    expect(() => JSON.parse(records[0].result.content as string)).toThrow();
    expect(records[0].rejection).toEqual({
      rejected: true,
      originalLength: content.length,
      maxChars: 50,
    });
    expect(journalOutcome(worker.getToolJournal('create')[0])).toBe(
      facts.success ? 'succeeded' : 'failed',
    );
    expect(records[0].result.isError).toBe(true);
    expect(records[0].result.content).not.toContain('x'.repeat(10));
  },
);

test.each([false, true])(
  'oversized result becomes an error without a partial prefix (isError=%s)',
  (isError) => {
    const capped = capToolResult({ content: 'abcdef', isError }, 5, 'GetTable');
    expect(capped.result).toEqual({
      isError: true,
      content: `Tool GetTable ${notice} No result data is included. Narrow the request (smaller limit/max_results, a from/to range, filters, or one id).`,
    });
    expect(capped.result.content).not.toContain('abcde');
    expect(capped.rejection).toEqual({
      rejected: true,
      originalLength: 6,
      maxChars: 5,
    });
  },
);

test.each([0, 5, 6])(
  'under or at cap, and zero disabled, preserve result identity (%i)',
  (cap) => {
    const result = { content: 'abcde' };
    expect(capToolResult(result, cap).result).toBe(result);
  },
);
test.each([{ data: 'abcdef' }, [{ type: 'text', text: 'abcdef' }]])(
  'caps the exact serialized content seen by the installed model loop',
  (content) => {
    const text = JSON.stringify(content);
    const capped = capToolResult({ content }, 5, 'Read');
    expect(capped.result.isError).toBe(true);
    expect(capped.result.content).toContain(
      `returned ${text.length} characters, exceeding the limit of 5`,
    );
    expect(capped.result.content).not.toContain('abcde');
    expect(capped.rejection).toEqual({
      rejected: true,
      originalLength: text.length,
      maxChars: 5,
    });
  },
);
test('chat and recording worker return the same size-limit error and metadata', async () => {
  const inner: IMcpClient = {
    listTools: async () => ({
      ok: true,
      value: [{ name: 'GetTable', description: '', inputSchema: {} }],
    }),
    callTool: async () => ({
      ok: true,
      value: { content: 'abcdef', isError: false },
    }),
  };
  const chat = withToolResultCap(inner, 5);
  const worker = new RecordingMcpClient(inner, undefined, 5);
  for (const client of [chat, worker]) {
    await client.listTools();
    const result = await client.callTool(
      'GetTable',
      {},
      { trace: { traceId: 't' } },
    );
    expect(result.ok && result.value.content).toContain(notice);
  }
  expect(worker.getToolRecords('t')[0]).toMatchObject({
    result: { content: expect.stringContaining(notice), isError: true },
    rejection: { rejected: true, originalLength: 6, maxChars: 5 },
  });
});
test('configuration defaults, zero and strict nonnegative integer validation', () => {
  expect(parseToolResultMaxChars({})).toBe(0);
  expect(
    parseToolResultMaxChars({ LLM_AGENT_TOOL_RESULT_MAX_CHARS: '0' }),
  ).toBe(0);
  expect(
    parseToolResultMaxChars({ LLM_AGENT_TOOL_RESULT_MAX_CHARS: ' 123 ' }),
  ).toBe(123);
  for (const raw of ['-1', '1.5', 'Infinity', 'oops', '9007199254740992'])
    expect(() =>
      parseToolResultMaxChars({ LLM_AGENT_TOOL_RESULT_MAX_CHARS: raw }),
    ).toThrow();
});

test('rejection warning includes only known name and lengths, once per result', async () => {
  const log = cds.log('tool-result-cap');
  const spy = jest.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    const client = withToolResultCap(
      {
        listTools: async () => ({
          ok: true,
          value: [{ name: 'Known', description: '', inputSchema: {} }],
        }),
        callTool: async () => ({ ok: true, value: { content: 'secret' } }),
      },
      5,
    );
    await client.listTools();
    await client.callTool('Known', {});
    await client.callTool('untrusted user text', {});
    expect(spy.mock.calls).toEqual([
      [
        'Tool result exceeds size limit',
        { tool: 'Known', originalLength: 6, maxChars: 5 },
      ],
      ['Tool result exceeds size limit', { originalLength: 6, maxChars: 5 }],
    ]);
  } finally {
    spy.mockRestore();
  }
});

test('tool-call budget is optional and must be a positive integer', () => {
  for (const raw of [undefined, '', '   '])
    expect(
      parseMaxToolCalls({ LLM_AGENT_MAX_TOOL_CALLS: raw }),
    ).toBeUndefined();
  expect(parseMaxToolCalls({ LLM_AGENT_MAX_TOOL_CALLS: ' 12 ' })).toBe(12);
  for (const raw of ['0', '-1', '1.5', 'NaN', '1e2', '9007199254740992'])
    expect(() => parseMaxToolCalls({ LLM_AGENT_MAX_TOOL_CALLS: raw })).toThrow(
      'LLM_AGENT_MAX_TOOL_CALLS',
    );
});
