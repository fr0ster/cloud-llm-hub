import { bindTestCaller } from './helpers/bind-test-caller';

const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};
const sessionCaller1 = { ...taskCaller, sessionId: 'dialogue-checker' };

import type { ILlm, ISubAgent, Message } from '@mcp-abap-adt/llm-agent';
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
import { LongSessionRegistry } from '../../srv/lib/long-session';
import { startProviders } from '../../srv/lib/providers';
import { callOptionsFor } from '../../srv/lib/rag-caller';
import { getRunRecordStore } from '../../srv/lib/run-record-store';
import { recordTurn } from '../../srv/lib/session-turns';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import {
  UserMcpBridge,
  type UserMcpCall,
  userMcpRegistration,
} from '../../srv/lib/user-mcp-bridge';
import { isWriteTool } from '../../srv/lib/write-guardrail';
import {
  profileToolAllowed,
  type RagCallerIdentity,
  runWithSessionId,
} from '../../srv/request-session';

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
      'user-mcp': 4.1,
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
    | 'revise'
    | 'user-mcp';
  const bridgedName = 'user__documents__lookup';
  const bridgedValue = 'Returned by the session executor';
  const revisionCount = 21;
  const checkerScopes: boolean[] = [];
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
      if (scenario === 'user-mcp')
        return JSON.stringify({
          steps: [
            {
              id: 'lookup',
              kind: 'work',
              worker: 'executor',
              goal: 'Look in the documents',
            },
            { id: 'answer', kind: 'answer', from: 'lookup' },
          ],
        });
      if (scenario === 'revise') {
        const call = controllerPrompts.length;
        const step =
          call <= revisionCount
            ? { id: `revise-${call}`, kind: 'revise', reason: 'Refine plan' }
            : { id: 'answer', kind: 'answer', text: 'Plan complete' };
        return JSON.stringify({ steps: [step] });
      }
      if (scenario === 'check-write')
        return JSON.stringify({
          steps: [
            {
              id: 'verify',
              kind: 'check',
              worker: 'executor',
              goal: 'verify',
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
      if (
        messages.some(
          (m) =>
            m.role === 'system' &&
            m.content?.includes('Final response write review'),
        )
      ) {
        calls.push('write-review');
        expect(tools?.map((tool) => tool.name)).toEqual(['submit_verdict']);
        const claims =
          scenario === 'throw' || scenario === 'invalid'
            ? ['created', 'activated'].map((operation) => ({
                system: 'sap',
                operation,
                target: { type: 'class', name: 'ZTEST' },
              }))
            : [];
        return {
          ok: true as const,
          value: {
            content: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [
              {
                id: 'write-review',
                name: 'submit_verdict',
                arguments: { verdict: claims.length ? 'fail' : 'pass', claims },
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
    streamChat: jest.fn(async function* (messages, tools) {
      if (scenario === 'user-mcp') {
        expect(tools?.some((tool) => tool.name === 'unregistered')).not.toBe(
          true,
        );
        const result = messages.find((message) => message.role === 'tool');
        if (!result && tools?.some((tool) => tool.name === bridgedName)) {
          yield {
            ok: true as const,
            value: {
              content: '',
              finishReason: 'tool_calls' as const,
              toolCalls: [
                {
                  id: 'lookup',
                  name: bridgedName,
                  arguments: { id: 'record-1' },
                },
              ],
            },
          };
        } else {
          if (result)
            expect(result.content).toContain(
              `[source: user-mcp:${bridgedName}; trust 4.1]`,
            );
          yield {
            ok: true as const,
            value: {
              content: result?.content?.includes(bridgedValue)
                ? bridgedValue
                : 'No session tool',
              finishReason: 'stop' as const,
            },
          };
        }
        return;
      }
      if (
        scenario === 'check-write' &&
        !messages.some((m) => m.role === 'tool')
      ) {
        checkerScopes.push(!profileToolAllowed('CreateClass'));
        yield {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [{ id: 'write', name: 'CreateClass', arguments: {} }],
            finishReason: 'tool_calls' as const,
          },
        };
        return;
      }
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
    identity?: RagCallerIdentity,
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
    await runWithSessionId(
      sessionId,
      async () => {
        for await (const chunk of handle.agent.streamProcess(prompt, {
          caller,
          sessionId,
          trace: { traceId: sessionId },
        })) {
          expect(chunk.ok).toBe(true);
          if (chunk.ok) chunks.push(chunk.value.content);
        }
      },
      [],
      userId,
      identity,
    );
    lease.release();
    expect(retention.isKnown(userId, sessionId)).toBe(true);
    return {
      executor: handle.executor,
      text: chunks.join(''),
      callTool,
      record: await runWithSessionId(
        sessionId,
        () => getRunRecordStore().load(sessionId),
        [],
        userId,
      ),
    };
  }

  it('executes registered MCP through the adaptive worker and the direct proxy, with no agent MCP access', async () => {
    scenario = 'user-mcp';
    const registry = new LongSessionRegistry(
      { ttlMs: 100, maxSessions: 1, maxPerUser: 1, queueLength: 0 },
      { onClose: async () => {} },
    );
    const session = registry.open('alice', {
      key: 'adaptive-user-mcp',
    });
    if ('refused' in session) throw new Error(session.refused);
    const bridge = new UserMcpBridge();
    session.userMcp = bridge;
    bridge.register(
      userMcpRegistration.parse({
        servers: [
          {
            name: 'documents',
            transport: 'browser',
            tools: [
              {
                name: 'lookup',
                description: 'Look up a document',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        ],
      }).servers,
    );
    const send = jest.fn((call: UserMcpCall) =>
      bridge.answer(call.callId, { result: { content: bridgedValue } }),
    );
    bridge.subscribe('browser', ['documents'], {
      executorId: 'browser-a',
      send,
      close: () => {},
    });
    const bridgeConfig = {
      ...config,
      agent: { ...config.agent, toolResultMaxChars: 1 },
    };
    try {
      const result = await run(
        session.key,
        'Look up a document',
        session.userId,
        undefined,
        bridgeConfig,
        { channel: 'openai', admin: false, userMcpSession: session },
      );
      expect(result.text).toBe(bridgedValue);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'documents',
          tool: 'lookup',
          arguments: { id: 'record-1' },
        }),
      );
      expect(result.callTool).not.toHaveBeenCalled();
      const direct = await runWithSessionId(
        session.key,
        () =>
          result.executor.process('Look up a document', {
            ...callOptionsFor({
              userId: session.userId,
              sessionId: session.key,
              isAdmin: false,
            }),
            externalTools: [
              {
                name: 'unregistered',
                description: 'An ad-hoc tool',
                inputSchema: { type: 'object' },
              },
            ],
          }),
        [],
        session.userId,
        { channel: 'openai', admin: false, userMcpSession: session },
      );
      expect(direct).toMatchObject({
        ok: true,
        value: { content: bridgedValue },
      });
      expect(send).toHaveBeenCalledTimes(2);
      send.mockClear();
      const mcp = await run(
        session.key,
        'Look up a document',
        session.userId,
        undefined,
        bridgeConfig,
        { channel: 'mcp-agent', admin: false, userMcpSession: session },
      );
      expect(mcp.text).toBe('No session tool');
      expect(send).not.toHaveBeenCalled();
    } finally {
      await registry.close(session.userId, session.key, 'explicit');
    }
  });

  it('reviews a direct adaptive answer without an executor tool-loop or SAP calls', async () => {
    scenario = 'hello';
    const result = await run('adaptive-hello', 'Hello');
    expect(result.text).toBe('Hello!');
    expect(calls).toEqual(['controller', 'write-review']);
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
  it('routes a generated executor check to read-only checker and blocks writes before MCP', async () => {
    scenario = 'check-write';
    checkerScopes.length = 0;
    const registry = getCollectionRegistry();
    const checker = await registry.getDocument('agents', 'checker');
    if (!checker) throw new Error('Missing checker');
    await registry.updateDocument('agents', 'checker', {
      metadata: { ...checker.metadata, tools: 'all', result: 'verdict' },
    });
    try {
      const result = await run('adaptive-check-write', 'Verify the class');
      expect(checkerScopes).toEqual([true]);
      expect(result.callTool).not.toHaveBeenCalled();
      expect(result.record?.plan.steps[0]).toMatchObject({
        kind: 'check',
        worker: 'checker',
      });
      expect(result.text).toBe('Verified');
    } finally {
      await registry.updateDocument('agents', 'checker', {
        metadata: checker.metadata,
      });
    }
  });

  it('rejects a report checker before running its tool loop', async () => {
    scenario = 'check-write';
    checkerScopes.length = 0;
    const registry = getCollectionRegistry();
    const checker = await registry.getDocument('agents', 'checker');
    if (!checker) throw new Error('Missing checker');
    await registry.updateDocument('agents', 'checker', {
      metadata: { ...checker.metadata, result: 'report', tools: 'all' },
    });
    try {
      const result = await run('adaptive-report-checker', 'Verify the class');
      expect(checkerScopes).toEqual([]);
      expect(result.callTool).not.toHaveBeenCalled();
      expect(JSON.stringify(result.record)).toContain(
        'Checker profile must have result: verdict',
      );
    } finally {
      await registry.updateDocument('agents', 'checker', {
        metadata: checker.metadata,
      });
    }
  });

  it('dialogue exposes the same raw executor and read-only checker workers', async () => {
    scenario = 'check-write';
    checkerScopes.length = 0;
    const callTool = jest.fn();
    const handle = (await buildAgentForDestination(
      {
        listTools: async () => ({ ok: true, value: [] }),
        callTool,
      } as never,
      new ExpositionFilteringRag(new InMemoryRag()),
      {
        ...config,
        agent: { ...config.agent, chatCoordinator: 'dialogue' },
      },
    )) as Awaited<ReturnType<typeof buildAgentForDestination>> & {
      workers: Map<string, ISubAgent>;
    };
    expect([...handle.workers.keys()]).toEqual(['executor', 'checker']);
    const checker = handle.workers.get('checker');
    if (!checker) throw new Error('checker missing');
    await bindTestCaller(sessionCaller1);
    await runWithSessionId(
      'dialogue-checker',
      () =>
        checker.run({
          caller: sessionCaller1,
          task: 'Verify the class',
          sessionId: 'dialogue-checker',
          externalTools: [
            {
              name: 'CreateClass',
              description: 'write',
              inputSchema: { type: 'object' },
            },
          ],
        }),
      [],
      'alice',
    );
    expect(checkerScopes).toEqual([true]);
    expect(callTool).not.toHaveBeenCalled();
  });
  it.each(['throw', 'invalid'] as const)(
    'reviews the fallback answer after %s planning and warns about writes without citations',
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
      expect(result.text).toContain('UNVERIFIED_WRITE:');
      expect(result.text).toContain(
        'SAP created class ZTEST: no write call cited',
      );
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
