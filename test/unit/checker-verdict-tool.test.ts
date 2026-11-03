import {
  createDialogueTaskContext,
  type DialogueSignals,
  type IMcpClient,
} from '@mcp-abap-adt/llm-agent';
import {
  SmartAgentBuilder,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { createSignalBus } from '@mcp-abap-adt/llm-signals';
import { z } from 'zod';
import {
  checkerVerdictInput,
  parseCheckerVerdict,
  recordedCheckerVerdict,
  verdictSchema,
} from '../../srv/lib/checker-verdict';
import {
  runWithVerdictTools,
  submitVerdict,
  submitVerdictTool,
} from '../../srv/lib/checker-verdict-tool';
import { coordinatorToolsClient } from '../../srv/lib/coordinator-tools-client';
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

test('only valid verdict calls in verdict profiles finish their task', async () => {
  for (const coordinator of [false, true]) {
    for (const enabled of [false, true]) {
      const bus = createSignalBus<DialogueSignals>();
      const dialogueTask = createDialogueTaskContext(bus, 'session', 'checker');
      const client = new RecordingMcpClient(
        new LocalRagMcpClient(inner, undefined, coordinator),
      );
      const options = { dialogueTask, trace: { traceId: 'checker-run' } };
      await runWithVerdictTools(enabled, async () => {
        await client.callTool('submit_verdict', { verdict: 'fail' }, options);
        expect(dialogueTask.readFinish()).toBeUndefined();
        const verdict = {
          verdict: 'fail',
          claims: [{ quote: 'q', evidence: 'e', reason: 'r' }],
        };
        await client.callTool('submit_verdict', verdict, options);
        const finish = dialogueTask.readFinish();
        if (enabled && !coordinator) {
          expect(finish).toMatchObject({
            output: JSON.stringify(verdict),
            tool: 'submit_verdict',
          });
          expect(parseCheckerVerdict(finish?.output ?? '')).toEqual(verdict);
          expect(
            recordedCheckerVerdict(client.getToolRecords('checker-run')),
          ).toEqual(parseCheckerVerdict(finish?.output ?? ''));
        } else expect(finish).toBeUndefined();
      });
    }
  }
});

test.each(['pass', 'retry'] as const)(
  'checker worker finishes after submit_verdict without another model call (%s)',
  async (mode) => {
    const dialogueTask = createDialogueTaskContext(
      createSignalBus<DialogueSignals>(),
      'session',
      'checker',
    );
    let calls = 0;
    const verdict = { verdict: 'pass', note: 'Verified' };
    const answer = () => {
      calls++;
      if (calls > (mode === 'retry' ? 2 : 1))
        throw new Error('Unexpected model call after valid verdict');
      return {
        ok: true as const,
        value: {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [
            {
              id: `verdict-${calls}`,
              name: 'submit_verdict',
              arguments:
                mode === 'retry' && calls === 1 ? { verdict: 'fail' } : verdict,
            },
          ],
        },
      };
    };
    const client = new RecordingMcpClient(new LocalRagMcpClient(inner));
    await runWithVerdictTools(true, async () => {
      const { agent } = await new SmartAgentBuilder({
        skipModelValidation: true,
        agent: {
          maxIterations: 5,
          classificationEnabled: false,
          ragTranslateEnabled: false,
        },
      })
        .withMainLlm({
          model: 'scripted',
          chat: async () => answer(),
          streamChat: async function* () {
            yield answer();
          },
        })
        .withMcpClients([client])
        .build();
      const worker = new SmartAgentSubAgent('checker', agent);
      const result = await worker.run({
        task: 'Check the report',
        dialogueTask,
        trace: { traceId: 'worker-run' },
      });
      expect(result.output).toBe(JSON.stringify(verdict));
      expect(calls).toBe(mode === 'retry' ? 2 : 1);
      expect(parseCheckerVerdict(result.output)).toEqual(
        recordedCheckerVerdict(client.getToolRecords('worker-run')),
      );
    });
  },
);

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

test('verdict tool advertises flat fields and strictly validates calls', () => {
  const schema = submitVerdictTool.inputSchema;
  expect(schema.required).toEqual(['verdict']);
  expect(schema.properties).toHaveProperty('verdict', {
    type: 'string',
    enum: ['pass', 'fail'],
  });
  expect(schema.properties).toMatchObject({
    count: { type: 'integer', minimum: 0 },
    note: { type: 'string' },
    claims: {
      type: 'array',
      description: 'Claims are required and non-empty when verdict is fail.',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
        required: ['quote', 'evidence', 'reason'],
      },
    },
  });
  runWithVerdictTools(true, () => {
    const clientArgs = [
      {},
      { verdict: 'fail' },
      { verdict: 'fail', claims: [] },
    ];
    for (const args of clientArgs)
      expect(submitVerdict(args).isError).toBe(true);
    expect(
      submitVerdict({
        verdict: 'fail',
        claims: [{ quote: 'q', evidence: 'e', reason: 'r' }],
      }).isError,
    ).toBeUndefined();
  });
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
