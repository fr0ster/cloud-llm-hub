import type { WorkerProfile } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { AgentProfileRunner } from '../../srv/lib/agent-profile-runner';
import { runExecutorStep } from '../../srv/lib/executor-step';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  captureReviewProfile,
  getReviewProfile,
  recordReviewProfile,
} from '../../srv/lib/review-scope';
import { evaluateGated } from '../../srv/lib/step-reviewer';
import { systemToolTrust } from '../../srv/lib/system-tool-trust';
import {
  fixtureProfileSource,
  fixtureTrustResolver,
} from './helpers/agent-profiles';

jest.mock('../../srv/lib/step-reviewer', () => ({
  ...jest.requireActual('../../srv/lib/step-reviewer'),
  evaluateGated: jest.fn(async () => ({ ok: true })),
}));

test('executor-step and finalizer do not invoke a critic for any worker profile', async () => {
  const resolver = fixtureTrustResolver();
  let resolvedProfile: WorkerProfile;
  const critic = {
    chat: jest.fn(async () => ({
      ok: true as const,
      value: { content: 'OK', finishReason: 'stop' as const },
    })),
    streamChat: async function* () {},
  };
  const baseHandle = await new SmartAgentBuilder().withMainLlm(critic).build();
  critic.chat.mockClear();
  const agent = baseHandle.agent;
  jest.spyOn(agent, 'process').mockImplementation(async () => {
    recordReviewProfile(resolvedProfile);
    return {
      ok: true,
      value: {
        content: 'done',
        iterations: 1,
        toolCallCount: 0,
        stopReason: 'stop',
      },
    };
  });
  const recMcp = new RecordingMcpClient({
    listTools: jest.fn(),
    callTool: jest.fn(),
  });
  const workers = new Map([
    [
      'executor',
      {
        name: 'executor',
        capabilities: { contextPolicy: 'optional' as const },
        run: async () => ({ output: 'done' }),
      },
    ],
  ]);
  for (const [name, trust] of [
    ['executor', { target: 5 }],
    ['other', undefined],
  ] as const) {
    const profile: WorkerProfile = {
      name,
      description: '',
      systemPrompt: '',
      tools: 'all',
      result: 'report',
      trust,
    };
    resolvedProfile = profile;
    const source = {
      ...fixtureProfileSource(() => workers),
      get: async () => ({ ok: true as const, value: profile }),
    };
    const handle = {
      ...baseHandle,
      agent,
      executor: agent,
      recMcp,
      trustResolver: resolver,
      toolTrust: systemToolTrust(() => true, resolver),
      toolTrustFor: (role: typeof resolver) =>
        systemToolTrust(() => true, role),
      profileRunner: new AgentProfileRunner({
        catalogue: () => [],
        grants: () => new Set(),
        buildPlanner: async () => agent,
        buildWorker: async () => ({
          name,
          capabilities: { contextPolicy: 'optional' },
          run: async () => ({ output: 'done' }),
        }),
      }),
    } satisfies Parameters<typeof runExecutorStep>[1];
    const createSource = jest.fn(() => source);
    await runExecutorStep(createSource, handle, 'user', 'read', name, {});
    if (name === 'executor') expect(createSource).not.toHaveBeenCalled();
    else expect(createSource).toHaveBeenCalledWith('user');
    const finalizer = new NoticeFinalizer(recMcp);
    await captureReviewProfile(async () => {
      recordReviewProfile(profile);
      await finalizer.finalize({
        prompt: 'read',
        objective: 'read',
        interpreterOutput: 'done',
        executionTrace: [],
      });
    });
    expect(critic.chat).not.toHaveBeenCalled();
    for (const [args] of jest.mocked(evaluateGated).mock.calls.slice(-2)) {
      expect(args).not.toHaveProperty('llm');
      expect(args.records).toEqual([]);
    }
  }
});
