import { bindTestCaller } from './helpers/bind-test-caller';

const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildAgentForDestination,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getSharedHistoryRag,
  HUB_ADAPTIVE_CONTROLLER_SYSTEM,
  initProviders,
} from '../../srv/agent-manager';
import { clientHistoryMessages } from '../../srv/lib/client-history';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { callOptionsFor } from '../../srv/lib/rag-caller';
import { getRunRecordStore } from '../../srv/lib/run-record-store';
import { recordTurn } from '../../srv/lib/session-turns';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { isWriteTool } from '../../srv/lib/write-guardrail';
import { runWithSessionId } from '../../srv/request-session';

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(),
}));

const config: AgentConfig = {
  limits: {},
  trust: {
    defaults: {
      global: 3,
      system: 4.8,
      correction: 4.9,
      target: 4.3,
      docs: 4.2,
      client: 4.4,
      user: 3.5,
      session: 4,
    },
  },
  llm: {
    provider: 'openai',
    model: 'test',
    classifierModel: 'test',
    temperature: 0,
    maxTokens: 2000,
    apiKey: 'fake',
    baseUrl: 'http://localhost',
    whenThrottled: new WaitIfShortEnough(20_000),
  },
  mcp: { destination: 'TEST', systemDestinations: {} },
  agent: {
    dialogue: {
      executors: 3,
      executorPool: 6,
      maxTasks: 50,
      maxCorrections: 2,
      followMaxMs: 1_800_000,
    },
    chatCoordinator: 'adaptive',
    mode: 'smart',
    maxIterations: 10,
    ragType: 'in-memory',
    ragQueryK: 5,
    skillRagK: 0,
    allowLlmOnlyFallback: false,
  },
  rag: {
    embedder: null,
    backends: {
      tools: 'in-memory',
      session: 'in-memory',
      persistent: 'in-memory',
    },
  },
  destinations: { source: 'btp' },
};

