import type { WorkerProfile } from '@mcp-abap-adt/llm-agent';
import { runExecutorStep } from '../../srv/lib/executor-step';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  captureReviewProfile,
  getReviewProfile,
  recordReviewProfile,
} from '../../srv/lib/review-scope';
import {
  buildReviewMessages,
  evaluateGated,
} from '../../srv/lib/step-reviewer';
import { systemToolTrust } from '../../srv/lib/system-tool-trust';
import {
  fixtureProfileSource,
  fixtureTrustResolver,
} from './helpers/agent-profiles';

jest.mock('../../srv/lib/step-reviewer', () => ({
  ...jest.requireActual('../../srv/lib/step-reviewer'),
  evaluateGated: jest.fn(async () => ({ ok: true })),
}));

test('executor-step and notice evidence use each reviewed profile without inheriting another worker map', async () => {
  const resolver = fixtureTrustResolver();
  let resolvedProfile: WorkerProfile;
  const agent = {
    process: async () => {
      recordReviewProfile(resolvedProfile);
      return { ok: true, value: { content: 'done' } };
    },
  };
  const critic = { chat: jest.fn(), streamChat: async function* () {} };
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
    ['executor', { system: 5 }],
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
      agent,
      executor: agent,
      recMcp,
      criticLlm: critic,
      trustResolver: resolver,
      toolTrust: systemToolTrust(() => true, resolver),
      toolTrustFor: (role: typeof resolver) =>
        systemToolTrust(() => true, role),
      profileRunner: {
        createWorker: async () => ({
          ok: true,
          value: { name, run: async () => ({ output: 'done' }) },
        }),
      },
    };
    const createSource = jest.fn(() => source);
    await runExecutorStep(
      createSource,
      handle as never,
      'user',
      'read',
      name,
      {},
    );
    if (name === 'executor') expect(createSource).not.toHaveBeenCalled();
    const finalizer = new NoticeFinalizer(recMcp, critic, undefined, () =>
      systemToolTrust(
        () => true,
        resolver.forProfile(getReviewProfile() ?? {}),
      ),
    );
    await captureReviewProfile(async () => {
      recordReviewProfile(profile);
      await finalizer.finalize({
        prompt: 'read',
        objective: 'read',
        interpreterOutput: 'done',
        executionTrace: [],
      });
    });
    for (const [args] of jest.mocked(evaluateGated).mock.calls.slice(-2)) {
      const messages = buildReviewMessages({
        task: 'read',
        content: 'done',
        executedTools: [],
        toolTrust: args.toolTrust,
        history: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'sap',
                type: 'function',
                function: { name: 'GetClass', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'sap', content: 'raw' },
        ],
      });
      expect(messages[1].content).toContain(
        `[source: system:GetClass; trust ${trust?.system ?? 4.5}]`,
      );
    }
  }
});
