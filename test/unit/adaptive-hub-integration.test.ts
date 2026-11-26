import { bindTestCaller } from './helpers/bind-test-caller';

const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

import {
  EMBEDDING_CONTEXT_EXCEEDED,
  type ILlm,
  InMemoryRag,
  LlmError,
  McpError,
  type Message,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
  type SmartAgentError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import type { AgentConfig } from '../../srv/agent-config';
import * as agentManager from '../../srv/agent-manager';
import {
  buildAgentForDestination,
  ExpositionFilteringRag,
  getCollectionRegistry,
  getSharedHistoryRag,
  HUB_ADAPTIVE_CONTROLLER_SYSTEM,
  initProviders,
} from '../../srv/agent-manager';
import { executeStep } from '../../srv/agent-mcp';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
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
import { handleChatCompletions } from '../../srv/openai-handler';
import {
  type RagCallerIdentity,
  runWithSessionId,
} from '../../srv/request-session';
import { liveSession } from './helpers/canonical-rag';
import { fakeReq, fakeRes } from './helpers/channel-harness';
import { typedRequest, typedResponse } from './helpers/response-model';

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(),
}));
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);

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
    | 'explicit-check'
    | 'embedding-overflow'
    | 'unusable-brief'
    | 'unusable-findings'
    | 'work-checker'
    | 'revised-work-checker'
    | 'fix-after-check'
    | 'revise'
    | 'user-mcp'
    | 'user-mcp-write';
  const bridgedName = 'user__documents__lookup';
  const bridgedWrite = 'user__documents__save';
  const bridgedValue = 'Returned by the session executor';
  const revisionCount = 21;
  const calls: string[] = [];
  const controllerPrompts: string[] = [];
  const fixPrompts: string[] = [];
  let rejectedWriteId: string | undefined;
  let checkerModelFailure: LlmError | undefined;
  const answer = 'I created and activated class ZTEST.';
  function respond(messages: Message[]): string {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    if (system.includes('why the run stopped')) {
      calls.push('report');
      expect(messages.map(({ content }) => content).join('\n')).toContain(
        scenario === 'unusable-brief'
          ? 'unusable verdict: expected a JSON list of cited claims'
          : 'unusable verdict: missing or invalid findings',
      );
      return 'Verification is undecided.';
    }
    if (system.includes('sequential adaptive plan')) {
      calls.push('controller');
      controllerPrompts.push(messages.map((m) => m.content).join('\n'));
      if (scenario === 'throw') throw new Error('planning unavailable');
      if (scenario === 'invalid') return 'not JSON';
      if (scenario === 'embedding-overflow')
        return JSON.stringify({
          steps: [
            {
              id: 'first',
              kind: 'work',
              worker: 'executor',
              goal: 'Do the work',
            },
            {
              id: 'verify',
              kind: 'check',
              worker: 'self',
              goal: 'Verify the work',
              targets: [],
              onPass: 'done',
              onFail: 'fix',
            },
            {
              id: 'fix',
              kind: 'work',
              worker: 'executor',
              goal: 'Fix the work',
            },
            { id: 'done', kind: 'answer', text: 'Completed' },
          ],
        });
      if (
        scenario === 'unusable-brief' ||
        scenario === 'unusable-findings' ||
        scenario === 'work-checker' ||
        scenario === 'revised-work-checker'
      ) {
        const claims = JSON.stringify([
          {
            claim: 'The business requirements were saved.',
            system: 'rag',
            target: {
              scope: 'user',
              collection: 'book-catalog',
              record: 'business-requirements',
            },
            evidence: {},
          },
        ]);
        const stage = {
          id: 'stage',
          kind: 'work',
          worker: 'executor',
          goal: 'Stage the business requirements',
        };
        if (
          scenario === 'work-checker' ||
          scenario === 'revised-work-checker'
        ) {
          const verify = {
            id: 'verify',
            kind: 'work',
            worker: 'checker',
            goal: 'Verify the saved record',
            context: { note: claims },
          };
          const deliver = { id: 'done', kind: 'answer', from: 'stage' };
          return JSON.stringify({
            steps:
              scenario === 'work-checker'
                ? [stage, verify, deliver]
                : controllerPrompts.length === 1
                  ? [
                      stage,
                      {
                        id: 'revise',
                        kind: 'revise',
                        reason: 'Plan verification',
                      },
                      deliver,
                    ]
                  : [verify, deliver],
          });
        }
        return JSON.stringify({
          steps: [
            stage,
            {
              id: 'verify',
              kind: 'check',
              worker: 'checker',
              goal: 'Verify the saved record',
              targets: ['stage'],
              onPass: 'done',
              onFail: 'fix',
              onPartial: 'fix',
              context: {
                note:
                  scenario === 'unusable-brief'
                    ? `${claims} (Replace evidence with the callId from [actions].)`
                    : claims,
              },
            },
            {
              id: 'fix',
              kind: 'work',
              worker: 'executor',
              goal: 'Write the record again',
            },
            { id: 'done', kind: 'answer', text: 'Verified' },
          ],
        });
      }
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
      if (scenario === 'user-mcp-write')
        return JSON.stringify({
          steps:
            controllerPrompts.length === 1
              ? [
                  {
                    id: 'save',
                    kind: 'work',
                    worker: 'executor',
                    goal: 'Save the document',
                  },
                  { id: 'revise', kind: 'revise', reason: 'Read write facts' },
                ]
              : [{ id: 'answer', kind: 'answer', text: 'Saved' }],
        });
      if (scenario === 'revise') {
        const call = controllerPrompts.length;
        const step =
          call <= revisionCount
            ? { id: `revise-${call}`, kind: 'revise', reason: 'Refine plan' }
            : { id: 'answer', kind: 'answer', text: 'Plan complete' };
        return JSON.stringify({ steps: [step] });
      }
      if (scenario === 'fix-after-check')
        return JSON.stringify({
          steps: [
            {
              id: 'verify',
              kind: 'check',
              worker: 'checker',
              goal: 'verify',
              targets: [],
              onPass: 'done',
              onFail: 'fix',
              context: {
                note: JSON.stringify([
                  {
                    claim: 'Created class ZTEST.',
                    system: 'sap',
                    target: { type: 'class', name: 'ZTEST' },
                    evidence: { callId: rejectedWriteId },
                  },
                  {
                    claim: 'Created class ZOTHER.',
                    system: 'sap',
                    target: { type: 'class', name: 'ZOTHER' },
                    evidence: {},
                  },
                ]),
              },
            },
            {
              id: 'fix',
              kind: 'work',
              worker: 'executor',
              goal: 'Correct the result',
            },
            { id: 'done', kind: 'answer', from: 'fix' },
          ],
        });
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
    if (scenario === 'unusable-brief' || scenario === 'unusable-findings')
      return 'Staged the requirements in the session collection.';
    if (scenario === 'fix-after-check')
      fixPrompts.push(messages.map((message) => message.content).join('\n'));
    return answer;
  }
  const llm: ILlm = {
    model: 'test',
    chat: jest.fn(async (messages, tools): ReturnType<ILlm['chat']> => {
      if (tools?.some(({ name }) => name === 'submit_verdict')) {
        calls.push('checker');
        expect(tools.map(({ name }) => name)).toEqual(['submit_verdict']);
        if (checkerModelFailure)
          return { ok: false, error: checkerModelFailure };
        if (
          scenario === 'unusable-findings' ||
          scenario === 'work-checker' ||
          scenario === 'revised-work-checker'
        )
          return {
            ok: true as const,
            value: {
              content: 'The record looks correct.',
              finishReason: 'stop' as const,
              usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
            },
          };
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
                    ...(scenario === 'fix-after-check'
                      ? [
                          {
                            claim: 'Created class ZTEST.',
                            status: 'refuted',
                            evidence: { callId: rejectedWriteId },
                            reason: 'SAP rejected the class definition.',
                          },
                        ]
                      : []),
                    {
                      claim:
                        scenario === 'fix-after-check'
                          ? 'Created class ZOTHER.'
                          : 'Created class ZTEST.',
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
    streamChat: jest.fn(async function* (messages, tools) {
      if (scenario === 'user-mcp' || scenario === 'user-mcp-write') {
        const name = scenario === 'user-mcp-write' ? bridgedWrite : bridgedName;
        expect(tools?.some((tool) => tool.name === 'unregistered')).not.toBe(
          true,
        );
        const result = messages.find((message) => message.role === 'tool');
        if (!result && tools?.some((tool) => tool.name === name)) {
          yield {
            ok: true as const,
            value: {
              content: '',
              finishReason: 'tool_calls' as const,
              toolCalls: [
                {
                  id: 'lookup',
                  name,
                  arguments: { id: 'record-1' },
                },
              ],
            },
          };
        } else {
          if (result)
            expect(result.content).toContain(
              `[source: user-mcp:${name}; trust 4.1]`,
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
    fixPrompts.length = 0;
    checkerModelFailure = undefined;
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
      },
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
    if (scenario === 'fix-after-check') {
      callTool.mockResolvedValueOnce({
        ok: true,
        value: { isError: true, content: 'Class definition rejected' },
      });
      await handle.recMcp.callTool(
        'CreateClass',
        { class_name: 'ZTEST' },
        { trace: { traceId: sessionId } },
      );
      rejectedWriteId = handle.recMcp.getToolJournal(sessionId)[0].call.id;
    }
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
    const errors: SmartAgentError[] = [];
    await runWithSessionId(
      sessionId,
      async () => {
        for await (const chunk of handle.agent.streamProcess(prompt, {
          caller,
          sessionId,
          trace: { traceId: sessionId },
        })) {
          if (chunk.ok) {
            chunks.push(chunk.value.content);
            if (chunk.value.usage) usage.push(chunk.value.usage.totalTokens);
          } else errors.push(chunk.error);
        }
      },
      [],
      userId,
      identity,
    );
    lease.release();
    if (!checkerModelFailure) expect(errors).toEqual([]);
    if (runConfig.agent.chatCoordinator === 'adaptive')
      expect(retention.isKnown(userId, sessionId)).toBe(true);
    return {
      executor: handle.executor,
      text: chunks.join(''),
      usage,
      errors,
      callTool,
      record: await runWithSessionId(
        sessionId,
        () => getRunRecordStore().load(sessionId),
        [],
        userId,
      ),
    };
  }

  it.each([
    'OpenAI JSON',
    'OpenAI SSE',
    'Anthropic JSON',
    'Anthropic SSE',
    'agent MCP',
    'OpenAI SSE with an unanswered write',
  ])('stops at the first history embedding overflow on %s', async (channel) => {
    scenario = 'embedding-overflow';
    const userId = 'alice';
    const sessionId = `embedding-overflow-${channel.replaceAll(' ', '-').toLowerCase()}`;
    const write = channel.includes('unanswered write');
    const returnsFailure = channel === 'OpenAI JSON';
    const callTool = jest.fn(async () => ({
      ok: false as const,
      error: new McpError('Private SAP transport failure', 'MCP_NO_RESPONSE'),
    }));
    const handle = await buildAgentForDestination(
      {
        listTools: async () => ({ ok: true, value: [] }),
        callTool,
      },
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
    const agent = jest
      .spyOn(agentManager, 'getSmartAgent')
      .mockResolvedValue(handle);
    const ready = jest
      .spyOn(agentManager, 'isAgentReady')
      .mockReturnValue(true);
    const buildWorker = jest.spyOn(SmartAgentBuilder.prototype, 'build');
    const privateText = 'Private text from the embedding provider';
    const overflow = Object.assign(
      new RagError(privateText, EMBEDDING_CONTEXT_EXCEEDED),
      channel === 'agent MCP' ? { stepId: 'first', status: 413 } : {},
    );
    const history = getSharedHistoryRag();
    const query = history.query.bind(history);
    const failWorkerQuery = jest.fn(
      async (...args: Parameters<typeof query>) => {
        if (write) await handle.recMcp.callTool('CreateClass', {}, args[2]);
        if (returnsFailure) return { ok: false as const, error: overflow };
        throw overflow;
      },
    );
    const historyQuery = jest
      .spyOn(history, 'query')
      .mockImplementation((...args) =>
        buildWorker.mock.calls.length
          ? failWorkerQuery(...args)
          : query(...args),
      );
    const log = jest
      .spyOn(cds.log('smart-pipeline'), 'error')
      .mockImplementation(() => {});
    const context = new cds.EventContext({ event: 'test' });
    context.user = new cds.User({
      id: userId,
      attr: {},
      roles: ['MCP_Developer'],
    });
    const priorContext = cds.context;
    cds.context = context;
    try {
      const anthropic = channel.startsWith('Anthropic');
      const stream = channel.includes('SSE');
      const req = typedRequest(
        fakeReq(
          {
            model: 'test',
            messages: [{ role: 'user', content: 'Do the work' }],
            stream,
            ...(anthropic && { max_tokens: 100 }),
          },
          sessionId,
        ),
      );
      const message = 'Вхідні дані перевищують контекст моделі ембедингів';
      const error = {
        code: EMBEDDING_CONTEXT_EXCEEDED,
        message: write
          ? `${message}. Результат запису невідомий. Перевір стан у SAP перед повтором.`
          : message,
      };
      if (channel === 'agent MCP') {
        liveSession(userId, sessionId);
        const result = await executeStep(
          req,
          { userId, exposition: [] },
          {
            session: sessionId,
            destination: 'DEST',
            task: 'Do the work',
          },
        );
        expect(result).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: error.message }],
          structuredContent: { error: { ...error, status: 400 } },
        });
        expect(JSON.stringify(result)).not.toContain(privateText);
        expect(calls).toEqual([]);
      } else {
        const res = fakeRes();
        const handler = anthropic
          ? handleAnthropicMessages
          : handleChatCompletions;
        await handler(req, typedResponse(res));
        expect(res.writableEnded).toBe(true);
        expect({ status: res.statusCode, body: res.body }).toMatchObject({
          status: stream ? 200 : 400,
        });
        if (stream) {
          const errors = res.body
            .split('\n\n')
            .filter((event) => event.startsWith('event: error\n'));
          expect(errors).toHaveLength(1);
          expect(
            JSON.parse(errors[0].slice('event: error\ndata: '.length)),
          ).toMatchObject({ error });
          expect(res.body).not.toMatch(/\[DONE\]|event: message_stop/);
        } else expect(JSON.parse(res.body)).toMatchObject({ error });
        expect(res.body).not.toContain(privateText);
        expect(calls).toEqual(['controller']);
        expect(log).toHaveBeenCalledWith('adaptive_run_stopped', {
          traceId: expect.stringMatching(/./),
          code: EMBEDDING_CONTEXT_EXCEEDED,
          stepId: 'first',
        });
      }
      expect(buildWorker).toHaveBeenCalledTimes(1);
      expect(failWorkerQuery).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(write ? 1 : 0);
      if (!returnsFailure)
        expect(log.mock.calls).toContainEqual([
          'stage_error_rag-history',
          {
            traceId: expect.stringMatching(/./),
            code: EMBEDDING_CONTEXT_EXCEEDED,
            stepId: 'first',
            ...(channel === 'agent MCP' && { status: 413 }),
          },
        ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
    } finally {
      cds.context = priorContext;
      log.mockRestore();
      historyQuery.mockRestore();
      buildWorker.mockRestore();
      ready.mockRestore();
      agent.mockRestore();
    }
  });

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
            writes: true,
            tools: [
              {
                name: 'lookup',
                description: 'Look up a document',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
              {
                name: 'save',
                description: 'Save a document',
                inputSchema: { type: 'object' },
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

      scenario = 'user-mcp-write';
      controllerPrompts.length = 0;
      const write = await run(
        session.key,
        'Save a document',
        session.userId,
        undefined,
        bridgeConfig,
        { channel: 'openai', admin: false, userMcpSession: session },
      );
      expect(write.text).toBe('Saved');
      expect(controllerPrompts).toHaveLength(2);
      expect(controllerPrompts[1]).toContain('[actions] Tool writes');
      expect(controllerPrompts[1]).toContain(
        '"system":"user-mcp","operation":"user__documents__save","targets":[],"outcome":"unconfirmed"',
      );
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close(session.userId, session.key, 'explicit');
    }
  });

  it('answers directly with zero checker calls and zero checker token usage', async () => {
    scenario = 'hello';
    const result = await run('adaptive-hello', 'Hello');
    expect(result.text).toBe('Hello!');
    expect(calls).toEqual(['controller']);
    expect(result.usage.reduce((total, tokens) => total + tokens, 0)).toBe(0);
    expect(controllerPrompts[0]).toContain(HUB_ADAPTIVE_CONTROLLER_SYSTEM);
    expect(controllerPrompts[0]).toContain(
      'Assign a check step only to "self" or the checker profile, and never use the worker of any target step.',
    );
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

  it.each([
    ['unusable-brief', 'expected a JSON list of cited claims', 0],
    ['unusable-findings', 'missing or invalid findings', 10],
  ] as const)(
    'reports %s as undecided without aborting the stream or running the fix step',
    async (mode, reason, tokens) => {
      scenario = mode;
      const result = await run(`adaptive-${mode}`, 'Verify the saved record');
      expect(calls).toEqual([
        'controller',
        'executor',
        ...(tokens ? ['checker'] : []),
        'report',
      ]);
      expect(result.text).toBe('Verification is undecided.');
      expect(result.usage.reduce((total, tokens) => total + tokens, 0)).toBe(
        tokens,
      );
      expect(result.record?.steps).toMatchObject([
        { stepId: 'stage', status: 'done' },
        {
          stepId: 'verify',
          verdict: {
            verdict: 'partial',
            reason: `unusable verdict: ${reason}`,
          },
        },
      ]);
      expect(result.callTool).not.toHaveBeenCalled();
    },
  );

  it.each<['unusable-findings' | 'work-checker', string, string]>([
    ['unusable-findings', 'CREDENTIALS_REJECTED', 'CREDENTIALS_REJECTED'],
    ['unusable-findings', 'ABORTED', 'ABORTED'],
    ['unusable-findings', 'CONFIG_ERROR', 'CONFIG_ERROR'],
    ['unusable-findings', 'LLM_HTTP_ERROR', 'LLM_HTTP_ERROR'],
    ['unusable-findings', 'LLM_ERROR', 'VERDICT_RETRIEVAL_FAILED'],
    ['unusable-findings', MODEL_CONTEXT_EXCEEDED, MODEL_CONTEXT_EXCEEDED],
    ['work-checker', 'CREDENTIALS_REJECTED', 'CREDENTIALS_REJECTED'],
  ])(
    'keeps a checker model failure terminal in %s (%s)',
    async (mode, code, expectedCode) => {
      scenario = mode;
      checkerModelFailure = new LlmError('Private provider message', code);
      const result = await run(
        `adaptive-${mode}-${code}`,
        'Verify the saved record',
      );
      expect(result.errors).toEqual([
        expect.objectContaining({ code: expectedCode }),
      ]);
      expect(calls).toEqual(['controller', 'executor', 'checker']);
      expect(result.text).toBe('');
      expect(result.record?.outcome).toBe('stopped');
      expect(result.record?.steps).toMatchObject([
        { stepId: 'stage', status: 'done' },
        { stepId: 'verify', status: 'failed' },
      ]);
      expect(result.record?.steps[1].verdict).toBeUndefined();
      expect(result.errors[0].message).not.toContain(
        'Private provider message',
      );
    },
  );

  it.each(['work-checker', 'revised-work-checker'] as const)(
    'reports an unusable verdict in %s without delivering the executor answer',
    async (mode) => {
      scenario = mode;
      const revised = mode === 'revised-work-checker';
      const result = await run(`adaptive-${mode}`, 'Verify the saved record');
      expect(calls).toEqual([
        'controller',
        'executor',
        ...(revised ? ['controller'] : []),
        'checker',
        'report',
      ]);
      expect(result.text).toBe('Verification is undecided.');
      expect(result.record?.outcome).toBe('stopped');
      expect(result.record?.steps).toMatchObject([
        { stepId: 'stage', status: 'done', output: answer },
        ...(revised ? [{ stepId: 'revise', status: 'done' }] : []),
        {
          stepId: 'verify',
          status: 'done',
          verdict: {
            verdict: 'partial',
            reason: 'unusable verdict: missing or invalid findings',
          },
        },
      ]);
    },
  );

  it('passes refuted and unsupported findings to the adaptive fix worker', async () => {
    scenario = 'fix-after-check';
    const result = await run(
      'adaptive-fix-after-check',
      'Verify and correct the write',
    );
    expect(calls).toEqual(['controller', 'checker', 'executor']);
    expect(result.record?.steps[0].verdict?.reason).toContain(
      'SAP rejected the class definition.',
    );
    expect(fixPrompts.join('\n')).toContain(
      `Previous check verify said:\n"Created class ZTEST." refuted (${rejectedWriteId}). SAP rejected the class definition.\n"Created class ZOTHER." unsupported (citation missing). The write citation is missing a journal call id`,
    );
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
