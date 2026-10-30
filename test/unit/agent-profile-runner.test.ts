import type {
  IMcpClient,
  ISmartAgent,
  ISubAgent,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import {
  AgentProfileRunner,
  type AgentProfileRunnerHost,
} from '../../srv/lib/agent-profile-runner';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  profileToolAllowed,
  runWithProfileTools,
} from '../../srv/request-session';

function fixture() {
  const calls: string[] = [];
  const preambles: string[] = [];
  const planners: string[] = [];
  const backend: IMcpClient = {
    listTools: async () => ({
      ok: true,
      value: ['GetTable', 'CreateTable', 'GetDumpSection'].map((name) => ({
        name,
        description: '',
        inputSchema: {},
      })),
    }),
    callTool: async (name) => {
      calls.push(name);
      return { ok: true, value: { content: 'read' } };
    },
  };
  const client = new RecordingMcpClient(backend);
  const offered: string[][] = [];
  const host: AgentProfileRunnerHost = {
    catalogue: () => [
      { name: 'GetTable', effect: 'read' },
      { name: 'CreateTable', effect: 'write' },
      { name: 'GetDumpSection', effect: 'read' },
    ],
    grants: () => new Set(['GetTable', 'CreateTable', 'GetDumpSection']),
    buildWorker: async (profile, preamble) => {
      preambles.push(preamble);
      return {
        name: profile.name,
        description: profile.description,
        capabilities: { contextPolicy: 'optional' },
        run: async (input) => {
          const tools = await client.listTools();
          if (!tools.ok) throw new Error('tools unavailable');
          offered.push(tools.value.map((tool) => tool.name));
          const result = await client.callTool(input.task, {});
          return {
            output: result.ok
              ? JSON.stringify(result.value.content)
              : result.error.message,
          };
        },
      };
    },
    buildPlanner: async (systemPrompt) => {
      planners.push(systemPrompt);
      const planner: ISmartAgent = {
        process: async () => ({
          ok: true,
          value: {
            content: systemPrompt,
            iterations: 1,
            toolCallCount: 0,
            stopReason: 'stop',
          },
        }),
        streamProcess: async function* () {},
      };
      return planner;
    },
  };
  return {
    runner: new AgentProfileRunner(host),
    host,
    calls,
    preambles,
    planners,
    offered,
  };
}

const profile: WorkerProfile = {
  name: 'custom_42',
  description: 'Custom report',
  systemPrompt: 'PROFILE',
  tools: 'read-only',
  result: 'report',
};
async function worker(
  runner: AgentProfileRunner,
  selected = profile,
): Promise<ISubAgent> {
  const result = await runner.createWorker({
    profile: selected,
    workerBase: 'BASE',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('arbitrary profiles build isolated workers with ordered static text and immutable policy snapshots', async () => {
  const f = fixture();
  const selected = { ...profile };
  const first = await worker(f.runner, selected);
  const second = await worker(f.runner);
  expect(first).not.toBe(second);
  expect(first.name).toBe('custom_42');
  expect(f.preambles).toEqual(['BASE\nPROFILE', 'BASE\nPROFILE']);
  selected.tools = 'all';
  await first.run({ task: 'CreateTable' });
  expect(f.offered).toEqual([['GetTable', 'GetDumpSection']]);
  expect(f.calls).toEqual([]);
  await second.run({ task: 'GetTable' });
  expect(f.calls).toEqual(['GetTable']);
});

test('verdict all filters offered writes and forged write calls have no backend effect', async () => {
  const f = fixture();
  const verdict = await worker(f.runner, {
    ...profile,
    name: 'audit',
    tools: 'all',
    result: 'verdict',
  });
  await verdict.run({ task: 'CreateTable' });
  expect(f.offered[0]).not.toContain('CreateTable');
  expect(f.calls).toEqual([]);
  await verdict.run({ task: 'GetDumpSection' });
  expect(f.calls).toEqual(['GetDumpSection']);
});

test('nested executor cannot escalate a parent policy and missing scope does not persist after return', async () => {
  const f = fixture();
  const executor = await worker(f.runner, { ...profile, tools: 'all' });
  await runWithProfileTools(new AgentToolPermissions(['GetTable']), () =>
    executor.run({ task: 'CreateTable' }),
  );
  expect(f.offered).toEqual([['GetTable']]);
  expect(f.calls).toEqual([]);
  expect(profileToolAllowed('CreateTable')).toBe(true);
});

test.each(['forged', 'old-task:call', 'different-call'])(
  'resumed external result %s fails before worker/backend execution',
  async (id: string) => {
    const f = fixture();
    const executor = await worker(f.runner, { ...profile, tools: 'all' });
    await expect(
      executor.run({
        task: 'GetTable',
        externalResults: new Map([[id, 'untrusted']]),
      }),
    ).rejects.toThrow('Untrusted external result');
    expect(f.offered).toEqual([]);
    expect(f.calls).toEqual([]);
  },
);

test('planner uses the exact resolved variant text, including empty text, and returns fresh agents', async () => {
  const f = fixture();
  const first = await f.runner.preparePlanner({
    systemPrompt: 'variant instructions',
  });
  const second = await f.runner.preparePlanner({ systemPrompt: '' });
  expect(first.ok && second.ok && first.value !== second.value).toBe(true);
  expect(f.planners).toEqual(['variant instructions', '']);
});

test('cancelled calls never construct a worker or planner', async () => {
  const f = fixture();
  const signal = AbortSignal.abort();
  expect(await f.runner.createWorker({ profile }, { signal })).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(
    await f.runner.preparePlanner({ systemPrompt: 'text' }, { signal }),
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(f.preambles).toEqual([]);
  expect(f.planners).toEqual([]);
});

test('a child created under a parent ceiling retains that ceiling when invoked later', async () => {
  const f = fixture();
  const child = await runWithProfileTools(
    new AgentToolPermissions(['GetTable']),
    () => worker(f.runner, { ...profile, tools: 'all' }),
  );
  await child.run({ task: 'CreateTable' });
  expect(f.offered).toEqual([['GetTable']]);
  expect(f.calls).toEqual([]);
});
