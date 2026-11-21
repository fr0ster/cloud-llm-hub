import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { verdictSchema } from '../../srv/lib/checker-verdict-schema';
import {
  runWithVerdictTools,
  submitVerdict,
  submitVerdictTool,
} from '../../srv/lib/checker-verdict-tool';
import { coordinatorToolsClient } from '../../srv/lib/coordinator-tools-client';
import { LocalRagMcpClient } from '../../srv/lib/dialogue-rag-tools';
import {
  assertToolAllowed,
  ToolAuthorizationError,
} from '../../srv/lib/tool-authorization';

const inner: IMcpClient = {
  listTools: async () => ({ ok: true, value: [] }),
  callTool: async () => ({
    ok: true,
    value: { isError: true, content: 'Unknown tool' },
  }),
};
const confirmed = {
  claim: 'Created ZREQ.',
  status: 'confirmed',
  evidence: { callId: 'create' },
  reason: 'The journal confirms the write.',
};
const pass = { verdict: 'pass', findings: [confirmed] };

test('submit_verdict publishes the typed schema and validates findings', () => {
  expect(submitVerdictTool.inputSchema.required).toEqual([
    'verdict',
    'findings',
  ]);
  expect(Object.keys(submitVerdictTool.inputSchema.properties ?? {})).toEqual([
    'verdict',
    'count',
    'findings',
  ]);
  runWithVerdictTools(true, () => {
    expect(submitVerdict(pass).isError).toBeUndefined();
    expect(submitVerdict({ verdict: 'fail' }).content).toContain('findings');
    expect(
      submitVerdict({
        ...pass,
        findings: [{ ...confirmed, status: 'unsupported' }],
      }).isError,
    ).toBe(true);
    expect(
      submitVerdict({ ...pass, findings: [{ ...confirmed, reason: '' }] })
        .isError,
    ).toBe(true);
  });
  expect(verdictSchema.safeParse({ ...pass, count: 1 }).success).toBe(true);
  expect(verdictSchema.safeParse({ ...pass, count: -1 }).success).toBe(false);
  expect(verdictSchema.safeParse({ ...pass, count: 1.5 }).success).toBe(false);
  expect(submitVerdict(pass).isError).toBe(true);
});

test('model tool catalogues expose top-level object schemas', async () => {
  const coordinatorClient = coordinatorToolsClient({
    wrapRun: (run) => run(undefined),
    getSmartAgent: async () => {
      throw new Error('Schema discovery only');
    },
    runExecutorStep: async () => {
      throw new Error('Schema discovery only');
    },
  });
  const coordinatorTools = await coordinatorClient.listTools();
  if (!coordinatorTools.ok) throw new Error(coordinatorTools.error.message);
  expect(coordinatorTools.value.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['new_request', 'search_knowledge', 'deliver']),
  );
  for (const coordinator of [false, true]) {
    await runWithVerdictTools(true, async () => {
      const client = new LocalRagMcpClient(
        {
          ...inner,
          listTools: () => coordinatorClient.listTools(),
        },
        undefined,
        coordinator,
      );
      const result = await client.listTools();
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.some((tool) => tool.name === 'rag_search')).toBe(
        true,
      );
      expect(result.value.some((tool) => tool.name === 'rag_persist')).toBe(
        coordinator,
      );
      for (const tool of result.value) {
        expect({ name: tool.name, type: tool.inputSchema.type }).toEqual({
          name: tool.name,
          type: 'object',
        });
        expect(tool.inputSchema.properties).toBeInstanceOf(Object);
        expect(Array.isArray(tool.inputSchema.properties)).toBe(false);
        for (const keyword of ['oneOf', 'anyOf', 'allOf'])
          expect(tool.inputSchema).not.toHaveProperty(keyword);
      }
    });
  }
});

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
      const result = await client.callTool('submit_verdict', pass);
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
