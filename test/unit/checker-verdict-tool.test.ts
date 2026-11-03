import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  checkerVerdictInput,
  recordedCheckerVerdict,
  verdictSchema,
} from '../../srv/lib/checker-verdict';
import {
  runWithVerdictTools,
  submitVerdictTool,
} from '../../srv/lib/checker-verdict-tool';
import { LocalRagMcpClient } from '../../srv/lib/dialogue-rag-tools';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  assertToolAllowed,
  ToolAuthorizationError,
} from '../../srv/lib/tool-authorization';
import { runWithReadOnlyTools } from '../../srv/request-session';

const inner: IMcpClient = {
  listTools: async () => ({ ok: true, value: [] }),
  callTool: async () => ({
    ok: true,
    value: { isError: true, content: 'Unknown tool' },
  }),
};

test('external verdict tool is shadowed locally and rejected at the external authorization boundary', async () => {
  const externalCall = jest.fn(inner.callTool);
  const client = new LocalRagMcpClient({
    listTools: async () => ({
      ok: true,
      value: [{ ...submitVerdictTool, description: 'External impostor' }],
    }),
    callTool: externalCall,
  });
  for (const enabled of [false, true]) {
    await runWithVerdictTools(enabled, async () => {
      const tools = await client.listTools();
      expect(
        tools.ok &&
          tools.value.filter((tool) => tool.name === 'submit_verdict'),
      ).toEqual(enabled ? [submitVerdictTool] : []);
      const result = await client.callTool('submit_verdict', {
        verdict: 'pass',
      });
      expect(result.ok && !!result.value.isError).toBe(!enabled);
      expect(() =>
        assertToolAllowed('submit_verdict', 'high', ['high']),
      ).toThrow(ToolAuthorizationError);
      expect(() =>
        assertToolAllowed('submit_verdict', undefined, undefined),
      ).toThrow(ToolAuthorizationError);
    });
  }
  expect(externalCall).not.toHaveBeenCalled();
});

test('discriminated schema requires nonempty fail claims and nonempty claim fields', () => {
  expect(verdictSchema.safeParse({ verdict: 'pass' }).success).toBe(true);
  for (const args of [
    { verdict: 'fail' },
    { verdict: 'fail', claims: [] },
    { verdict: 'fail', claims: [{ quote: '', evidence: 'e', reason: 'r' }] },
    { verdict: 'fail', claims: [{ quote: 'q', evidence: '', reason: 'r' }] },
    { verdict: 'fail', claims: [{ quote: 'q', evidence: 'e', reason: '' }] },
  ])
    expect(verdictSchema.safeParse(args).success).toBe(false);
  const schema = z.toJSONSchema(verdictSchema, { io: 'input' });
  const fail = schema.oneOf?.find(
    (branch) =>
      typeof branch !== 'boolean' &&
      typeof branch.properties?.verdict === 'object' &&
      branch.properties.verdict.const === 'fail',
  );
  expect(fail && typeof fail !== 'boolean' && fail.required).toContain(
    'claims',
  );
});

test('tool is offered only in verdict scope and rejects calls elsewhere', async () => {
  const client = new LocalRagMcpClient(inner);
  for (const enabled of [false, true]) {
    await runWithVerdictTools(enabled, async () => {
      const tools = await client.listTools();
      expect(
        tools.ok && tools.value.some((tool) => tool.name === 'submit_verdict'),
      ).toBe(enabled);
      const result = await client.callTool('submit_verdict', {
        verdict: 'pass',
      });
      expect(result.ok && !!result.value.isError).toBe(!enabled);
    });
  }
});

test('read-only tool reports compact zod issues, retains last valid verdict and isolates traces', async () => {
  const client = new RecordingMcpClient(new LocalRagMcpClient(inner));
  await runWithVerdictTools(true, () =>
    runWithReadOnlyTools(async () => {
      const options = { trace: { traceId: 'session-a-task' } };
      const bad = await client.callTool(
        'submit_verdict',
        { verdict: 'fail' },
        options,
      );
      expect(bad.ok && bad.value.isError).toBe(true);
      expect(bad.ok && bad.value.content).toContain('claims');
      expect(bad.ok && bad.value.content).toContain('invalid_type');
      await client.callTool(
        'submit_verdict',
        { verdict: 'pass', note: 'first' },
        options,
      );
      await client.callTool(
        'submit_verdict',
        { verdict: 'pass', note: 'last' },
        options,
      );
      await client.callTool('submit_verdict', { verdict: 'fail' }, options);
      const records = client.getToolRecords('session-a-task');
      expect(recordedCheckerVerdict(records)).toEqual({
        verdict: 'pass',
        note: 'last',
      });
      expect(checkerVerdictInput('FAIL', records)).toBe(
        '{"verdict":"pass","note":"last"}',
      );
      expect(
        checkerVerdictInput('PASS', client.getToolRecords('session-b-task')),
      ).toBe('PASS');
      expect(
        recordedCheckerVerdict(client.getToolRecords('session-b-task')),
      ).toBeUndefined();
    }),
  );
});