describe('adaptive chat through the real hub build and library pipeline', () => {
  let scenario:
    | 'hello'
    | 'throw'
    | 'invalid'
    | 'check-write'
    | 'explicit-check'
    | 'revise';
  const revisionCount = 21;
  const calls: string[] = [];
  const controllerPrompts: string[] = [];
  const answer = 'I created and activated class ZTEST.';
  function respond(messages: Message[]): string {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    if (system.includes('sequential adaptive plan')) {
      calls.push('controller');
      controllerPrompts.push(messages.map((m) => m.content).join('\n'));
      if (scenario === 'throw') throw new Error('planning unavailable');
      if (scenario === 'invalid') return 'not JSON';
      if (scenario === 'revise') {
        const call = controllerPrompts.length;
        const step =
          call <= revisionCount
            ? { id: `revise-${call}`, kind: 'revise', reason: 'Refine plan' }
            : { id: 'answer', kind: 'answer', text: 'Plan complete' };
        return JSON.stringify({ steps: [step] });
      }
      if (scenario === 'check-write' || scenario === 'explicit-check')
        return JSON.stringify({
          steps: [
            {
              id: 'verify',
              kind: 'check',
              worker: scenario === 'explicit-check' ? 'checker' : 'executor',
              goal: 'verify',
              context: {
                note: JSON.stringify([
                  {
                    claim: 'Created class ZTEST.',
                    system: 'sap',
                    target: { type: 'class', name: 'ZTEST' },
                    evidence: {},
                  },
                ]),
              },
              targets: [],
              onPass: 'done',
              onFail: 'done',
            },
            { id: 'done', kind: 'answer', text: 'Verified' },
          ],
        });
      return JSON.stringify({
        steps: [{ id: 'hello', kind: 'answer', text: 'Hello!' }],
      });
    }
    calls.push('executor');
    return answer;
  }
  const llm: ILlm = {
    model: 'test',
    chat: jest.fn(async (messages, tools) => {
      if (tools?.some(({ name }) => name === 'submit_verdict')) {
        calls.push('checker');
        expect(tools.map(({ name }) => name)).toEqual(['submit_verdict']);
        return {
          ok: true as const,
          value: {
            content: '',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
            toolCalls: [
              {
                id: 'verdict',
                name: 'submit_verdict',
                arguments: {
                  verdict: 'fail',
                  findings: [
                    {
                      claim: 'Created class ZTEST.',
                      status: 'unsupported',
                      evidence: {},
                      reason: 'Citation missing.',
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      return {
        ok: true as const,
        value: { content: respond(messages), finishReason: 'stop' as const },
      };
    }),
    streamChat: jest.fn(async function* (messages) {
      if (scenario === 'check-write') {
        yield {
          ok: true as const,
          value: {
            content: JSON.stringify({ verdict: 'pass', reason: 'checked' }),
            finishReason: 'stop' as const,
          },
        };
        return;
      }
      yield {
        ok: true as const,
        value: { content: respond(messages), finishReason: 'stop' as const },
      };
    }),
  };

  beforeAll(async () => {
    jest.mocked(makeHubLlm).mockResolvedValue(llm);
    initProviders(await startProviders(config));
    await bindTestCaller(taskCaller);
    await getCollectionRegistry().seedAgentConfiguration(
      'agents',
      'coordinator',
    );
  });
  beforeEach(() => {
    calls.length = 0;
    controllerPrompts.length = 0;
  });

  async function run(
    sessionId: string,
    prompt: string | Message[],
    userId = 'alice',
    remembered?: string,
    runConfig: AgentConfig = config,
  ) {
    // Model the client ingress once; internal coordinator/worker calls are unfiltered.
    if (typeof prompt !== 'string')
      prompt = clientHistoryMessages(prompt, runConfig.agent.clientHistory);
    const callTool = jest.fn();
    const handle = await buildAgentForDestination(
      {
        listTools: async () => ({ ok: true, value: [] }),
        callTool,
      } as never,
      new ExpositionFilteringRag(
        new InMemoryRag(),
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        'off',
      ),
      runConfig,
    );
    const { SessionRetention, isRefusal } = await import(
      '../../srv/lib/session-retention'
    );
    const { hasSessionState, deleteSessionState } = await import(
      '../../srv/lib/session-state'
    );
    const retention = new SessionRetention({
      hasState: hasSessionState,
      deleteAll: deleteSessionState,
    });
    const caller = { sessionId, userId, isAdmin: false };
    await bindTestCaller(caller);
    const lease = retention.lease(userId, sessionId, 'pipeline');
    if (isRefusal(lease)) throw new Error('unexpected refusal');
    if (remembered)
      expect(
        await getSharedHistoryRag().recordTurn({
          caller,
          userText: 'Hello',
          assistantText: remembered,
        }),
      ).toBe(true);
    const chunks: string[] = [];
    const usage: number[] = [];
    await runWithSessionId(
      sessionId,
      async () => {
        for await (const chunk of handle.agent.streamProcess(prompt, {
          caller,
          sessionId,
          trace: { traceId: sessionId },
        })) {
          expect(chunk.ok).toBe(true);
          if (chunk.ok) {
            chunks.push(chunk.value.content);
            if (chunk.value.usage) usage.push(chunk.value.usage.totalTokens);
          }
        }
      },
      [],
      userId,
    );
    lease.release();
    if (runConfig.agent.chatCoordinator === 'adaptive')
      expect(retention.isKnown(userId, sessionId)).toBe(true);
    return {
      text: chunks.join(''),
      usage,
      callTool,
      record: await runWithSessionId(
        sessionId,
        () => getRunRecordStore().load(sessionId),
        [],
        userId,
      ),
    };
  }

  it('answers directly with zero checker calls and zero checker token usage', async () => {
    scenario = 'hello';
    const result = await run('adaptive-hello', 'Hello');
    expect(result.text).toBe('Hello!');
    expect(calls).toEqual(['controller']);
    expect(result.usage.reduce((total, tokens) => total + tokens, 0)).toBe(0);
    expect(controllerPrompts[0]).toContain(HUB_ADAPTIVE_CONTROLLER_SYSTEM);
    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.record?.outcome).toBe('answered');
    expect(result.record?.steps.map((s) => s.kind)).toEqual(['answer']);
  });
  it.each(['off', 'on'] as const)(
    '%s selects exactly one history source in adaptive prompts',
    async (clientHistory) => {
      scenario = 'hello';
      const remembered = `${'Full relevant history. '.repeat(500)}HISTORY_END`;
      const toolResult = `${'Full current tool result. '.repeat(100)}TOOL_END`;
      const result = await run(
        `adaptive-history-${clientHistory}`,
        [
          { role: 'user', content: 'CLIENT_OLD_REQUEST' },
          { role: 'assistant', content: 'CLIENT_OLD_ANSWER' },
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'current-call',
                type: 'function',
                function: { name: 'read', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', content: toolResult, tool_call_id: 'current-call' },
        ],
        'alice',
        remembered,
        { ...config, agent: { ...config.agent, clientHistory } },
      );
      expect(result.text).toBe('Hello!');
      expect(controllerPrompts).toHaveLength(1);
      if (clientHistory === 'off')
        expect(controllerPrompts[0]).toContain(remembered);
      else expect(controllerPrompts[0]).not.toContain('HISTORY_END');
      expect(controllerPrompts[0]).toContain(toolResult);
      expect(controllerPrompts[0].includes('CLIENT_OLD_REQUEST')).toBe(
        clientHistory === 'on',
      );
      expect(controllerPrompts[0].includes('CLIENT_OLD_ANSWER')).toBe(
        clientHistory === 'on',
      );
      await getSharedHistoryRag().forgetSessionHistory(
        `adaptive-history-${clientHistory}`,
      );
    },
  );

  it('finishes an adaptive run beyond the library step, revision and duration defaults', async () => {
    scenario = 'revise';
    const now = Date.now();
    const clock = jest
      .spyOn(Date, 'now')
      .mockImplementation(
        () => now + (controllerPrompts.length > 1 ? 300_001 : 0),
      );
    try {
      const result = await run('adaptive-long-plan', 'Refine the plan');
      expect(result.text).toBe('Plan complete');
      expect(result.record?.outcome).toBe('answered');
      expect(result.record?.steps).toHaveLength(revisionCount + 1);
    } finally {
      clock.mockRestore();
    }
  });
  it('preserves the executor selected by the adaptive plan', async () => {
    scenario = 'check-write';
    const result = await run('adaptive-check-executor', 'Verify the class');
    expect(calls).not.toContain('checker');
    expect(result.record?.plan.steps[0]).toMatchObject({
      kind: 'check',
      worker: 'executor',
    });
    expect(result.text).toBe('Verified');
  });

  it('uses the cited-claim contract for an explicitly chosen checker', async () => {
    scenario = 'explicit-check';
    const result = await run('adaptive-explicit-check', 'Verify the class');
    expect(calls).toEqual(['controller', 'checker']);
    expect(result.usage.reduce((total, tokens) => total + tokens, 0)).toBe(10);
    expect(result.record?.steps[0].verdict?.verdict).toBe('fail');
    expect(result.callTool).not.toHaveBeenCalled();
  });

  it('returns fixed answers unchanged even when the text claims a write', async () => {
    scenario = 'hello';
    const result = await run(
      'fixed-unverified-write',
      'Create class ZTEST',
      'alice',
      undefined,
      {
        ...config,
        agent: { ...config.agent, chatCoordinator: 'fixed' },
      },
    );
    expect(result.text).toBe(answer);
    expect(calls).not.toContain('checker');
  });

  it.each(['throw', 'invalid'] as const)(
    'preserves the fallback answer after %s planning without calling the checker',
    async (failure) => {
      scenario = failure;
      const result = await run(
        `adaptive-${failure}`,
        'Create and activate class ZTEST',
      );
      expect(calls[0]).toBe('controller');
      expect(calls).toContain('executor');
      expect(result.text).toContain(answer);
      const offered = jest
        .mocked(llm.streamChat)
        .mock.calls.filter(
          (call) => call[2]?.trace?.traceId === `adaptive-${scenario}`,
        )
        .flatMap((call) => call[1] ?? []);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.some((tool) => isWriteTool(tool.name))).toBe(false);
      expect(result.text).not.toContain('UNVERIFIED_WRITE');
      expect(calls).not.toContain('checker');
      expect(result.callTool).not.toHaveBeenCalled();
      expect(result.record?.outcome).toBe('answered');
      expect(result.record?.steps.some((s) => s.kind === 'work')).toBe(true);
    },
  );
  it.each(['off', 'on'] as const)(
    '%s isolates users and sessions and gates only the previous-run prompt',
    async (clientHistory) => {
      scenario = 'hello';
      const runConfig: AgentConfig = {
        ...config,
        agent: { ...config.agent, clientHistory },
      };
      const sharedId = `shared-id-${clientHistory}`;
      const request = (sessionId: string, text: string, userId = 'alice') =>
        run(sessionId, text, userId, undefined, runConfig);
      const first = await request(sharedId, 'Alice private request');
      expect(first.record?.request).toBe('Alice private request');
      expect(first.record?.outcome).toBe('answered');
      await expect(request(sharedId, 'Bob request', 'bob')).rejects.toThrow(
        'Session is already bound',
      );
      await request(`bob-id-${clientHistory}`, 'Bob request', 'bob');
      expect(controllerPrompts.at(-1)).toContain('Previous run:\nnull');
      expect(controllerPrompts.at(-1)).not.toContain('Alice private request');
      await request(`other-id-${clientHistory}`, 'Alice other session');
      expect(controllerPrompts.at(-1)).toContain('Previous run:\nnull');
      const second = await request(sharedId, 'Alice continuation');
      expect(controllerPrompts.at(-1)).toContain('Previous run:\nnull');
      expect(controllerPrompts.at(-1)).not.toContain('Alice private request');
      expect(controllerPrompts.at(-1)).toContain('Alice continuation');
      expect(controllerPrompts.at(-1)).not.toContain('Bob request');
      expect(second.record?.request).toBe('Alice continuation');
      expect(second.record?.outcome).toBe('answered');
    },
  );

  it('off excludes an earlier run from the second prompt while its full turn remains retrievable in history RAG', async () => {
    scenario = 'hello';
    const caller = {
      sessionId: 'adaptive-previous-run-rag',
      userId: 'alice',
      isAdmin: false,
    };
    // No history turns are selected for automatic prompt assembly in this case.
    const runConfig: AgentConfig = {
      ...config,
      agent: { ...config.agent, clientHistory: 'off', ragQueryK: 0 },
    };
    const earlier = `EARLIER_REQUEST ${'Full request detail. '.repeat(500)}REQUEST_END`;
    const history = getSharedHistoryRag();
    try {
      const first = await run(
        caller.sessionId,
        earlier,
        caller.userId,
        undefined,
        runConfig,
      );
      expect(first.record?.request).toBe(earlier);
      // Use the same completed-turn recording entry point as the client handlers.
      recordTurn(caller, { role: 'user', content: earlier }, first.text);
      const second = await run(
        caller.sessionId,
        'SECOND_REQUEST',
        caller.userId,
        undefined,
        runConfig,
      );
      expect(controllerPrompts).toHaveLength(2);
      expect(controllerPrompts[1]).toContain('SECOND_REQUEST');
      expect(controllerPrompts[1]).toContain('Previous run:\nnull');
      expect(controllerPrompts[1]).not.toContain('EARLIER_REQUEST');
      expect(controllerPrompts[1]).not.toContain('Full request detail.');
      expect(controllerPrompts[1]).not.toContain('REQUEST_END');
      expect(second.record?.request).toBe('SECOND_REQUEST');
      const recalled = await history.query(
        new TextOnlyEmbedding('EARLIER_REQUEST'),
        1,
        callOptionsFor(caller),
      );
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) throw recalled.error;
      expect(recalled.value).toHaveLength(1);
      expect(recalled.value[0].text).toContain(earlier);
      expect(recalled.value[0].text).toContain(first.text);
    } finally {
      await history.forgetSessionHistory(caller.sessionId);
    }
  });
});
