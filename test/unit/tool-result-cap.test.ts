import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseToolResultMaxChars } from '../../srv/agent-config';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  evaluateDeterministic,
  parseToolOutcome,
} from '../../srv/lib/reviewer-core';
import { buildReviewMessages } from '../../srv/lib/step-reviewer';
import {
  capToolResult,
  withToolResultCap,
} from '../../srv/lib/tool-result-cap';

const notice = '[result truncated: 5 of 6 characters shown.';

test.each([
  { success: false, status: 'inactive', error: 'Create rejected' },
  { success: true, status: 'active', error: undefined },
])('preserves complete envelope facts across truncation: %j', async (facts) => {
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
    capToolResult({ content }, 50).result.content,
  );
  expect(() => JSON.parse(records[0].result.content as string)).toThrow();
  const outcome = parseToolOutcome(records[0]);
  expect(outcome).toMatchObject({
    name: 'CreateClass',
    ok: facts.success,
    status: facts.status,
    truncation: {
      truncated: true,
      originalLength: content.length,
      keptLength: 50,
    },
  });
  expect(outcome.error).toBe(facts.error);
  expect(evaluateDeterministic('I created the class.', records).ok).toBe(
    facts.success,
  );
  expect(evaluateDeterministic('I activated the class.', records).ok).toBe(
    facts.success,
  );
  const messages = buildReviewMessages({
    task: 'create and activate',
    content: 'done',
    executedTools: records.map(parseToolOutcome),
  });
  expect(messages[1].content).toContain(
    facts.success ? 'active' : 'Create rejected',
  );
});

test('cap keeps exactly the allowed prefix, appends paging notice and preserves isError', () => {
  const capped = capToolResult({ content: 'abcdef', isError: true }, 5);
  expect(capped.result.content).toContain(`abcde\n${notice}`);
  expect(capped.result.content).toContain('page through the rest.');
  expect(capped.result.isError).toBe(true);
  expect(capped.truncation).toEqual({
    truncated: true,
    originalLength: 6,
    keptLength: 5,
  });
});
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
    const capped = capToolResult({ content }, 5);
    expect(capped.result.content).toBe(
      text.slice(0, 5) +
        `\n[result truncated: 5 of ${text.length} characters shown. Narrow the request (smaller max_results/limit, a from/to range, filters, or one id) and page through the rest.]`,
    );
  },
);
test('normal chat client and recording worker both cap results; reviewer sees the same result and lengths', async () => {
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
    result: { content: expect.stringContaining(notice), isError: false },
    truncation: { truncated: true, originalLength: 6, keptLength: 5 },
  });
});
test('configuration defaults, zero and strict nonnegative integer validation', () => {
  expect(parseToolResultMaxChars({})).toBe(60000);
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

test('truncation logging includes only known name and lengths, once per result', async () => {
  const log = cds.log('tool-result-cap');
  const spy = jest.spyOn(log, 'info').mockImplementation(() => {});
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
        'Tool result truncated',
        { tool: 'Known', originalLength: 6, keptLength: 5 },
      ],
      ['Tool result truncated', { originalLength: 6, keptLength: 5 }],
    ]);
  } finally {
    spy.mockRestore();
  }
});
test('honesty reviewer is told which portion was visible to the worker', () => {
  const outcome = parseToolOutcome({
    call: { id: 'read', name: 'GetTable', arguments: {} },
    result: { content: 'abcde\n[result truncated]', isError: false },
    ...{
      truncation: {
        truncated: true as const,
        originalLength: 6,
        keptLength: 5,
      },
    },
  });
  const messages = buildReviewMessages({
    task: 'read',
    content: 'done',
    executedTools: [outcome],
  });
  expect(messages[1].content).toContain(
    'result truncated: 5 of 6 characters shown to worker; omitted content is unknown',
  );
});
