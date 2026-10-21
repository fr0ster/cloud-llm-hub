import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildAgentForDestination,
  ExpositionFilteringRag,
  initProviders,
} from '../../srv/agent-manager';
import { makeHubLlm } from '../../srv/lib/llm-factory';
import { startProviders } from '../../srv/lib/providers';
import { getRunRecordStore } from '../../srv/lib/run-record-store';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { runWithSessionId } from '../../srv/request-session';

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(),
}));

const config: AgentConfig = {
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
  let scenario: 'hello' | 'throw' | 'invalid';
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
      return JSON.stringify({
        steps: [{ id: 'hello', kind: 'answer', text: 'Hello!' }],
      });
    }
    if (system.includes('REVIEWER')) {
      calls.push('reviewer');
      return JSON.stringify({
        possiblyFake: false,
        confidence: 'high',
        reasons: 'test',
      });
    }
    calls.push('executor');
    return answer;
  }
  const llm: ILlm = {
    model: 'test',
    chat: jest.fn(async (messages) => ({
      ok: true as const,
      value: { content: respond(messages), finishReason: 'stop' as const },
    })),
    streamChat: jest.fn(async function* (messages) {
      yield {
        ok: true as const,
        value: { content: respond(messages), finishReason: 'stop' as const },
      };
    }),
  };

  beforeAll(async () => {
    jest.mocked(makeHubLlm).mockResolvedValue(llm);
    initProviders(await startProviders(config));
  });
  beforeEach(() => {
    calls.length = 0;
    controllerPrompts.length = 0;
  });

  async function run(sessionId: string, prompt: string, userId = 'alice') {
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
      config,
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
    const lease = retention.lease(userId, sessionId, 'pipeline');
    if (isRefusal(lease)) throw new Error('unexpected refusal');
    const chunks: string[] = [];
    await runWithSessionId(
      sessionId,
      async () => {
        for await (const chunk of handle.agent.streamProcess(prompt, {
          sessionId,
          trace: { traceId: sessionId },
        })) {
          expect(chunk.ok).toBe(true);
          if (chunk.ok) chunks.push(chunk.value.content);
        }
      },
      [],
      userId,
    );
    lease.release();
    expect(retention.isKnown(userId, sessionId)).toBe(true);
    return {
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

  it('answers small talk in one controller call, with no executor tool-loop or SAP calls', async () => {
    scenario = 'hello';
    const result = await run('adaptive-hello', 'Hello');
    expect(result.text).toBe('Hello!');
    expect(calls).toEqual(['controller']);
    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.record?.outcome).toBe('answered');
    expect(result.record?.steps.map((s) => s.kind)).toEqual(['answer']);
  });

  it.each(['throw', 'invalid'] as const)(
    'falls back after %s planning and appends the honesty notice',
    async (failure) => {
      scenario = failure;
      const result = await run(
        `adaptive-${failure}`,
        'Create and activate class ZTEST',
      );
      expect(calls[0]).toBe('controller');
      expect(calls).toContain('executor');
      expect(result.text).toContain(answer);
      expect(result.text).toContain('UNVERIFIED_WRITE:');
      expect(result.callTool).not.toHaveBeenCalled();
      expect(result.record?.outcome).toBe('answered');
      expect(result.record?.steps.some((s) => s.kind === 'work')).toBe(true);
    },
  );
  it('real adaptive pipeline never passes Alice previousRun to Bob with the same session ID', async () => {
    scenario = 'hello';
    await run('shared-id', 'Alice private request', 'alice');
    await run('shared-id', 'Bob request', 'bob');
    expect(controllerPrompts.at(-1)).toContain('Previous run:\nnull');
    expect(controllerPrompts.at(-1)).not.toContain('Alice private request');
    await run('other-id', 'Alice other session', 'alice');
    expect(controllerPrompts.at(-1)).toContain('Previous run:\nnull');
    await run('shared-id', 'Alice continuation', 'alice');
    expect(controllerPrompts.at(-1)).toContain('Alice private request');
    expect(controllerPrompts.at(-1)).not.toContain('Bob request');
  });
});
