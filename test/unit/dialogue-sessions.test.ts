import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type {
  CallOptions,
  DialoguePlan,
  RagCaller,
} from '@mcp-abap-adt/llm-agent';
import {
  InMemoryRag,
  InMemoryRagProvider,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { unwrapBuilderResult } from '@mcp-abap-adt/llm-agent-libs';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import cds from '@sap/cds';
import express from 'express';
import { executeRagTool } from '../../srv/agent-mcp-rag';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { chatStream, streamDialogue } from '../../srv/lib/chat-stream';
import {
  runWithVerdictTools,
  verdictToolsEnabled,
} from '../../srv/lib/checker-verdict-tool';
import { consumerHistoryRag } from '../../srv/lib/client-history';
import { dialogueChat } from '../../srv/lib/dialogue-chat';
import { handleDialogueEvents } from '../../srv/lib/dialogue-events-handler';
import { followDialogue } from '../../srv/lib/dialogue-follow';
import {
  clientTurnId,
  clientTurnMessages,
  turnSource,
} from '../../srv/lib/dialogue-turn-source';
import {
  captureTokenUsage,
  reliableLlm,
  reportLlmSpend,
} from '../../srv/lib/llm-failure';
import { parseModelAllowlist } from '../../srv/lib/model-policy';
import * as plannerMemory from '../../srv/lib/planner-memory';
import { getHubRagAccess } from '../../srv/lib/rag-access';
import { bindCaller, callOptionsFor } from '../../srv/lib/rag-caller';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  chatResponseModel,
  currentRoleModel,
  RoleModelNotAllowedError,
  roleOfProfile,
} from '../../srv/lib/role-models-scope';
import { systemToolTrust } from '../../srv/lib/system-tool-trust';
import type { TrustResolver } from '../../srv/lib/trust-resolver';
import { sumPlannerUsage } from '../../srv/lib/usage-wire';
import {
  UserMcpBridge,
  type UserMcpCall,
  userMcpRegistration,
} from '../../srv/lib/user-mcp-bridge';
import { userMcpClient } from '../../srv/lib/user-mcp-tools';
import { reportWorkerActivity } from '../../srv/lib/worker-activity';
import { handleChatCompletions } from '../../srv/openai-handler';
import { CollectionRegistry } from '../../srv/rag-collections';
import { fixtureTrustResolver } from './helpers/agent-profiles';
import { liveSession } from './helpers/canonical-rag';
import { deferred, fakeReq, fakeRes } from './helpers/channel-harness';
import { typedRequest, typedResponse } from './helpers/response-model';
import { testAccess } from './helpers/test-rag-access';

jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: jest.fn(async () => ({
    authenticationType: 'BasicAuthentication',
  })),
}));

import {
  LongSessionRegistry,
  longSessions,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';

jest.mock('../../srv/lib/background-connection', () => ({
  ...jest.requireActual('../../srv/lib/background-connection'),
  buildConnectionForDestination: jest.fn(),
  dumpScopeForConnection: jest.fn(),
}));

import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import { getRequestContext } from '@mcp-abap-adt/lib/request-context';
import type {
  ILlm,
  ISubAgentInput,
  ISubAgentResult,
  TokenUsage,
  ToolTrace,
} from '@mcp-abap-adt/llm-agent';
import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  PlannerToolsClient,
  SemaphorePool,
  SmartAgentBuilder,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import { runWithRequestConnection } from '../../srv/agent-manager';
import {
  currentAdmission,
  runWithAdmission,
} from '../../srv/lib/admission-scope';
import {
  closeDialogue,
  type DialogueEvent,
  dialogueFor,
  dialoguePlan,
  headlessDialogueFor,
  lookupDialogue,
  onDialogueCreated,
  sharedExecutorPool,
} from '../../srv/lib/dialogue-sessions';
import { turnOwner } from '../../srv/lib/history-turn';
import { scopedPlannerMemory } from '../../srv/lib/planner-memory-scope';
import { SessionHistoryRouter } from '../../srv/lib/session-history-collection';
import { longSessionLlms, sessionLlms } from '../../srv/lib/session-llms';

function requiredExecutorPool() {
  const pool = sharedExecutorPool();
  if (!pool) throw new Error('Expected configured executor pool');
  return pool;
}

import { dialogueSignals } from '../../srv/lib/dialogue-signals';
import {
  DIALOGUE_TOOL_CONTRACT_VERSION,
  getDialogueStoreBackend,
  type HubDialogueState,
  hasDialogueState,
} from '../../srv/lib/dialogue-store';
import {
  type JournalEntry,
  writeActionMessages,
} from '../../srv/lib/tool-journal';
import {
  captureToolScope,
  getRagCallerIdentity,
  getRequestHistory,
  getRequestSessionId,
  getRequestUserId,
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithRequiredProfileTools,
  runWithSessionId,
  runWithToolScope,
} from '../../srv/request-session';

const ragCaller = { sessionId: 'key', userId: 'alice', isAdmin: false };
const isolationCallers = ['isolation-A', 'isolation-B', 'isolation-C'].map(
  (sessionId) => ({ sessionId, userId: 'alice', isAdmin: false }),
);

let mockTaskResultRegistry = new CollectionRegistry();
const mockPlannerCallers: (RagCaller | undefined)[] = [];
const mockJournal = new Map<string, JournalEntry[]>();
const mockActionMessages: string[] = [];
const mockRun = jest.fn<Promise<ISubAgentResult>, [ISubAgentInput]>();
const mockRelease = jest.fn();
const mockDrain = jest.fn(async () => {});
const mockDrop = jest.fn();
const mockPlannerTurns: string[] = [];
const mockAuthorTurns: string[] = [];
const mockAuthorOptions: (CallOptions | undefined)[] = [];
const mockEnvironments: string[] = [];
let mockWorkerModel: string | undefined;
let mockGoal = 'read';
let mockWorkerTrust: { target: number } | undefined;
let mockPlannerHook: ((text: string) => Promise<void | LlmError>) | undefined;
let mockPlannerPreparationHook: (() => void) | undefined;
let mockWorkerPreparationHook: (() => Promise<void>) | undefined;
let mockCaptureLlm: (() => Promise<ILlm>) | undefined;
let mockIsolationHistory: SessionHistoryRouter | undefined;
let mockClientHistory: 'off' | 'on' = 'off';
let mockChatCoordinator: 'dialogue' | undefined;
let mockFinalAnswer: string | undefined;
let mockBackgroundAnswer: string | undefined;
let mockPlanUsage: TokenUsage | undefined;
let mockPlan:
  | {
      plan?: string;
      steps?: Array<{
        id: string;
        goal: string;
        state?: 'pending' | 'running' | 'done' | 'skipped';
        dependsOn?: string[];
        note?: string;
      }>;
      question?: string;
      status?: 'active' | 'waiting_user' | 'done';
    }
  | undefined;
let mockExecutorPool: number | undefined = 1;
let mockLongTaskMs: number | undefined;
const mockRegister = { track: <T>(p: Promise<T>) => p };
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual('../../srv/agent-config'),
  getAgentConfig: () => ({
    ...jest.requireActual('../../srv/agent-config').getAgentConfig(),
    agent: {
      chatCoordinator: mockChatCoordinator,
      clientHistory: mockClientHistory,
      dialogue: {
        executors: 2,
        executorPool: mockExecutorPool,
        maxTasks: 50,
        maxCorrections: 2,
        longTaskMs: mockLongTaskMs,
        waitTickMs: mockLongTaskMs ? 0 : undefined,
      },
    },
  }),
}));
jest.mock('../../srv/agent-manager', () => ({
  ...jest
    .requireActual<typeof import('./helpers/channel-harness')>(
      './helpers/channel-harness',
    )
    .agentManagerMock(),
  getCollectionRegistry: () => mockTaskResultRegistry,
  getSharedHistoryRag: () => mockIsolationHistory,
  docsMcp: () => ({
    describeWorkers: (
      workers: import('@mcp-abap-adt/llm-agent').WorkerProfileSummary[],
    ) => workers,
  }),
  getSystemToolTrust: () => () => undefined,
  isEmbeddedSystemTool: () => false,
  getTrustResolver: () =>
    jest
      .requireActual<typeof import('./helpers/agent-profiles')>(
        './helpers/agent-profiles',
      )
      .fixtureTrustResolver(),
  getProviders: () => ({ embedding: undefined }),
  forgetPlannerMemory: jest.fn(async () => true),
  releasePlannerAgent: jest.fn(),
  setSessionDestination: jest.fn(),
  createAgentProfileSource: () => ({
    list: async () => ({
      ok: true,
      value: [
        { name: 'executor', description: '', result: 'report' },
        { name: 'checker', description: '', result: 'verdict' },
      ],
    }),
    get: async (name: string) => ({
      ok: true,
      value: {
        name,
        description: '',
        systemPrompt: '',
        trust: mockWorkerTrust,
        tools: 'all',
        result: name === 'checker' ? 'verdict' : 'report',
      },
    }),
    getPrompts: async () => ({
      ok: true,
      value: { workerBase: '', planner: '' },
    }),
  }),
  buildPlannerAgent: jest.fn(async () => {
    mockPlannerPreparationHook?.();
    if (mockCaptureLlm) {
      const builder = new SmartAgentBuilder({
        skipModelValidation: true,
        agent: { classificationEnabled: false, ragTranslateEnabled: false },
      })
        .withRagAccess(testAccess([ragCaller, ...isolationCallers]))
        .withMainLlm(await mockCaptureLlm())
        .withMode('hard')
        .withClassification(false);
      if (mockIsolationHistory)
        builder.setHistoryRag(
          mockClientHistory === 'on'
            ? consumerHistoryRag
            : mockIsolationHistory,
        );
      return unwrapBuilderResult(await builder.build()).agent;
    }
    return {
      process: async (
        messages: { content: string }[],
        options?: CallOptions,
      ) => {
        mockPlannerCallers.push(options?.caller);
        for (const message of writeActionMessages([]))
          if (message.content) mockActionMessages.push(message.content);
        mockEnvironments.push(
          messages.find((m) => m.content.startsWith('[environment]'))
            ?.content ?? '',
        );
        const input = messages.at(-1)?.content ?? '';
        const text = input.includes('[task events]')
          ? input.slice(input.indexOf('[task events]'))
          : input;
        mockPlannerTurns.push(text);
        const error = await mockPlannerHook?.(text);
        if (error) return { ok: false, error };
        if (mockPlan) {
          await new PlannerToolsClient().callTool('plan_update', mockPlan);
          return {
            ok: true,
            value: { content: 'Plan updated', usage: mockPlanUsage },
          };
        }
        if (!text.startsWith('[task events]'))
          await new PlannerToolsClient().callTool('delegate_task', {
            worker: 'executor',
            goal: mockGoal,
          });
        if (mockFinalAnswer && !text.startsWith('[task events]'))
          await until(() => mockRun.mock.calls.length > 0);
        return {
          ok: true,
          value: {
            content: text.startsWith('[task events]')
              ? (mockBackgroundAnswer ?? text)
              : (mockFinalAnswer ?? 'delegated'),
            usage: {
              promptTokens: 3,
              completionTokens: 2,
              totalTokens: 5,
              models: {
                m: {
                  promptTokens: 3,
                  completionTokens: 2,
                  totalTokens: 5,
                  requests: 1,
                },
              },
            },
          },
        };
      },
    };
  }),
  getSmartAgent: jest.fn(async () => ({
    toolTrust: systemToolTrust(() => true, fixtureTrustResolver()),
    toolTrustFor: (resolver: TrustResolver) =>
      systemToolTrust(() => true, resolver),
    profileRunner: {
      validateModel: () => ({ ok: true, value: undefined }),
      preparePlanAuthor: async () => ({
        ok: true,
        value: {
          process: async (input: string, options?: CallOptions) => {
            mockAuthorTurns.push(input);
            mockAuthorOptions.push(options);
            if (mockCaptureLlm)
              await (await mockCaptureLlm()).chat([
                { role: 'user', content: input },
              ]);
            return {
              ok: true,
              value: {
                content: '{"steps":[],"status":"done"}',
                iterations: 1,
                toolCallCount: 0,
                stopReason: 'stop',
              },
            };
          },
          streamProcess: async function* () {},
        },
      }),
      createWorker: async ({
        profile,
        model,
      }: {
        model?: string;
        profile: import('@mcp-abap-adt/llm-agent').WorkerProfile;
      }) => {
        if (mockWorkerPreparationHook) await mockWorkerPreparationHook();
        try {
          model = currentRoleModel(roleOfProfile(profile)) ?? model;
        } catch (error) {
          if (error instanceof RoleModelNotAllowedError)
            return {
              ok: false,
              error: { code: 'MODEL_NOT_ALLOWED', message: error.message },
            };
          throw error;
        }
        mockWorkerModel = model ?? profile.model;
        if (model !== undefined && !parseModelAllowlist().has(model))
          return {
            ok: false,
            error: { code: 'MODEL_NOT_ALLOWED', message: 'MODEL_NOT_ALLOWED' },
          };
        return {
          ok: true,
          value: {
            name: profile.name,
            capabilities: { contextPolicy: 'optional' },
            run: (input: ISubAgentInput) => mockRun(input),
          },
        };
      },
      preparePlanner: async () => ({
        ok: true,
        value: await jest
          .requireMock<typeof import('../../srv/agent-manager')>(
            '../../srv/agent-manager',
          )
          .buildPlannerAgent(
            (await import('../../srv/agent-config')).getAgentConfig(),
            '',
          ),
      }),
    },
    workers: new Map([
      [
        'executor',
        {
          name: 'executor',
          capabilities: { contextPolicy: 'optional' },
          run: (i: ISubAgentInput) => mockRun(i),
        },
      ],
    ]),
    recMcp: {
      getToolJournal: (id?: string) => (id && mockJournal.get(id)) || [],
      dropRequest: (id: string) => {
        mockJournal.delete(id);
        mockDrop(id);
      },
    },
    criticLlm: {},
  })),
  runWithRequestConnection: jest.fn((_c: unknown, fn: () => unknown) => fn()),
}));
jest.mock('../../srv/lib/gatekeeper', () => ({
  ...jest.requireActual<typeof import('../../srv/lib/gatekeeper')>(
    '../../srv/lib/gatekeeper',
  ),
  leaseSession: () => ({ release() {} }),
  admitBackground: jest.fn(async () => ({
    admitted: {
      run: (fn: () => unknown) => runWithAdmission(mockRegister, fn),
      drain: () => mockDrain(),
      release: () => mockRelease(),
    },
  })),
}));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}
async function ready(user = 'alice', caller?: RagCaller) {
  const h = await dialogueFor(
    user,
    user === 'bob' ? 'bob-key' : 'key',
    'TEST',
    undefined,
    caller,
  );
  const connection = {
    close: jest.fn(),
    reset: jest.fn(),
  } as unknown as IAbapConnection & { close: jest.Mock };
  await h.factory.refresh(
    {
      headers: { authorization: 'Bearer test' },
      user: { is: (role) => role === 'MCP_Reader' },
    },
    'TEST',
  );
  jest.spyOn(h.factory, 'open').mockResolvedValue({
    connection,
    dumpScope: undefined,
    system: { responsible: 'OWNER', masterSystem: 'DEV' },
  });
  return { h, connection };
}
beforeEach(() => {
  mockTaskResultRegistry = new CollectionRegistry();
  jest.clearAllMocks();
  mockPlannerTurns.length = 0;
  mockPlannerCallers.length = 0;
  mockEnvironments.length = 0;
  mockGoal = 'read';
  mockPlannerHook = undefined;
  mockPlannerPreparationHook = undefined;
  mockWorkerPreparationHook = undefined;
  mockCaptureLlm = undefined;
  mockIsolationHistory = undefined;
  mockClientHistory = 'off';
  mockChatCoordinator = undefined;
  mockFinalAnswer = undefined;
  mockBackgroundAnswer = undefined;
  mockJournal.clear();
  mockActionMessages.length = 0;
  mockPlanUsage = undefined;
  mockPlan = undefined;
  mockRun.mockReset().mockResolvedValue({ output: 'read done' });
});
afterEach(async () => {
  await closeDialogue('alice', 'key', 'ttl');
  await closeDialogue('bob', 'bob-key', 'ttl');
  setLongSessionsForTest(undefined);
});

test.each([false, true])(
  'settled is emitted after the outbox write of the turn (save fails: %s)',
  async (saveFails) => {
    let finish!: () => void;
    mockRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ output: 'done' });
        }),
    );
    const { h } = await ready();
    await h.session.send('go');
    await until(() => !!finish);
    await h.outbox.flushed();
    mockPlan = {
      plan: 'Read records',
      status: 'waiting_user',
      question: 'Proceed?',
    };
    const events: DialogueEvent[] = [];
    h.subscribe((event) => events.push(event));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = getDialogueStoreBackend();
    const save = backend.save.bind(backend);
    const spy = jest
      .spyOn(backend, 'save')
      .mockImplementation(async (...args) => {
        await blocked;
        if (saveFails) throw new Error('store unavailable');
        await save(...args);
      });
    finish();
    try {
      await until(() => events.some((event) => event.kind === 'plan'));
      expect(events.some((event) => event.kind === 'settled')).toBe(false);
      release();
      await until(() => events.some((event) => event.kind === 'settled'));
      expect(
        events
          .filter((event) => event.kind !== 'task')
          .map((event) => event.kind),
      ).toEqual(['turn', 'plan', 'message', 'settled']);
      const message = events.find((event) => event.kind === 'message');
      expect(message).toBeDefined();
      if (message?.kind === 'message')
        expect(h.outbox.pending()).toContainEqual(message.message);
    } finally {
      release();
      await h.outbox.flushed();
      spy.mockRestore();
    }
  },
);

test('live subscribers receive summed planner usage on the first user reply emission', async () => {
  const { h } = await ready();
  mockPlanUsage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
  let calls = 0;
  mockPlannerHook = async () => {
    calls++;
    mockPlan =
      calls === 1
        ? { steps: [{ id: 'read', goal: 'Read records' }], status: 'active' }
        : {
            steps: [{ id: 'read', goal: 'Read records' }],
            status: 'waiting_user',
            question: 'Proceed?',
          };
  };
  const events: DialogueEvent[] = [];
  const unsubscribe = h.subscribe((event) => events.push(event));
  try {
    for (const [id, expectedCalls, expectedUsage] of [
      [
        'corrected-reply',
        2,
        { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
      ],
      ['next-reply', 3, mockPlanUsage],
    ] as const) {
      const trace = { traceId: id };
      h.replies.set(trace, { id, createdAt: 123 });
      try {
        await h.session.send('go', { trace });
        await h.outbox.flushed();
      } finally {
        h.replies.delete(trace);
      }
      expect(calls).toBe(expectedCalls);
      const messages = events.filter(
        (event) => event.kind === 'message' && event.message.id === id,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        kind: 'message',
        message: {
          id,
          createdAt: 123,
          text: 'Plan updated',
          trigger: 'user',
          usage: { planner: expectedUsage },
        },
      });
    }
  } finally {
    unsubscribe();
  }
});

test('turn usage includes retrieval before planning once in the reply and outbox', async () => {
  const setup = jest
    .spyOn(plannerMemory, 'plannerSessionOptions')
    .mockResolvedValue({
      plannerKnowledge: [
        {
          name: 'planning',
          async search() {
            reportLlmSpend(
              { promptTokens: 17, completionTokens: 0, totalTokens: 17 },
              'retrieval-model',
            );
            return [];
          },
        },
      ],
    });
  try {
    const { h } = await ready();
    mockPlanUsage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
    mockPlannerHook = async () => {
      mockPlan = { plan: 'Read', status: 'done' };
    };
    const trace = { traceId: 'retrieval-reply' };
    h.replies.set(trace, { id: trace.traceId, createdAt: 123 });
    const answer = await h.session.send('Find details', { trace });
    const expected = {
      totalTokens: 22,
      models: {
        'retrieval-model': {
          promptTokens: 17,
          completionTokens: 0,
          totalTokens: 17,
          requests: 1,
        },
      },
    };
    expect(answer.usage?.planner).toMatchObject(expected);
    expect(h.outbox.history()[0].usage?.planner).toMatchObject(expected);

    mockPlannerPreparationHook = () => {
      throw new Error('Planner preparation failed');
    };
    await expect(h.session.send('Find more details')).rejects.toThrow();
    expect(h.failedUsage?.()?.planner).toEqual({
      promptTokens: 17,
      completionTokens: 0,
      totalTokens: 17,
      models: expected.models,
    });
  } finally {
    setup.mockRestore();
  }
});

test('a save during the turn emits no settled', async () => {
  const { h } = await ready();
  mockPlan = { plan: 'Read', status: 'done' };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockPlannerHook = () => blocked;
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  const turn = h.session.send('plan');
  try {
    await until(() => mockPlannerTurns.length > 0);
    h.session.takePending();
    await h.drainPending();
    await h.outbox.flushed();
    expect(events).toEqual([{ kind: 'turn', source: 'mcp', text: 'plan' }]);
  } finally {
    release();
    await turn;
  }
});

test('state counts every session settlement and retains the latest failure sequence', async () => {
  const { h } = await ready();
  const bus = dialogueSignals();
  expect(h.state()).toMatchObject({ settledSeq: 0, lastFailedSeq: 0 });
  for (const [source, outcome, settledSeq, lastFailedSeq] of [
    [JSON.stringify(['alice', 'key']), 'failed', 1, 1],
    ['other', 'failed', 1, 1],
    [JSON.stringify(['alice', 'key']), 'ok', 2, 1],
    [JSON.stringify(['alice', 'key']), 'failed', 3, 3],
    [JSON.stringify(['alice', 'key']), 'ok', 4, 3],
  ] as const) {
    bus.emit('dialogue.turn.settled', { outcome, trigger: 'event' }, source);
    expect(h.state()).toMatchObject({ settledSeq, lastFailedSeq });
  }
});

test('idle is false between a task end and its event turn and while ready steps remain', async () => {
  const { h } = await ready();
  const bus = dialogueSignals();
  expect(h.state()).toMatchObject({
    status: undefined,
    total: 0,
    done: 0,
    idle: false,
  });
  bus.emit(
    'dialogue.plan.changed',
    { status: 'active', total: 3, done: 1 },
    JSON.stringify(['alice', 'key']),
  );
  const activity = { turnActive: false, queuedInputs: 1, running: 0, ready: 0 };
  bus.emit('dialogue.activity', activity, JSON.stringify(['alice', 'key']));
  expect(h.state().idle).toBe(false);
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, ready: 1 },
    JSON.stringify(['alice', 'key']),
  );
  expect(h.state().idle).toBe(false);
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, turnActive: true },
    JSON.stringify(['alice', 'key']),
  );
  expect(h.state()).toMatchObject({ turnActive: true, idle: false });
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, running: 1 },
    JSON.stringify(['alice', 'key']),
  );
  expect(h.state()).toMatchObject({ running: 1, idle: false });
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0 },
    JSON.stringify(['alice', 'key']),
  );
  expect(h.state()).toEqual({
    settledSeq: 0,
    lastFailedSeq: 0,
    turnActive: false,
    queuedInputs: 0,
    running: 0,
    total: 3,
    done: 1,
    status: 'active',
    idle: true,
  });
});

test.each(['waiting_user', 'done'] as const)(
  '%s is reported',
  async (status) => {
    const { h } = await ready();
    mockPlan = {
      plan: 'Read',
      status,
      ...(status === 'waiting_user' ? { question: 'Proceed?' } : {}),
    };
    await h.session.send('plan');
    expect(h.state()).toMatchObject({ status, idle: false });
  },
);
test('isolates owners and shares concurrent opens', async () => {
  const [a, b, c] = await Promise.all([
    dialogueFor('alice', 'key', 'TEST'),
    dialogueFor('alice', 'key', 'TEST'),
    dialogueFor('bob', 'bob-key', 'TEST'),
  ]);
  expect(a).toBe(b);
  expect(c).not.toBe(a);
  expect(a.factory).not.toBe(c.factory);
  expect(a.pool).not.toBe(c.pool);
});
test('missing credentials become a task outcome and wake the planner', async () => {
  const h = await dialogueFor('alice', 'key', 'TEST');
  await h.session.send('go');
  await until(() => h.outbox.pending().length > 0);
  expect(h.session.snapshot().tasks[0].error).toContain(
    "no SAP credentials yet; they arrive with the user's next message",
  );
  expect(h.outbox.pending()[0].text).toContain('no SAP credentials yet');
  expect(mockRun).not.toHaveBeenCalled();
  expect(mockDrop).toHaveBeenCalledTimes(1);
  expect(mockEnvironments.length).toBeGreaterThanOrEqual(2);
  for (const environment of mockEnvironments) {
    expect(environment).toContain('Destination: TEST');
    expect(environment).toContain('Concurrency limit: 2');
    expect(environment).not.toContain('Available workers:');
    expect(environment).not.toMatch(/Bearer|password|secret/);
  }
  expect(JSON.stringify(h.session.snapshot())).not.toContain('[environment]');
});
test('delegated worker has system, session, owner, an empty history scope, admission, connection and a unique trace; all holds release', async () => {
  const { h, connection } = await runWithSessionId(
    'key',
    () => ready(),
    [],
    'alice',
    { admin: true, channel: 'anthropic' },
  );
  mockRun.mockImplementation(async (input) => {
    expect(getRequestSessionId()).toBe('key');
    expect(getRequestUserId()).toBe('bob');
    expect(getRagCallerIdentity()).toEqual({
      admin: false,
      channel: 'openai',
    });
    expect(getRequestContext()?.responsible).toBe('OWNER');
    expect(getRequestHistory()).toEqual([]);
    expect(input).not.toHaveProperty('history');
    expect(currentAdmission()).toBe(mockRegister);
    expect(mockRelease).toHaveBeenCalledTimes(mockRun.mock.calls.length - 1);
    expect(input.trace?.traceId).toBeTruthy();
    return { output: 'read done' };
  });
  await runWithSessionId('other-key', () => h.session.send('go'), [], 'bob', {
    admin: false,
    channel: 'openai',
  });
  await until(() => h.outbox.pending().length > 0);
  expect(runWithRequestConnection).toHaveBeenCalledWith(
    connection,
    expect.any(Function),
    undefined,
    ['readonly', 'search', 'system'],
  );
  expect(mockDrain).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockDrop).toHaveBeenCalledWith(
    mockRun.mock.calls[0][0].trace?.traceId,
  );
  await runWithSessionId('key', () => h.session.send('again'), [], 'bob', {
    admin: false,
    channel: 'openai',
  });
  await until(() => mockDrop.mock.calls.length === 2);
  expect(mockDrop.mock.calls[0][0]).not.toBe(mockDrop.mock.calls[1][0]);
  const release = await requiredExecutorPool().acquire();
  release();
  const lease = await h.pool.acquire();
  expect(lease.connection).toBe(connection);
  await lease.release(true);
});
test('dialogue gives the coordinator failed write facts and leaves both answers unchanged', async () => {
  const answer = 'I created domain ZREQ.';
  mockBackgroundAnswer = answer;
  mockRun.mockImplementation(async (input) => {
    const traceId = input.trace?.traceId;
    if (!traceId) throw new Error('Expected worker trace');
    mockJournal.set(traceId, [
      {
        call: {
          id: 'failed-write',
          name: 'CreateDomain',
          arguments: { domain_name: 'ZREQ' },
        },
        result: { content: { success: false, error: 'Domain already exists' } },
        system: 'sap',
        write: true,
        answered: true,
      },
    ]);
    return { output: answer };
  });
  const { h } = await ready();
  await h.session.send('Create domain ZREQ');
  await until(() =>
    mockActionMessages.some((message) => message.includes('failed-write')),
  );
  expect(mockActionMessages.join('\n')).toContain(
    '{"callId":"failed-write","system":"sap","operation":"CreateDomain","targets":[{"type":"domain","name":"ZREQ"}],"outcome":"failed"}',
  );
  expect(h.session.snapshot().tasks[0].output).toBe(answer);
  await until(() =>
    h.outbox.pending().some((message) => message.text === answer),
  );
  expect(
    h.outbox
      .pending()
      .map((message) => message.text)
      .join(' '),
  ).not.toContain('UNVERIFIED_WRITE');
  const saved = await getDialogueStoreBackend().load('alice', 'key');
  expect([...h.toolJournal().keys()]).toEqual(['failed-write']);
  expect(saved?.toolJournal?.entries.map(({ call }) => call.id)).toEqual([
    'failed-write',
  ]);
});

test('subscribers receive task events and messages; messages stay in outbox for both tabs until acknowledged', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  const unsubscribe = h.subscribe((e) => events.push(e));
  const secondTab: DialogueEvent[] = [];
  const unsubscribeSecond = h.subscribe((e) => secondTab.push(e));
  await h.session.send('go');
  await until(() => events.some((e) => e.kind === 'message'));
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({
          state: 'running',
          createdAt: expect.any(Number),
          startedAt: expect.any(Number),
        }),
      }),
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({ state: 'done' }),
      }),
    ]),
  );
  expect(h.session.takePending()).toEqual([]);
  expect(secondTab).toEqual(events);
  unsubscribeSecond();
  unsubscribe();
  const count = events.length;
  await h.session.send('again');
  await until(() => h.outbox.pending().length > 0);
  expect(events).toHaveLength(count);
});
test('ttl cooperatively stops tasks, closes connections, forgets credentials, deletes state and prevents event turns', async () => {
  const { h, connection } = await ready();
  mockRun.mockImplementation(
    (input) =>
      new Promise((resolve) =>
        input.stopSignal?.addEventListener(
          'abort',
          () => resolve({ output: 'stopped', stopped: true }),
          { once: true },
        ),
      ),
  );
  const events: DialogueEvent[] = [];
  h.subscribe((e) => events.push(e));
  await h.session.send('go');
  await until(() => mockRun.mock.calls.length === 1);
  const turns = mockPlannerTurns.length;
  await closeDialogue('alice', 'key', 'ttl');
  expect(h.factory.hasCredentials()).toBe(false);
  expect(connection.close).toHaveBeenCalledTimes(1);
  expect(hasDialogueState('alice', 'key')).toBe(false);
  expect(mockPlannerTurns).toHaveLength(turns);
  await expect(h.session.send('after')).rejects.toThrow('closed');
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('a deferred dialogue worker can call the authenticated turn’s registered MCP tool', async () => {
  const registry = new LongSessionRegistry(
    { ttlMs: 100, maxSessions: 1, maxPerUser: 1, queueLength: 0 },
    { onClose: async () => {} },
  );
  setLongSessionsForTest(registry);
  const session = registry.open(ragCaller.userId, { key: ragCaller.sessionId });
  if ('refused' in session) throw new Error(session.refused);
  const bridge = new UserMcpBridge();
  session.userMcp = bridge;
  const name = 'user__documents__lookup';
  const data = 'Session document result';
  bridge.register(
    userMcpRegistration.parse({
      servers: [
        {
          name: 'documents',
          transport: 'companion',
          roles: ['executor'],
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
    bridge.answer(call.callId, { result: { content: data } }),
  );
  bridge.subscribe('companion', ['documents'], {
    executorId: 'companion-a',
    send,
    close: () => {},
  });
  const llm: ILlm = {
    model: 'fake',
    async chat(messages, tools) {
      if (
        messages.some(
          (message) =>
            message.role === 'tool' && message.content?.includes(data),
        )
      )
        return { ok: true, value: { content: data, finishReason: 'stop' } };
      expect(tools?.some((tool) => tool.name === name)).toBe(true);
      return {
        ok: true,
        value: {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'lookup', name, arguments: {} }],
        },
      };
    },
    async *streamChat(...args) {
      yield await llm.chat(...args);
    },
  };
  const built = unwrapBuilderResult(
    await new SmartAgentBuilder({ skipModelValidation: true })
      .withMode('hard')
      .withClassification(false)
      .withRagAccess(testAccess([ragCaller]))
      .withMainLlm(llm)
      .withMcpClients([userMcpClient('executor')])
      .build(),
  );
  const worker = new SmartAgentSubAgent('executor', built.agent);
  mockRun.mockImplementation((input) => worker.run(input));
  const { h } = await ready();
  try {
    await runWithSessionId(
      session.key,
      () => h.session.send('Look up a document'),
      [],
      session.userId,
      { admin: false, channel: 'anthropic', userMcpSession: session },
    );
    await until(() =>
      h.session.snapshot().tasks.some((task) => task.state === 'done'),
    );
    expect(h.session.snapshot().tasks[0]?.output).toBe(data);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'documents', tool: 'lookup' }),
    );
  } finally {
    await registry.close(session.userId, session.key, 'explicit');
  }
});

test('close settles a real SmartAgent continuous tool loop within a few iterations', async () => {
  let calls = 0;
  const answer = () => ({
    ok: true as const,
    value: {
      content: '',
      finishReason: 'tool_calls' as const,
      toolCalls: [{ id: `call-${calls}`, name: 'read', arguments: {} }],
    },
  });
  const built = unwrapBuilderResult(
    await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: {
        maxIterations: 100,
        classificationEnabled: false,
        ragTranslateEnabled: false,
        heartbeatIntervalMs: 1,
      },
    })
      .withRagAccess(testAccess([ragCaller]))
      .withMainLlm({
        model: 'fake',
        chat: async () => answer(),
        streamChat: async function* () {
          yield answer();
        },
      })
      .withMcpClients([
        {
          listTools: async () => ({
            ok: true,
            value: [
              {
                name: 'read',
                description: 'read',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }),
          callTool: async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 15));
            return {
              ok: true,
              value: { content: [{ type: 'text', text: 'read' }] },
            };
          },
        },
      ])
      .build(),
  );
  const worker = new SmartAgentSubAgent('executor', built.agent);
  mockRun.mockImplementation((input) => worker.run(input));
  const { h } = await ready();
  await h.session.send('go');
  await until(() => calls >= 2);
  const atClose = calls;
  await closeDialogue('alice', 'key', 'explicit');
  expect(calls - atClose).toBeLessThanOrEqual(2);
  expect(calls).toBeLessThan(100);
  expect(h.session.snapshot().tasks[0].state).toBe('stopped');
});

test('dialogue lifecycle logs contain goal sizes and hashed session keys', async () => {
  const cds = require('@sap/cds').default;
  const info = jest.spyOn(cds.log('dialogue'), 'info');
  try {
    const { h } = await ready();
    await h.session.send('go');
    await until(() => h.outbox.pending().length > 0);
    await closeDialogue('alice', 'key', 'explicit');
    const entries = info.mock.calls;
    expect(entries).toEqual(
      expect.arrayContaining([
        [
          'task started',
          expect.objectContaining({
            id: 't1',
            worker: 'executor',
            goalChars: 'read'.length,
          }),
        ],
        [
          'task finished',
          expect.objectContaining({
            id: 't1',
            state: 'done',
            durationMs: expect.any(Number),
          }),
        ],
        [
          'stop requested',
          expect.objectContaining({ id: 'all', reason: 'explicit' }),
        ],
        [
          'session close requested',
          expect.objectContaining({
            keyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            reason: 'explicit',
          }),
        ],
        ['close progress', expect.objectContaining({ tasksRemaining: 0 })],
        [
          'close finished',
          expect.objectContaining({ durationMs: expect.any(Number) }),
        ],
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain('"key"');
  } finally {
    info.mockRestore();
  }
});

test('lifecycle logs carry no goal text, task output or error text', async () => {
  const cds = require('@sap/cds').default;
  const info = jest.spyOn(cds.log('dialogue'), 'info');
  const warn = jest.spyOn(cds.log('dialogue-sessions'), 'warn');
  mockGoal =
    '{"password":"SENTINEL with spaces"} password=abc,SENTINEL Bearer SENTINEL https://u:SENTINEL@host';
  mockRun.mockResolvedValue({ output: 'OUTPUT_SENTINEL'.repeat(100) });
  mockDrop.mockImplementationOnce(() => {
    throw new Error('password=abc;SENTINEL');
  });
  try {
    const { h } = await ready();
    await h.session.send('go');
    await until(() => h.outbox.pending().length > 0);
    const started = info.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'task started',
    );
    if (!started) throw new Error('task start was not logged');
    expect(started[1]).toEqual(
      expect.objectContaining({ goalChars: mockGoal.length }),
    );
    expect(started[1]).not.toHaveProperty('goal');
    expect(warn).toHaveBeenCalledWith('dropRequest failed', {
      errorType: 'Error',
    });
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toMatch(/SENTINEL|OUTPUT_SENTINEL/);
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
});

test('shutdown preserves state; ttl deletes it', async () => {
  const h = await dialogueFor('alice', 'key', 'TEST');
  await h.session.send('go');
  await closeDialogue('alice', 'key', 'shutdown');
  expect(hasDialogueState('alice', 'key')).toBe(true);
  await closeDialogue('alice', 'key', 'ttl');
  expect(hasDialogueState('alice', 'key')).toBe(false);
});
test('hub-wide pool caps workers across two owners and releases after failure', async () => {
  const { h: a } = await ready('alice');
  const { h: b } = await ready('bob');
  let finish: (() => void) | undefined;
  mockRun.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ output: 'first' });
      }),
  );
  await a.session.send('go');
  await until(() => !!finish);
  await b.session.send('go');
  expect(mockRun).toHaveBeenCalledTimes(1);
  finish?.();
  await until(() => b.session.snapshot().tasks[0]?.state === 'done');
  expect(mockRun).toHaveBeenCalledTimes(2);
});
test('worker failures close unhealthy connections and release admission and pool', async () => {
  const { h, connection } = await ready();
  mockRun.mockRejectedValue(new Error('worker failed'));
  await h.session.send('go');
  await until(() => h.outbox.pending().length > 0);
  expect(connection.close).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(h.session.snapshot().tasks[0].state).toBe('failed');
  const release = await requiredExecutorPool().acquire();
  release();
});

test('builder secrets never reach task error, planner input, persistence or logs', async () => {
  const cds = require('@sap/cds').default;
  const warning = jest.spyOn(cds.log('background-connection'), 'warn');
  const builder =
    require('../../srv/lib/background-connection').buildConnectionForDestination;
  builder.mockRejectedValueOnce(
    new Error(
      'password=PASS_SENTINEL Bearer TOKEN_SENTINEL Authorization: HEADER_SENTINEL',
    ),
  );
  const h = await dialogueFor('alice', 'key', 'TEST');
  await h.factory.refresh(
    { headers: { authorization: 'Bearer request' } },
    'TEST',
  );
  await h.session.send('go');
  await until(() => h.outbox.pending().length > 0);
  expect(h.session.snapshot().tasks[0].error).toMatch(/^SAP connection failed/);
  const saved = await require('../../srv/lib/dialogue-store')
    .createDialogueStateStore('alice', 'key')
    .load('key');
  expect(saved).toBeDefined();
  expect(warning).toHaveBeenCalled();
  expect(
    JSON.stringify([
      h.session.snapshot(),
      mockPlannerTurns,
      saved,
      warning.mock.calls,
    ]),
  ).not.toMatch(/PASS_SENTINEL|TOKEN_SENTINEL|HEADER_SENTINEL/);
  warning.mockRestore();
});

test('outbox history and acknowledgement mode survive shutdown/reopen', async () => {
  const { h } = await ready();
  const tab1: DialogueEvent[] = [];
  const tab2: DialogueEvent[] = [];
  h.subscribe((e) => tab1.push(e));
  h.subscribe((e) => tab2.push(e));
  await h.session.send('go');
  await until(() => tab1.some((e) => e.kind === 'message'));
  expect(tab2).toEqual(tab1);
  await h.outbox.enterAckMode();
  const messages = h.outbox.pending();
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0].usage?.plannerMs).toEqual(expect.any(Number));
  await closeDialogue('alice', 'key', 'shutdown');
  const restored = await dialogueFor('alice', 'key', 'TEST');
  expect(restored.outbox.pending()).toEqual(messages);
  expect(restored.outbox.ackMode).toBe(true);
  await restored.outbox.confirmUpTo(messages[messages.length - 1].id);
  expect(restored.outbox.pending()).toEqual(messages);
  const delivery = restored.outbox.beginDelivery();
  for (const message of messages) delivery.carried(message.id);
  delivery.ended();
  await restored.outbox.confirmUpTo(messages[messages.length - 1].id);
  expect(restored.outbox.pending()).toEqual([]);
  expect(restored.outbox.history()).toEqual(messages);
  await closeDialogue('alice', 'key', 'shutdown');
  expect((await dialogueFor('alice', 'key', 'TEST')).outbox.pending()).toEqual(
    [],
  );
});

test('heartbeat activity maintains dialogue beyond TTL and restart restores state', async () => {
  const h = await dialogueFor('alice', 'key', 'TEST');
  await h.session.send('go');
  await until(() => h.outbox.pending().length > 0);
  const state = h.session.snapshot();
  const ttl = require('../../srv/lib/session-config').sessionConfig().ttlMs;
  const registry = new LongSessionRegistry(
    { ttlMs: ttl, maxSessions: 10, maxPerUser: 10, queueLength: 2 },
    { onClose: async () => {}, onTouch: lifecycleHooks().onTouch },
    () => Date.now(),
  );
  registry.open('alice', { key: 'key' });
  const now = jest.spyOn(Date, 'now');
  const start = Date.now();
  try {
    for (let elapsed = 60_000; elapsed <= ttl + 120_000; elapsed += 60_000) {
      now.mockReturnValue(start + elapsed);
      registry.touch('alice', 'key');
      await new Promise((resolve) => setImmediate(resolve));
      expect(registry.has('alice', 'key')).toBe(true);
      await getDialogueStoreBackend().sweepExpired(Date.now());
    }
    expect(hasDialogueState('alice', 'key')).toBe(true);
    await closeDialogue('alice', 'key', 'shutdown');
    const restored = await dialogueFor('alice', 'key', 'TEST');
    expect(restored.session.snapshot().conversation).toEqual(
      state.conversation,
    );
    expect(restored.session.snapshot().tasks).toEqual(state.tasks);
  } finally {
    now.mockRestore();
  }
});

test('legacy library pending migrates to hub outbox on opening and leaves library state empty', async () => {
  const message = {
    id: 'legacy',
    text: 'old pending',
    createdAt: 1,
    trigger: 'event' as const,
  };
  await getDialogueStoreBackend().save('alice', 'key', {
    conversation: [],
    tasks: [],
    pending: [message],
    savedAt: Date.now(),
  });
  const h = await dialogueFor('alice', 'key', 'TEST');
  expect(h.session.snapshot().pending).toEqual([]);
  expect(h.outbox.pending()).toEqual([message]);
  await closeDialogue('alice', 'key', 'shutdown');
  expect((await dialogueFor('alice', 'key', 'TEST')).outbox.pending()).toEqual([
    message,
  ]);
});

test('binds handle destination and rejects later mismatched lookups', async () => {
  const h = await dialogueFor('alice', 'key', 'B');
  expect(h.destination).toBe('B');
  await expect(dialogueFor('alice', 'key', 'A')).rejects.toMatchObject({
    code: 'DIALOGUE_DESTINATION_FIXED',
  });
});

test('creation listener waits for chat destination B and normal registry touch persists it', async () => {
  const onTouch = jest.fn();
  const registry = new LongSessionRegistry(
    { ttlMs: 60000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {}, onTouch },
  );
  const session = registry.open('alice', { key: 'key' });
  setLongSessionsForTest(registry);
  const created = jest.fn();
  const unsubscribe = onDialogueCreated('alice', 'key', created);
  try {
    expect(await lookupDialogue('alice', 'key')).toBeUndefined();
    expect(created).not.toHaveBeenCalled();
    const handle = await dialogueFor('alice', 'key', 'B');
    expect(handle.destination).toBe('B');
    expect(session).toMatchObject({ destination: 'B' });
    expect(onTouch).toHaveBeenLastCalledWith(session);
    expect(created).toHaveBeenCalledWith(handle);
    expect(
      jest.requireMock('../../srv/agent-manager').getSmartAgent,
    ).toHaveBeenCalledWith(undefined, 'B');
    await expect(lookupDialogue('alice', 'key', 'A')).rejects.toMatchObject({
      code: 'DIALOGUE_DESTINATION_FIXED',
    });
  } finally {
    unsubscribe();
    setLongSessionsForTest(undefined);
  }
});

test('restores a 9.0.x state with a long legacy text plan', async () => {
  const plan = 'x'.repeat(50_000);
  await getDialogueStoreBackend().save('alice', 'key', {
    conversation: [{ role: 'user', content: 'Legacy conversation' }],
    plan,
    tasks: [],
    pending: [],
    savedAt: Date.now(),
  });
  const h = await dialogueFor('alice', 'key', 'TEST');
  expect(h.session.snapshot().conversation).toContainEqual({
    role: 'user',
    content: 'Legacy conversation',
  });
  expect(dialoguePlan(h.session.snapshot())?.text).toBe(plan);
});

test('emits the finalized done status from the installed DialogueSession', async () => {
  // A step reaches done only through completed work, and skipping needs the
  // user's answer: restore a legacy done step and a pending question.
  await getDialogueStoreBackend().save('alice', 'key', {
    conversation: [],
    plan: {
      version: 1,
      steps: [
        { id: 'one', goal: 'Read', state: 'done', taskIds: [] },
        { id: 'two', goal: 'Store', state: 'pending', taskIds: [] },
      ],
      status: 'waiting_user',
      question: 'Skip storing?',
    },
    tasks: [],
    pending: [],
    savedAt: Date.now(),
  });
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  mockPlan = {
    steps: [
      { id: 'one', goal: 'Read', state: 'done' },
      { id: 'two', goal: 'Store', state: 'skipped', note: 'User agreed' },
    ],
    status: 'active',
  };
  await h.session.send('Yes, skip it');
  expect(dialoguePlan(h.session.snapshot())?.status).toBe('done');
  await h.session.send('unchanged');
  const plans = events.filter((event) => event.kind === 'plan');
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({
    kind: 'plan',
    plan: {
      status: 'done',
      steps: [
        { id: 'one', state: 'done' },
        { id: 'two', state: 'skipped' },
      ],
    },
  });
  // A new input after completion starts a fresh request in prepared context mode.
  expect(dialoguePlan(h.session.snapshot())).toBeUndefined();
});

test('plan events emit only when text or status changes after planner turns', async () => {
  const { h } = await ready();
  expect(dialoguePlan(h.session.snapshot())).toBeUndefined();
  expect(dialoguePlan({ ...h.session.snapshot(), plan: 'Legacy' })).toEqual({
    text: 'Legacy',
    status: 'active',
  });
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  mockPlan = {
    plan: 'Read records',
    status: 'waiting_user',
    question: 'Continue?',
  };
  await h.session.send('first');
  await h.session.send('same');
  mockPlan = { plan: 'Read records', status: 'done' };
  await h.session.send('status');
  mockPlan = { plan: 'Finished reading', status: 'done' };
  await h.session.send('text');
  expect(events.filter((event) => event.kind === 'plan')).toEqual([
    {
      kind: 'plan',
      plan: { text: 'Read records', steps: [], status: 'waiting_user' },
    },
    { kind: 'plan', plan: { text: 'Read records', steps: [], status: 'done' } },
    {
      kind: 'plan',
      plan: { text: 'Finished reading', steps: [], status: 'done' },
    },
  ]);
});

test('structured step changes emit even when plan text and status stay the same', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  mockPlan = {
    steps: [{ id: 'one', goal: 'Read', state: 'pending' }],
    status: 'waiting_user',
    question: 'Proceed?',
  };
  await h.session.send('plan');
  await h.session.send('unchanged');
  mockPlan.steps = [{ id: 'one', goal: 'Read revised', state: 'pending' }];
  await h.session.send('revise');
  const plans = events.filter((event) => event.kind === 'plan');
  expect(plans).toHaveLength(2);
  expect(plans[1]).toMatchObject({
    kind: 'plan',
    plan: {
      status: 'waiting_user',
      steps: [
        { id: 'one', goal: 'Read revised', state: 'pending', taskIds: [] },
      ],
    },
  });
});

function lifetimeRegistry() {
  let now = 0;
  const registry = new LongSessionRegistry(
    { ttlMs: 1000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
    { onClose: async () => {} },
    () => now,
  );
  registry.open('alice', { key: 'key' });
  setLongSessionsForTest(registry);
  const hold = jest.spyOn(registry, 'hold');
  return {
    registry,
    hold,
    setTime: (value: number) => {
      now = value;
    },
  };
}

test('a running task holds the session; finishing all tasks releases it', async () => {
  const { registry, hold, setTime } = lifetimeRegistry();
  const finishes: Array<() => void> = [];
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve({ output: 'done' }));
      }),
  );
  const { h } = await ready();
  await h.session.send('go');
  await until(() => finishes.length === 1);
  await h.session.send('another');
  setTime(2000);
  expect(await registry.sweep()).toBe(0);
  expect(hold).toHaveBeenCalledTimes(1);
  finishes[0]();
  await until(() => finishes.length === 2);
  setTime(4000);
  expect(await registry.sweep()).toBe(0);
  expect(hold).toHaveBeenCalledTimes(1);
  finishes[1]();
  await until(() =>
    h.session.snapshot().tasks.every((task) => task.state === 'done'),
  );
  expect(registry.get('alice', 'key')?.lastActivity).toBe(4000);
  setTime(5001);
  expect(await registry.sweep()).toBe(1);
});

test('a queued task cancelled before start releases the hold', async () => {
  const { registry, hold, setTime } = lifetimeRegistry();
  const releasePool = await requiredExecutorPool().acquire();
  try {
    const { h } = await ready();
    await h.session.send('go');
    const task = h.session.snapshot().tasks[0];
    expect(task.state).toBe('queued');
    setTime(2000);
    expect(await registry.sweep()).toBe(0);
    expect(hold).toHaveBeenCalledTimes(1);
    mockPlannerHook = async (text) => {
      // The library prepends plan and environment notes to the user input.
      if (text.endsWith('\ncancel')) {
        const result = await new PlannerToolsClient().callTool('stop_task', {
          task_id: task.id,
        });
        expect(result).toMatchObject({
          ok: true,
          value: {
            content: [
              { type: 'text', text: JSON.stringify({ stopped: true }) },
            ],
          },
        });
        mockPlan = { plan: 'Cancelled', status: 'done' };
      }
    };
    await h.session.send('cancel');
    expect(h.session.snapshot().tasks[0].state).toBe('stopped');
    expect(mockRun).not.toHaveBeenCalled();
    // Cancellation leaves the planner turn holding the session until it ends.
    expect(h.state().turnActive).toBe(true);
    expect(registry.get('alice', 'key')?.lastActivity).toBe(2000);
    setTime(3000);
    expect(await registry.sweep()).toBe(0);
    await until(() => !h.state().turnActive);
    expect(registry.get('alice', 'key')?.lastActivity).toBe(3000);
    setTime(4001);
    expect(await registry.sweep()).toBe(1);
  } finally {
    releasePool();
  }
});

test('the final planner turn holds the session after the last worker finishes', async () => {
  const { registry, setTime } = lifetimeRegistry();
  let finish!: () => void;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ output: 'done' });
      }),
  );
  const { h } = await ready();
  await h.session.send('go');
  await until(() => !!finish);
  mockPlannerHook = async (text) => {
    if (text.startsWith('[task events]')) await blocked;
  };
  try {
    setTime(2000);
    finish();
    await until(() =>
      mockPlannerTurns.some((text) => text.startsWith('[task events]')),
    );
    expect(h.session.snapshot().tasks[0].state).toBe('done');
    expect(h.state().turnActive).toBe(true);
    setTime(3001);
    expect(await registry.sweep()).toBe(0);
    unblock();
    await until(() => !h.state().turnActive);
    expect(registry.get('alice', 'key')?.lastActivity).toBe(3001);
    setTime(4002);
    expect(await registry.sweep()).toBe(1);
  } finally {
    unblock();
  }
});

test.each([false, true])(
  'final save persists the registered reply before send resolves (stream: %s)',
  async (stream) => {
    mockPlan = { plan: 'Read', status: 'done' };
    const { h } = await ready();
    const trace = { traceId: 'reply-trace' };
    h.replies.set(trace, { id: 'streamed-reply', createdAt: 123 });
    let resolved = false;
    let checked = false;
    const backend = getDialogueStoreBackend();
    const save = backend.save.bind(backend);
    const spy = jest
      .spyOn(backend, 'save')
      .mockImplementation(async (user, key, row) => {
        if (row.outbox?.some((entry) => entry.id === 'streamed-reply')) {
          expect(resolved).toBe(false);
          expect(row.outbox).toContainEqual({
            id: 'streamed-reply',
            createdAt: 123,
            text: 'Plan updated',
            trigger: 'user',
          });
          checked = true;
        }
        await save(user, key, row);
      });
    try {
      await h.session.send('go', {
        trace,
        ...(stream ? { onPartial: () => {} } : {}),
      });
      resolved = true;
      expect(checked).toBe(true);
    } finally {
      spy.mockRestore();
    }
    await closeDialogue('alice', 'key', 'shutdown');
    const restored = await dialogueFor('alice', 'key', 'TEST');
    expect(restored.outbox.pending()).toContainEqual({
      id: 'streamed-reply',
      createdAt: 123,
      text: 'Plan updated',
      trigger: 'user',
    });
  },
);

test('a corrective user turn publishes consumed task usage after its live reply', async () => {
  const { h } = await ready();
  const taskUsage = { promptTokens: 7, completionTokens: 4, totalTokens: 11 };
  let finish!: () => void;
  mockRun.mockImplementation(
    () =>
      new Promise<ISubAgentResult>((resolve) => {
        finish = () => resolve({ output: 'done', usage: taskUsage });
      }),
  );
  await h.session.send('start');
  await until(() => !!finish);
  mockPlanUsage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
  let calls = 0;
  mockPlannerHook = async () => {
    calls++;
    if (calls === 1) {
      finish();
      await until(() => h.session.snapshot().tasks[0]?.state === 'done');
      mockPlan = { steps: [{ id: 'read', goal: 'Read' }], status: 'active' };
    } else {
      mockPlan = {
        steps: [{ id: 'read', goal: 'Read' }],
        status: 'waiting_user',
        question: 'Proceed?',
      };
    }
  };
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  const app = express();
  app.get('/', async (req, res) => {
    const result = await dialogueChat(
      req,
      'alice',
      {
        userId: 'alice',
        key: 'key',
        createdAt: 0,
        lastActivity: 0,
        revived: false,
      },
      'TEST',
      res,
    ).process([{ role: 'user', content: 'go' }], {
      caller: ragCaller,
      sessionId: ragCaller.sessionId,
    });
    res.json(result.ok ? { ok: true } : result);
  });
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(await response.json()).toEqual({ ok: true });
    const reply = events.find(
      (event) => event.kind === 'message' && event.message.trigger === 'user',
    );
    if (reply?.kind !== 'message') throw new Error('Missing reply');
    const update = events.find(
      (event) => event.kind === 'usage' && event.id === reply.message.id,
    );
    if (update?.kind !== 'usage') throw new Error('Missing usage update');
    expect(events.indexOf(update)).toBeGreaterThan(events.indexOf(reply));
    expect(
      events.filter(
        (event) =>
          event.kind === 'message' && event.message.id === reply.message.id,
      ),
    ).toHaveLength(1);
    expect(sumPlannerUsage([update.usage])?.totalTokens).toBe(21);
    expect(update.usage.tasks).toEqual([
      {
        id: h.session.snapshot().tasks[0].id,
        worker: 'executor',
        usage: taskUsage,
        durationMs: expect.any(Number),
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('wait signals are session scoped, live only and unsubscribe on close', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  const tasks = [
    {
      id: 't1',
      worker: 'executor',
      goal: 'read',
      state: 'running' as const,
      elapsedMs: 90000,
    },
  ];
  dialogueSignals().emit('dialogue.wait', { tasks }, 'other');
  expect(events).toEqual([]);
  dialogueSignals().emit(
    'dialogue.wait',
    { tasks },
    JSON.stringify(['alice', 'key']),
  );
  expect(events).toEqual([{ kind: 'wait', tasks }]);
  const replay: DialogueEvent[] = [];
  h.subscribe((event) => replay.push(event));
  expect(replay).toEqual([]);
  expect(h.outbox.pending()).toEqual([]);
  await closeDialogue('alice', 'key', 'explicit');
  dialogueSignals().emit(
    'dialogue.wait',
    { tasks },
    JSON.stringify(['alice', 'key']),
  );
  expect(events).toHaveLength(1);
});

test('dialogue worker and background pipeline preserve trace evidence in persisted tasks', async () => {
  const toolTrace: ToolTrace = {
    entries: [
      {
        sequence: 1,
        toolName: 'Read',
        arguments: '{}',
        resultExcerpt: 'read done',
        outcome: 'ok',
      },
    ],
    omittedCount: 0,
    complete: true,
  };
  mockRun.mockImplementation(
    async (input: ISubAgentInput): Promise<ISubAgentResult> => {
      expect(input.onToolTrace).toBeDefined();
      input.onToolTrace?.(toolTrace.entries[0]);
      return { output: 'read done', toolTrace };
    },
  );
  const { h } = await ready();
  await h.session.send('go');
  await until(() => h.session.snapshot().tasks[0]?.state === 'done');
  expect(h.session.snapshot().tasks[0].toolTrace).toEqual(toolTrace);
  await closeDialogue('alice', 'key', 'shutdown');
  expect(
    (await getDialogueStoreBackend().load('alice', 'key'))?.tasks[0].toolTrace,
  ).toEqual(toolTrace);
});

test('reused handle captures caller privileges and channel for each queued turn', async () => {
  liveSession('alice', 'key');
  const sink = memorySink({ limit: 20 });
  const recorder = createUsageRecorder({ transport: directTransport(sink) });
  const { h } = await runWithSessionId('key', () => ready(), [], 'alice', {
    admin: true,
    channel: 'anthropic',
  });
  const registry = new CollectionRegistry();
  await registry.createCollection({
    id: 'global-notes',
    logicalId: 'global-notes',
    displayName: 'notes',
    description: '',
    scope: 'global',
  });
  const channels: string[] = [];
  const admins: boolean[] = [];
  mockPlannerHook = async (text: string) => {
    if (text.startsWith('[task events]')) return;
    const identity = getRagCallerIdentity();
    channels.push(identity.channel);
    admins.push(identity.admin);
    await executeRagTool(
      {
        registry,
        userId: getRequestUserId() ?? '',
        admin: identity.admin,
        sessionKey: 'key',
        internal: true,
        trustedAdmission: true,
        readOnly: false,
        permissions: { allows: () => true },
        channel: identity.channel,
        measurement: recorder,
      },
      'record_add',
      { collection: 'global-notes', text: 'test' },
    );
  };
  const reused = await dialogueFor('alice', 'key', 'TEST');
  expect(reused).toBe(h);
  const trace = { traceId: 'reused-trace' };
  const first = runWithSessionId(
    'key',
    () => h.session.send('first', { trace }),
    [],
    'alice',
    { admin: true, channel: 'anthropic' },
  );
  const second = runWithSessionId(
    'key',
    () => reused.session.send('second', { trace }),
    [],
    'alice',
    { admin: false, channel: 'openai' },
  );
  await Promise.all([first, second]);
  expect(admins).toEqual([true, false]);
  expect(channels).toEqual(['anthropic', 'openai']);
  await recorder.flush(1000);
  const recordedChannels: string[] = [];
  for await (const record of sink.read({
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  })) {
    if (record.context.channel) recordedChannels.push(record.context.channel);
  }
  expect(recordedChannels).toEqual(['anthropic', 'openai']);
  await recorder.close(1000);
});

test('queued background tasks keep their scheduling identity and account for their own provider calls', async () => {
  const { h } = await ready();
  const release = await requiredExecutorPool().acquire();
  const releaseSpend = captureTokenUsage();
  const usage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 };
  const llm = reliableLlm({
    model: 'worker-model',
    chat: async () => ({
      ok: true,
      value: { content: 'done', finishReason: 'stop', usage },
    }),
    async *streamChat() {},
  });
  const identities: { admin: boolean; channel: string }[] = [];
  mockRun.mockImplementation(async () => {
    const { admin, channel } = getRagCallerIdentity();
    identities.push({ admin, channel });
    const result = await llm.chat([]);
    if (!result.ok) throw result.error;
    return { output: result.value.content };
  });
  try {
    await runWithSessionId('key', () => h.session.send('first'), [], 'alice', {
      admin: true,
      channel: 'anthropic',
    });
    await runWithSessionId('key', () => h.session.send('second'), [], 'alice', {
      admin: false,
      channel: 'openai',
    });
    expect(identities).toEqual([]);
  } finally {
    releaseSpend.run(release);
  }
  await until(() => identities.length === 2);
  expect(identities).toEqual([
    { admin: true, channel: 'anthropic' },
    { admin: false, channel: 'openai' },
  ]);
  await until(
    () =>
      h.session.snapshot().tasks.filter((task) => task.state === 'done')
        .length === 2,
  );
  expect(h.session.snapshot().tasks.map((task) => task.usage)).toEqual(
    Array.from({ length: 2 }, () => ({
      ...usage,
      models: { 'worker-model': { ...usage, requests: 1 } },
    })),
  );
  expect(releaseSpend.usage()).toBeUndefined();
});

test('event planner uses the originating task identity when an earlier caller owns the drain', async () => {
  const { h } = await ready();
  const eventIdentities: { admin: boolean; channel: string }[] = [];
  mockPlannerHook = async (text: string) => {
    if (text.startsWith('[task events]')) {
      const { admin, channel } = getRagCallerIdentity();
      eventIdentities.push({ admin, channel });
    } else {
      mockPlan = text.includes('first') ? { status: 'done' } : undefined;
    }
  };
  const first = runWithSessionId(
    'key',
    () => h.session.send('first'),
    [],
    'alice',
    {
      admin: true,
      channel: 'anthropic',
    },
  );
  const second = runWithSessionId(
    'key',
    () => h.session.send('second'),
    [],
    'alice',
    {
      admin: false,
      channel: 'openai',
    },
  );
  await Promise.all([first, second]);
  await until(() => eventIdentities.length > 0);
  expect(eventIdentities).toEqual([{ admin: false, channel: 'openai' }]);
});

test.each(
  [
    { reconnect: false, isError: false },
    { reconnect: true, isError: false },
    { reconnect: false, isError: true },
    { reconnect: true, isError: true },
    { reconnect: true, isError: false, initial: true },
  ].flatMap((options) =>
    [undefined, 'summary', 'SuMmArY', 'full'].map((toolResults) => ({
      ...options,
      toolResults,
    })),
  ),
)(
  'worker RAG result reaches the active stream once (reconnect: $reconnect, error: $isError)',
  async ({ reconnect, isError, initial, toolResults }) => {
    let finishTool!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const toolResult = {
      isError,
      content: JSON.stringify({
        result: 'Record added.',
        record: 'saved-id',
        collection: 'notes',
      }),
    };
    const client = new RecordingMcpClient({
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => {
        await blocked;
        return { ok: true, value: toolResult };
      },
    });
    let toolFinished = false;
    mockRun.mockImplementation(async () => {
      if (!initial)
        await client.callTool('record_add', {
          collection: 'notes',
          text: 'saved',
        });
      toolFinished = true;
      return { output: 'saved' };
    });
    mockPlannerHook = async () => {
      await new PlannerToolsClient().callTool('plan_update', {
        plan: 'Save record',
        status: 'active',
      });
      if (initial) {
        await client.callTool('record_add', {
          collection: 'notes',
          text: 'saved',
        });
        toolFinished = true;
      }
    };
    const { h } = await ready();
    const originalSink = jest.fn();
    const app = express();
    let followers = 0;
    const subscribe = h.subscribe.bind(h);
    jest
      .spyOn(h, 'subscribe')
      .mockImplementation((fn, cursor, consumesToolResults) => {
        followers++;
        return subscribe(fn, cursor, consumesToolResults);
      });
    app.get('/', async (req, res) => {
      const stream = chatStream(res, 'openai');
      stream.ensureStream();
      const agent = dialogueChat(
        req,
        'alice',
        {
          userId: 'alice',
          key: 'key',
          createdAt: 0,
          lastActivity: 0,
          revived: false,
        },
        'TEST',
        res,
      );
      const continuation = await streamDialogue({
        stream,
        protocol: 'openai',
        model: 'test',
        agent,
        source: agent.streamProcess([{ role: 'user', content: 'go' }], {
          caller: ragCaller,
          sessionId: ragCaller.sessionId,
        }),
        run: (fn) =>
          runWithSessionId('key', fn, [], 'alice', {
            admin: false,
            channel: 'openai',
            onToolResult: originalSink,
          }),
        onError: (error) => ({ error: String(error) }),
      });
      await continuation();
    });
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const url = `http://127.0.0.1:${address.port}/`;
      const first = await fetch(url, {
        signal: controller.signal,
        headers: toolResults ? { 'x-clh-tool-results': toolResults } : {},
      });
      await until(() =>
        initial ? followers >= 1 : mockRun.mock.calls.length === 1,
      );
      await until(() => followers >= (initial ? 1 : 2));
      let response = first;
      if (reconnect) {
        controller.abort();
        await until(() => !h.hasSubscribers());
        mockPlan = { status: 'active' };
        finishTool();
        await until(() => toolFinished);
        if (initial) mockPlannerHook = undefined;
        response = await fetch(url, {
          headers: toolResults ? { 'x-clh-tool-results': toolResults } : {},
        });
        await until(() => followers >= (initial ? 3 : 4));
      }
      // Settle the plan after the delayed tool result reaches the follower.
      mockPlannerHook = undefined;
      mockPlan = { status: 'done' };
      finishTool();
      const body = await response.text();
      if (toolResults?.toLowerCase() === 'summary') {
        expect(body.match(/: tool-result /g)).toHaveLength(1);
        expect(body).toContain('saved-id');
        expect(body).toContain('record_add');
        const line = body
          .split('\n')
          .find((value) => value.startsWith(': tool-result '));
        expect(JSON.parse(line?.slice(14) ?? '{}')).toEqual({
          call: { name: 'record_add', arguments: { collection: 'notes' } },
          result: {
            isError,
            structuredContent: {
              collection: 'notes',
              record: 'saved-id',
              ...(isError ? { error: { code: 'ERROR' } } : {}),
            },
          },
        });
      } else expect(body).not.toContain(': tool-result ');
      expect(body).toContain('[DONE]');
      expect(originalSink).not.toHaveBeenCalled();
    } finally {
      finishTool();
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('retains worker results across the subscriber handoff once, with a bounded queue and close cleanup', async () => {
  let report: ReturnType<typeof getRagCallerIdentity>['onToolResult'];
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mockRun.mockImplementation(async () => {
    report = getRagCallerIdentity().onToolResult;
    await blocked;
    return { output: 'done' };
  });
  const { h } = await ready();
  const first: DialogueEvent[] = [];
  const unsubscribe = h.subscribe((event) => first.push(event));
  await h.session.send('go');
  await until(() => report !== undefined);
  // The WebUI session-events observer stays attached between chat followers.
  h.subscribe(() => {});
  unsubscribe();
  const record = (id: number) => ({
    call: { id: String(id), name: 'record_get', arguments: {} },
    result: { content: `download-${id}`, isError: id === 54 },
  });
  try {
    for (let id = 0; id < 55; id++) report?.(record(id));
    const received: DialogueEvent[] = [];
    const off = h.subscribe(
      (event) => {
        received.push(event);
        if (event.kind === 'tool-result') event.written?.();
      },
      undefined,
      true,
    );
    expect(received.filter((event) => event.kind === 'tool-result')).toEqual(
      Array.from({ length: 50 }, (_, index) => ({
        kind: 'tool-result',
        record: record(index + 5),
        written: expect.any(Function),
      })),
    );
    off();
    const replay: DialogueEvent[] = [];
    h.subscribe((event) => replay.push(event), undefined, true)();
    expect(replay.filter((event) => event.kind === 'tool-result')).toEqual([]);
    expect(first.filter((event) => event.kind === 'tool-result')).toEqual([]);
    report?.(record(55));
    finish();
    await closeDialogue('alice', 'key', 'ttl');
    const closed: DialogueEvent[] = [];
    h.subscribe((event) => closed.push(event));
    expect(closed).toEqual([]);
    const reopened = await dialogueFor('alice', 'key', 'TEST');
    const restored: DialogueEvent[] = [];
    reopened.subscribe((event) => restored.push(event));
    expect(restored.filter((event) => event.kind === 'tool-result')).toEqual(
      [],
    );
  } finally {
    finish();
  }
});

test.each([false, true])(
  'retains worker results with session-events attached after follow disconnect: %s',
  async (disconnect) => {
    let report: ReturnType<typeof getRagCallerIdentity>['onToolResult'];
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockRun.mockImplementation(async () => {
      report = getRagCallerIdentity().onToolResult;
      await blocked;
      return { output: 'done' };
    });
    const { h } = await ready();
    const detach = h.subscribe(() => {});
    const controller = new AbortController();
    const follow = (signal: AbortSignal) =>
      followDialogue(h, {
        delivery: h.outbox.beginDelivery(),
        since: 0,
        signal,
      });
    try {
      await h.session.send('go');
      await until(() => report !== undefined);
      if (disconnect) {
        const items = [];
        const iterator = follow(controller.signal)[Symbol.asyncIterator]();
        let settled = false;
        const next = iterator.next().then((item) => {
          settled = true;
          return item;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(settled).toBe(false);
        controller.abort();
        items.push((await next).value);
        for await (const item of { [Symbol.asyncIterator]: () => iterator }) {
          items.push(item);
          if (item.kind === 'tool-result') item.written?.();
        }
        expect(items.at(-1)).toMatchObject({
          kind: 'end',
          reason: 'disconnected',
        });
      }
      const record = {
        call: { id: 'retained', name: 'record_get', arguments: {} },
        result: { content: 'saved' },
      };
      report?.(record);
      const resultController = new AbortController();
      const items = [];
      for await (const item of follow(resultController.signal)) {
        items.push(item);
        if (item.kind === 'tool-result') {
          item.written?.();
          resultController.abort();
        }
      }
      expect(items.filter((item) => item.kind === 'tool-result')).toEqual([
        { kind: 'tool-result', record, written: expect.any(Function) },
      ]);
      const replayController = new AbortController();
      const replayIterator = follow(replayController.signal)[
        Symbol.asyncIterator
      ]();
      const replayNext = replayIterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      replayController.abort();
      const replay = [(await replayNext).value];
      await replayIterator.return?.();
      expect(replay.filter((item) => item.kind === 'tool-result')).toEqual([]);
    } finally {
      detach();
      finish();
    }
  },
);

test.each(['running', 'queued'] as const)(
  'hub restore interrupts a legacy %s task before dispatch and persists the marker',
  async (taskState) => {
    const stored: HubDialogueState = {
      conversation: [{ role: 'user', content: 'Keep this evidence' }],
      tasks: [
        {
          id: 'legacy',
          worker: 'executor',
          goal: 'Continue old write',
          state: taskState,
          createdAt: 1,
        },
        {
          id: 'completed',
          worker: 'executor',
          goal: 'Saved artifact',
          state: 'done',
          output: 'existing-id',
          createdAt: 1,
        },
      ],
      plan: {
        version: 1,
        status: 'active',
        steps: [
          {
            id: 'phase',
            goal: 'Continue',
            state: 'running',
            taskIds: ['legacy'],
          },
        ],
      },
      pending: [],
      savedAt: Date.now(),
    };
    await getDialogueStoreBackend().save('alice', 'key', stored);
    const h = await dialogueFor('alice', 'key', 'TEST');
    expect(h.session.snapshot().tasks[0].state).toBe('interrupted');
    expect(h.session.snapshot().tasks[1]).toMatchObject(stored.tasks[1]);
    expect(h.session.snapshot().conversation).toEqual(stored.conversation);
    expect(dialoguePlan(h.session.snapshot())?.steps?.[0].state).toBe(
      'blocked',
    );
    // A plan-only turn exercises normal hub persistence without delegating new work.
    mockPlan = { plan: 'Review existing IDs before replanning' };
    await h.session.send('Review the restored work');
    expect(mockRun).not.toHaveBeenCalled();
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))
        ?.toolContractVersion,
    ).toBe(DIALOGUE_TOOL_CONTRACT_VERSION);
    await closeDialogue('alice', 'key', 'shutdown');
    const reopened = await dialogueFor('alice', 'key', 'TEST');
    expect(reopened.session.snapshot().tasks[0].state).toBe('interrupted');
    expect(mockRun).not.toHaveBeenCalled();
  },
);

test('hub restore preserves unfinished current-contract work', async () => {
  const stored: HubDialogueState = {
    toolContractVersion: DIALOGUE_TOOL_CONTRACT_VERSION,
    conversation: [],
    tasks: [],
    plan: {
      version: 1,
      status: 'active',
      steps: [{ id: 'phase', goal: 'Read', state: 'pending', taskIds: [] }],
    },
    pending: [],
    savedAt: Date.now(),
  };
  await getDialogueStoreBackend().save('alice', 'key', stored);
  const h = await dialogueFor('alice', 'key', 'TEST');
  expect(h.session.snapshot().tasks).toEqual(stored.tasks);
  expect(dialoguePlan(h.session.snapshot())?.steps?.[0].state).toBe('pending');
  expect(mockRun).not.toHaveBeenCalled();
});

test.each(['queued', 'running'] as const)(
  'hub passes current-contract %s tasks unchanged to library restore',
  async (taskState) => {
    const stored: HubDialogueState = {
      toolContractVersion: DIALOGUE_TOOL_CONTRACT_VERSION,
      conversation: [],
      tasks: [
        {
          id: 'current',
          worker: 'executor',
          goal: 'Read current record',
          state: taskState,
          createdAt: 1,
        },
      ],
      pending: [],
      savedAt: Date.now(),
    };
    await getDialogueStoreBackend().save('alice', 'key', stored);
    const open = DialogueSession.open.bind(DialogueSession);
    const boundary = jest
      .spyOn(DialogueSession, 'open')
      .mockImplementationOnce(async (options) => {
        const loaded = await options.store?.load('key');
        expect(loaded?.tasks).toEqual(stored.tasks);
        return open(options);
      });
    try {
      const h = await dialogueFor('alice', 'key', 'TEST');
      expect(boundary).toHaveBeenCalledTimes(1);
      // The library independently interrupts active tasks on every restart.
      // The migration boundary above must leave current-contract tasks untouched.
      expect(h.session.snapshot().tasks[0].error).toBeUndefined();
      expect(mockRun).not.toHaveBeenCalled();
    } finally {
      boundary.mockRestore();
    }
  },
);

test('same-user dialogues isolate every LLM call, clients, quota and retrieval after close', async () => {
  const marker = 'SESSION_A_PRIVATE_CDS_MARKER';
  const memory = new InMemoryRag();
  const histories = new InMemoryRagProvider({ name: 'history-isolation' });
  const embedding = symmetricEmbedder({
    embed: async () => ({ vector: [1, 0] }),
  });
  const calls = new Map<string, string[]>();
  const clients = new Map<string, ILlm>();
  const history = new SessionHistoryRouter(histories);
  mockIsolationHistory = history;
  mockCaptureLlm = async () => {
    const owner = sessionLlms.getStore();
    if (!owner) throw new Error('Missing session LLM owner');
    return owner.get('isolation', async () => {
      const llm: ILlm = {
        async chat(messages) {
          const entries = calls.get(owner.quotaScope) ?? [];
          entries.push(JSON.stringify(messages));
          calls.set(owner.quotaScope, entries);
          return { ok: true, value: { content: 'Done', finishReason: 'stop' } };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      clients.set(owner.quotaScope, llm);
      return llm;
    });
  };
  const setup = jest
    .spyOn(plannerMemory, 'plannerSessionOptions')
    .mockImplementation(async (user, key) => ({
      plannerMemory: {
        rag: scopedPlannerMemory(memory, turnOwner(user, key), key),
        queryEmbedder: embedding,
        documentEmbedder: embedding,
      },
    }));
  const open = jest.spyOn(DialogueSession, 'open');
  const keys = isolationCallers.map((caller) => caller.sessionId);
  try {
    const a = await dialogueFor('alice', keys[0], 'TEST');
    const aOwner = longSessionLlms({ userId: 'alice', key: keys[0] });
    await a.session.send(marker);
    await history.query(
      new TextOnlyEmbedding(marker),
      5,
      callOptionsFor(isolationCallers[0]),
    );
    expect(await history.listTurns(isolationCallers[0])).toEqual([
      expect.objectContaining({ userText: marker, assistantText: 'Done' }),
    ]);
    // Prove the marker was persisted before checking the negative cases.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const aMemory = await scopedPlannerMemory(
      memory,
      turnOwner('alice', keys[0]),
      keys[0],
    ).query(new TextOnlyEmbedding(marker), 100);
    expect(
      aMemory.ok && aMemory.value.some((row) => row.text.includes(marker)),
    ).toBe(true);
    const aHistory = await runWithSessionId(
      keys[0],
      () =>
        history.query(
          new TextOnlyEmbedding(marker),
          100,
          callOptionsFor(
            isolationCallers.find(
              (caller) => caller.sessionId === getRequestSessionId(),
            ) ?? ragCaller,
          ),
        ),
      [],
      'alice',
    );
    expect(
      aHistory.ok && aHistory.value.some((row) => row.text.includes(marker)),
    ).toBe(true);

    for (const key of keys.slice(1)) {
      if (key === keys[2]) await closeDialogue('alice', keys[0], 'shutdown');
      const h = await dialogueFor('alice', key, 'TEST');
      const owner = longSessionLlms({ userId: 'alice', key });
      await h.session.send('Review my CDS');
      await h.session.callTool('plan_create', { goal: 'Plan my review' });
      expect(owner.quotaScope).not.toBe(aOwner.quotaScope);
      expect(clients.get(owner.quotaScope)).not.toBe(
        clients.get(aOwner.quotaScope),
      );
      const captured = calls.get(owner.quotaScope) ?? [];
      expect(captured.length).toBeGreaterThanOrEqual(2);
      expect(captured.every((call) => !call.includes(marker))).toBe(true);
      const options = open.mock.calls.find(
        ([options]) => options.id === key,
      )?.[0];
      const recalled = await options?.plannerMemory?.rag.query(
        new TextOnlyEmbedding(marker),
        100,
      );
      expect(
        recalled?.ok && recalled.value.some((row) => row.text.includes(marker)),
      ).toBe(false);
      const recalledHistory = await runWithSessionId(
        key,
        () =>
          history.query(
            new TextOnlyEmbedding(marker),
            100,
            callOptionsFor(
              isolationCallers.find(
                (caller) => caller.sessionId === getRequestSessionId(),
              ) ?? ragCaller,
            ),
          ),
        [],
        'alice',
      );
      expect(recalledHistory.ok).toBe(true);
      if (recalledHistory.ok)
        expect(
          recalledHistory.value.every((row) => !row.text.includes(marker)),
        ).toBe(true);
    }
  } finally {
    for (const key of keys) await closeDialogue('alice', key, 'shutdown');
    setup.mockRestore();
    open.mockRestore();
  }
});

test('dialogue opens with a stateless profile plan author and environment notes', async () => {
  const open = jest.spyOn(DialogueSession, 'open');
  const search = jest.fn(async () => [
    { collection: 'planning', id: 'rule', text: 'Headless planning guidance' },
  ]);
  const setup = jest
    .spyOn(plannerMemory, 'plannerSessionOptions')
    .mockResolvedValue({ plannerKnowledge: [{ name: 'planning', search }] });
  const retrieval = jest.spyOn(plannerMemory, 'planAuthorContextNotes');
  try {
    const h = await dialogueFor('alice', 'author-wiring', 'TEST');
    const options = open.mock.calls.at(-1)?.[0];
    expect(options?.planAuthor).toBeDefined();
    expect(options?.profileSource).toBeDefined();
    expect(options?.profileRunner).toBeDefined();
    const result = await options?.planAuthor?.create(
      {
        goal: 'Read the requested objects',
      },
      options?.caller && callOptionsFor(options.caller),
    );
    expect(result?.ok).toBe(true);
    expect(mockAuthorTurns.at(-1)).toContain('Environment');
    expect(mockAuthorTurns.at(-1)).toContain('Destination: TEST');
    expect(mockAuthorTurns.at(-1)).toContain('[worker profiles]');
    expect(mockAuthorTurns.at(-1)).toContain('executor');
    const beforeCreate = mockAuthorOptions.length;
    if (!options) throw new Error('Missing dialogue options');
    await h.session.callTool(
      'plan_create',
      { goal: 'External coordinator request' },
      callOptionsFor({ ...options.caller }),
    );
    expect(mockAuthorOptions).toHaveLength(beforeCreate + 1);
    expect(mockAuthorOptions.at(-1)?.caller).toBe(options?.caller);
    expect(mockAuthorOptions.at(-1)?.sessionId).toBe(options?.caller.sessionId);
    expect(retrieval).toHaveBeenLastCalledWith(
      expect.anything(),
      'author-wiring',
      expect.objectContaining({ text: 'External coordinator request' }),
      expect.anything(),
    );
    expect(mockAuthorTurns.at(-1)).toContain('Headless planning guidance');
    const beforeRevise = mockAuthorOptions.length;
    await h.session.callTool(
      'plan_revise',
      { change: 'Revise external plan', context: 'Preserve scope' },
      callOptionsFor({ ...options.caller }),
    );
    expect(mockAuthorOptions).toHaveLength(beforeRevise + 1);
    expect(mockAuthorOptions.at(-1)?.caller).toBe(options?.caller);
    expect(mockAuthorOptions.at(-1)?.sessionId).toBe(options?.caller.sessionId);
    await h.session.send(
      'Continue the plan',
      callOptionsFor({ ...options.caller }),
    );
    expect(mockPlannerCallers.at(-1)).toBe(options.caller);
    expect(retrieval).toHaveBeenLastCalledWith(
      expect.anything(),
      'author-wiring',
      expect.objectContaining({
        text: expect.stringContaining('Revise external plan'),
      }),
      expect.anything(),
    );
  } finally {
    retrieval.mockRestore();
    setup.mockRestore();
    open.mockRestore();
  }
});

test('author gets planning knowledge and memory for the current open request', async () => {
  const search = jest.fn(async () => [
    { collection: 'planning', id: 'rule', text: 'Use the planning rule' },
  ]);
  const rag = new InMemoryRag();
  const memoryQuery = jest.spyOn(rag, 'query').mockResolvedValue({
    ok: true,
    value: [
      {
        text: 'Remember the previous decision',
        score: 1,
        metadata: {
          id: 'memory',
          sessionId: 'author-context',
          requestId: 'previous',
          sourceId: 'source',
          offset: 0,
          kind: 'planner-reply',
        },
      },
    ],
  });
  const embedding = symmetricEmbedder({
    embed: async () => ({ vector: [1, 0] }),
  });
  const setup = jest
    .spyOn(plannerMemory, 'plannerSessionOptions')
    .mockResolvedValue({
      plannerMemory: {
        rag,
        queryEmbedder: embedding,
        documentEmbedder: embedding,
      },
      plannerKnowledge: [{ name: 'planning', search }],
    });
  const retrieve = jest.spyOn(plannerMemory, 'planAuthorContextNotes');
  const open = jest.spyOn(DialogueSession, 'open');
  try {
    const h = await dialogueFor('alice', 'author-context', 'TEST');
    const author = open.mock.calls.at(-1)?.[0].planAuthor;
    const caller = open.mock.calls.at(-1)?.[0].caller;
    mockPlannerHook = async () => {
      const result = await author?.create(
        { goal: 'A different author goal' },
        caller && callOptionsFor(caller),
      );
      expect(result?.ok).toBe(true);
    };
    await h.session.send('Find objects for my request');
    await until(
      () =>
        retrieve.mock.calls.length > 0 &&
        mockAuthorTurns.some((text) => text.includes('Use the planning rule')),
    );
    expect(retrieve.mock.calls[0][2].text).toBe('Find objects for my request');
    expect(search).toHaveBeenCalledWith(
      { text: 'Find objects for my request' },
      4,
      expect.anything(),
    );
    expect(mockAuthorTurns.at(-1)).toContain('[planning knowledge]');
    expect(mockAuthorTurns.at(-1)).toContain('Remember the previous decision');
    expect(memoryQuery).toHaveBeenCalled();
  } finally {
    setup.mockRestore();
    retrieve.mockRestore();
    open.mockRestore();
  }
});

test('headless MCP opens the shared dialogue without a turn and restores interrupted tasks', async () => {
  const request = Object.assign(express.request, {
    headers: { authorization: 'Bearer test' },
  });
  const stored: HubDialogueState = {
    toolContractVersion: DIALOGUE_TOOL_CONTRACT_VERSION,
    conversation: [],
    pending: [],
    savedAt: Date.now(),
    tasks: [
      {
        id: 'running-headless',
        worker: 'executor',
        goal: 'Read',
        state: 'running',
        createdAt: 1,
      },
    ],
    plan: {
      version: 1,
      status: 'active',
      steps: [
        {
          id: 'read',
          goal: 'Read',
          state: 'running',
          taskIds: ['running-headless'],
          workTaskId: 'running-headless',
        },
      ],
    },
  };
  await getDialogueStoreBackend().save('alice', 'key', stored);
  const h = await headlessDialogueFor(request, 'alice', 'key', 'TEST');
  expect(await dialogueFor('alice', 'key', 'TEST')).toBe(h);
  expect(mockPlannerTurns).toEqual([]);
  expect(h.session.snapshot().tasks[0].state).toBe('interrupted');
  expect(dialoguePlan(h.session.snapshot())?.steps?.[0].note).toContain(
    'interrupted',
  );
  expect(mockRun).not.toHaveBeenCalled();
  const result = await h.session.callTool('plan_get', {});
  expect(result.ok).toBe(true);
  expect(
    (await getDialogueStoreBackend().load('alice', 'key'))?.tasks[0].state,
  ).toBe('interrupted');
});

test('MCP-only deferred outcomes release the inactivity hold', async () => {
  const { registry, setTime } = lifetimeRegistry();
  let finish = () => {};
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ output: 'done' });
      }),
  );
  const { h } = await ready();
  await h.session.callTool('delegate_task', {
    worker: 'executor',
    goal: 'Read',
  });
  await until(() =>
    h.session.snapshot().tasks.some((task) => task.state === 'running'),
  );
  setTime(2000);
  expect(await registry.sweep()).toBe(0);
  finish();
  await until(() =>
    h.session.snapshot().tasks.every((task) => task.state === 'done'),
  );
  expect(h.state().queuedInputs).toBeGreaterThan(0);
  setTime(3001);
  expect(await registry.sweep()).toBe(1);
});

test('synchronous steps acquire and release session leases, bind connection and exposition, and cap execution at three', async () => {
  const { h, connection } = await ready();
  const bound = new AsyncLocalStorage<IAbapConnection>();
  const binding = jest
    .mocked(runWithRequestConnection)
    .mockImplementation((conn, run) => bound.run(conn, run));
  const slots = new SemaphorePool(3);
  const hub = jest
    .spyOn(requiredExecutorPool(), 'acquire')
    .mockImplementation((signal) => slots.acquire(signal));
  const releases: jest.Mock[] = [];
  const acquire = jest.spyOn(h.pool, 'acquire').mockImplementation(async () => {
    const release = jest.fn(async () => {});
    releases.push(release);
    return {
      connection,
      system: { responsible: 'OWNER' },
      dumpScope: undefined,
      version: 1,
      release,
    };
  });
  const finishes: Array<() => void> = [];
  const step = () =>
    runWithSessionId(
      'key',
      () =>
        h.runStep(async () => {
          expect(bound.getStore()).toBe(connection);
          expect(getRequestContext()?.responsible).toBe('OWNER');
          expect(getRequestUserId()).toBe('alice');
          expect(getRequestSessionId()).toBe('key');
          expect(currentAdmission()).toBe(mockRegister);
          await new Promise<void>((resolve) => finishes.push(resolve));
          return { ok: true };
        }),
      [],
      'alice',
    );
  const calls = [step(), step(), step(), step()];
  try {
    await until(() => finishes.length === 3);
    expect(acquire).toHaveBeenCalledTimes(3);
    finishes[0]();
    await until(() => finishes.length === 4);
    finishes.forEach((finish) => {
      finish();
    });
    await Promise.all(calls);
    expect(acquire).toHaveBeenCalledTimes(4);
    for (const release of releases) expect(release).toHaveBeenCalledWith(true);
    expect(binding).toHaveBeenCalledWith(
      connection,
      expect.any(Function),
      undefined,
      ['readonly', 'search', 'system'],
    );
    expect(mockDrain).toHaveBeenCalledTimes(4);
    expect(mockRelease).toHaveBeenCalledTimes(4);
  } finally {
    finishes.forEach((finish) => {
      finish();
    });
    hub.mockRestore();
    acquire.mockRestore();
    binding.mockImplementation((_conn, run) => run());
  }
});

test('synchronous steps share the hub slot with delegated tasks and release it after failure', async () => {
  const { h } = await ready();
  let finish: (() => void) | undefined;
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ output: 'done' });
      }),
  );
  await h.session.send('go');
  await until(() => !!finish);
  let entered = false;
  const step = h.runStep(async () => {
    entered = true;
    throw new Error('step failed');
  });
  const checked = expect(step).rejects.toThrow('step failed');
  await new Promise((resolve) => setImmediate(resolve));
  expect(entered).toBe(false);
  finish?.();
  await checked;
  expect(entered).toBe(true);
  expect(await h.runStep(async () => ({ ok: true }))).toEqual({ ok: true });
});

test('allowed model switches persist across reuse and revival; omitted and foreign models keep selection', async () => {
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'A,B';
  const getAgent = jest.requireMock('../../srv/agent-manager')
    .getSmartAgent as jest.Mock;
  try {
    const first = await dialogueFor('alice', 'key', 'D', 'A');
    await first.outbox.upsert([]);
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBe('A');
    const calls = getAgent.mock.calls.length;
    // Reusing an existing dialogue must not depend on destination construction.
    getAgent.mockRejectedValueOnce(new Error('Unused rebuild'));
    expect(await dialogueFor('alice', 'key', 'D', 'B')).toBe(first);
    await dialogueFor('alice', 'key', 'D');
    await dialogueFor('alice', 'key', 'D', 'foreign');
    expect(getAgent.mock.calls).toHaveLength(calls);
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBe('B');
    getAgent.mockClear();
    // Consume the deliberately queued failure without altering the default mock.
    await expect(getAgent()).rejects.toThrow('Unused rebuild');
    await closeDialogue('alice', 'key', 'shutdown');
    const revived = await dialogueFor('alice', 'key', 'D');
    await revived.outbox.upsert([]);
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBe('B');
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test('revived dialogue reports its saved coordinator model without request or session overrides', async () => {
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'A,B';
  try {
    const first = await dialogueFor('alice', 'key', 'D', 'B');
    await first.outbox.upsert([]);
    await closeDialogue('alice', 'key', 'shutdown');
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBe('B');
    await dialogueFor('alice', 'key', 'D');
    expect(
      chatResponseModel(undefined, 'A', { userId: 'alice', key: 'key' }),
    ).toBe('B');
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test('revival drops a saved coordinator model removed from the allowlist', async () => {
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'A,B';
  try {
    const first = await dialogueFor('alice', 'key', 'D', 'B');
    await first.outbox.upsert([]);
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBe('B');
    await closeDialogue('alice', 'key', 'shutdown');
    process.env.LLM_AGENT_MODELS = 'A';
    const revived = await dialogueFor('alice', 'key', 'D');
    await revived.outbox.upsert([]);
    expect(
      (await getDialogueStoreBackend().load('alice', 'key'))?.coordinatorModel,
    ).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test.each(['returned', 'thrown'] as const)(
  'a %s planner error is sanitized in the snapshot and persisted state',
  async (mode) => {
    const { h } = await ready();
    const privateMessage = 'PRIVATE_PROVIDER_SECRET';
    const error = Object.assign(new LlmError(privateMessage), { status: 401 });
    mockPlannerHook = async () => {
      if (mode === 'thrown') throw error;
      return error;
    };

    const terminalError = {
      code: 'LLM_ERROR',
      message: 'Planner turn failed.',
      status: 401,
    };
    const sending = h.session.send('go');
    await expect(sending).rejects.toBeInstanceOf(Error);
    await h.outbox.flushed();

    const snapshot = h.session.snapshot();
    const saved = await getDialogueStoreBackend().load('alice', 'key');
    expect(JSON.stringify(snapshot)).not.toContain(privateMessage);
    expect(JSON.stringify(saved)).not.toContain(privateMessage);
    expect(snapshot.requests?.[0].terminalError).toEqual(terminalError);
    expect(saved?.requests?.[0].terminalError).toEqual(terminalError);
    await expect(sending).rejects.toMatchObject(terminalError);
  },
);

test.each(['retrieval', 'worker'] as const)(
  'an embedder HTTP 401 during %s reaches dialogue storage and SSE as safe facts',
  async (source) => {
    mockChatCoordinator = 'dialogue';
    const privateBody = 'PRIVATE_EMBEDDER_BODY';
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(privateBody, { status: 401 }),
      );
    const embedder = new OpenAiEmbedder({
      model: 'test-embedder',
      credential: { kind: 'api-key', secret: async () => 'test-key' },
    });
    const retrieval = jest.spyOn(plannerMemory, 'plannerSessionOptions');
    const startWorker = deferred<void>();
    if (source === 'retrieval') {
      retrieval.mockResolvedValue({
        plannerKnowledge: [
          {
            name: 'planning',
            async search() {
              await embedder.embed('planner input');
              return [];
            },
          },
        ],
      });
    } else {
      mockPlannerHook = async () => {
        await new PlannerToolsClient().callTool('plan_update', {
          plan: 'Read class',
          status: 'active',
        });
      };
      mockFinalAnswer = 'Started work';
      mockRun.mockImplementation(async () => {
        await startWorker.promise;
        await embedder.embed('worker input');
        return { output: 'finished' };
      });
    }
    const context = new cds.EventContext({ event: 'test' });
    context.user = new cds.User({
      id: 'alice',
      attr: {},
      roles: ['MCP_Developer'],
    });
    const previousContext = cds.context;
    cds.context = context;
    const logs = [
      jest.spyOn(cds.log('dialogue'), 'info').mockImplementation(() => {}),
      jest.spyOn(cds.log('dialogue'), 'warn').mockImplementation(() => {}),
      jest
        .spyOn(cds.log('openai-handler'), 'error')
        .mockImplementation(() => {}),
    ];
    try {
      const { h } = await ready();
      const response = fakeRes();
      const subscribe = h.subscribe.bind(h);
      if (source === 'worker') {
        jest
          .spyOn(h, 'subscribe')
          .mockImplementation((listener, cursor, consumesToolResults) => {
            const stop = subscribe(listener, cursor, consumesToolResults);
            if (consumesToolResults && response.body.includes(': turn-end\n'))
              startWorker.resolve();
            return stop;
          });
      }
      liveSession('alice', 'key');
      const req = typedRequest(
        fakeReq(
          {
            model: 'm',
            stream: true,
            messages: [{ role: 'user', content: 'go' }],
          },
          'key',
          false,
        ),
      );
      req.headers['x-sap-destination'] = 'TEST';
      req.headers.authorization = 'Bearer test';
      Object.assign(req, { longSession: longSessions().get('alice', 'key') });
      await handleChatCompletions(req, typedResponse(response));
      await h.outbox.flushed();
      const snapshot = h.session.snapshot();
      const stored = await getDialogueStoreBackend().load('alice', 'key');
      const failure = {
        code: 'EMBED_ERROR',
        status: 401,
        message: 'Embedding request failed.',
      };
      expect(fetch).toHaveBeenCalledTimes(1);
      for (const state of [snapshot, stored]) {
        expect(JSON.stringify(state)).not.toContain(privateBody);
        if (source === 'retrieval') {
          expect(state?.requests?.[0].terminalError).toEqual(failure);
        } else {
          expect(state?.tasks[0]).toMatchObject({
            error: failure.message,
            summary: failure.message,
            terminalErrorCode: failure.code,
            failure,
          });
        }
      }
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(privateBody);
      if (source === 'retrieval') {
        expect(response.body).toContain('event: error\n');
        expect(response.body).toContain('"code":"EMBED_ERROR"');
        expect(response.body).toContain(failure.message);
      } else {
        const events = fakeRes();
        const eventResponse = Object.assign(events, { flushHeaders() {} });
        Object.assign(req, { query: {} });
        try {
          await handleDialogueEvents(req, typedResponse(eventResponse));
          expect(events.body).toContain('event: tasks\n');
          expect(events.body).toContain('"terminalErrorCode":"EMBED_ERROR"');
          expect(events.body).toContain(failure.message);
          expect(events.body).not.toContain(privateBody);
        } finally {
          events.disconnect();
        }
      }
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(
        privateBody,
      );
    } finally {
      startWorker.resolve();
      fetch.mockRestore();
      retrieval.mockRestore();
      for (const log of logs) log.mockRestore();
      cds.context = previousContext;
    }
  },
);

describe.each(['returned', 'thrown'] as const)(
  '%s planner throttle',
  (mode) => {
    test.each([
      ['openai', 'JSON', handleChatCompletions, 'server_error', 500],
      ['openai', 'SSE', handleChatCompletions, 'server_error', 200],
      ['anthropic', 'JSON', handleAnthropicMessages, 'overloaded_error', 529],
      ['anthropic', 'SSE', handleAnthropicMessages, 'overloaded_error', 200],
    ] as const)(
      '%s surfaces planner throttling over %s',
      async (protocol, format, handler, errorType, status) => {
        mockChatCoordinator = 'dialogue';
        const privateMessage = 'PRIVATE_PROVIDER_SECRET';
        const error = Object.assign(new LlmError(privateMessage), {
          status: 503,
          throttled: true,
          retryAfterSeconds: 41.5,
        });
        mockPlannerHook = async () => {
          if (mode === 'thrown') throw error;
          return error;
        };

        const context = new cds.EventContext({ event: 'test' });
        context.user = new cds.User({
          id: 'alice',
          attr: {},
          roles: ['MCP_Developer'],
        });
        const priorContext = cds.context;
        const log = jest
          .spyOn(cds.log(`${protocol}-handler`), 'error')
          .mockImplementation(() => {});
        cds.context = context;
        try {
          const { h } = await ready();
          liveSession('alice', 'key');
          const stream = format === 'SSE';
          const req = typedRequest(
            fakeReq(
              {
                model: 'm',
                max_tokens: 100,
                stream,
                messages: [{ role: 'user', content: 'go' }],
              },
              'key',
              false,
            ),
          );
          req.headers['x-sap-destination'] = 'TEST';
          req.headers.authorization = 'Bearer test';
          Object.assign(req, {
            longSession: longSessions().get('alice', 'key'),
          });

          const response = fakeRes();
          await handler(req, typedResponse(response));
          expect(response.statusCode).toBe(status);
          expect(h.state().failure).toMatchObject({
            code: 'LLM_ERROR',
            status: 503,
            throttled: true,
            retryAfterSeconds: 41.5,
          });
          let body = response.body;
          if (stream) {
            const prefix = 'event: error\ndata: ';
            const errors = body
              .split('\n\n')
              .filter((event) => event.startsWith(prefix));
            expect(errors).toHaveLength(1);
            body = errors[0].slice(prefix.length);
          } else {
            expect(response.headers['Retry-After']).toBe('42');
          }
          const retryMessage =
            'The AI service is rate-limited right now. Please try again in about 42 seconds.';
          expect(JSON.parse(body)).toEqual({
            ...(protocol === 'anthropic' && { type: 'error' }),
            error: {
              code: 'LLM_ERROR',
              type: errorType,
              message: stream
                ? `LLM unavailable (HTTP 429). ${retryMessage}`
                : retryMessage,
            },
          });
          expect(response.body).not.toContain(privateMessage);
          expect(JSON.stringify(log.mock.calls)).not.toContain(privateMessage);
        } finally {
          cds.context = priorContext;
          log.mockRestore();
        }
      },
    );
  },
);

test.each([
  ['openai', handleChatCompletions, 'server_error', 500],
  ['anthropic', handleAnthropicMessages, 'overloaded_error', 529],
] as const)(
  '%s follow surfaces a background planner throttle',
  async (protocol, handler, errorType, errorStatus) => {
    mockChatCoordinator = 'dialogue';
    const privateMessage = 'Private provider failure';
    const error = Object.assign(new LlmError(privateMessage, 'LLM_ERROR'), {
      throttled: true,
      retryAfterSeconds: 41.5,
    });
    mockPlannerHook = async (text) => {
      if (text.startsWith('[task events]')) return error;
      await new PlannerToolsClient().callTool('plan_update', {
        plan: 'Read class',
        status: 'active',
      });
    };
    mockFinalAnswer = 'Started work';
    const worker = deferred<ISubAgentResult>();
    mockRun.mockReturnValue(worker.promise);

    const context = new cds.EventContext({ event: 'test' });
    context.user = new cds.User({
      id: 'alice',
      attr: {},
      roles: ['MCP_Developer'],
    });
    const priorContext = cds.context;
    const log = jest
      .spyOn(cds.log(`${protocol}-handler`), 'error')
      .mockImplementation(() => {});
    cds.context = context;
    try {
      const { h } = await ready();
      const response = fakeRes();
      const subscribe = h.subscribe.bind(h);
      jest
        .spyOn(h, 'subscribe')
        .mockImplementation((listener, cursor, consumesToolResults) => {
          const stop = subscribe(listener, cursor, consumesToolResults);
          if (consumesToolResults && response.body.includes(': turn-end\n'))
            worker.resolve({ output: 'read done' });
          return stop;
        });
      liveSession('alice', 'key');
      const req = typedRequest(
        fakeReq(
          {
            model: 'm',
            max_tokens: 100,
            stream: true,
            messages: [{ role: 'user', content: 'go' }],
          },
          'key',
          false,
        ),
      );
      req.headers['x-sap-destination'] = 'TEST';
      req.headers.authorization = 'Bearer test';
      Object.assign(req, { longSession: longSessions().get('alice', 'key') });

      await handler(req, typedResponse(response));
      expect(response.body).toContain('Started work');
      expect(response.statusCode).toBe(200);
      expect(h.state().failure).toEqual({
        cause: 'LLM unavailable (HTTP 429)',
        code: 'LLM_ERROR',
        status: 429,
        throttled: true,
        retryAfterSeconds: 41.5,
      });
      const errors = response.body
        .split('\n\n')
        .filter((event) => event.startsWith('event: error\n'));
      expect(errors).toHaveLength(1);
      expect(
        JSON.parse(errors[0].slice('event: error\ndata: '.length)),
      ).toEqual({
        ...(protocol === 'anthropic' && { type: 'error' }),
        error: {
          code: 'LLM_ERROR',
          type: errorType,
          message:
            'LLM unavailable (HTTP 429). The AI service is rate-limited right now. Please try again in about 42 seconds.',
        },
      });
      expect(response.body).not.toMatch(/\[DONE\]|event: message_stop/);
      expect(response.body).not.toContain(privateMessage);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Agent run failed',
        expect.objectContaining({ code: 'LLM_ERROR', status: errorStatus }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateMessage);
    } finally {
      cds.context = priorContext;
      log.mockRestore();
      worker.resolve({ output: 'read done' });
    }
  },
);

test.each([429, 503, 0])(
  'background planner failures retain a safe cause and worker spend (%s)',
  async (status) => {
    const { h } = await ready();
    mockRun.mockResolvedValue({
      output: 'worker finished',
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    });
    mockPlannerHook = async (text) => {
      if (text.startsWith('[task events]'))
        throw Object.assign(
          new LlmError('private model request and provider details'),
          status ? { response: { status } } : {},
        );
    };
    await h.session.send('go');
    await until(() => h.state().lastFailedSeq > 0);
    const cause = status
      ? `LLM unavailable (HTTP ${status})`
      : 'LLM unavailable (no response from model)';
    const failure = {
      cause,
      code: 'LLM_ERROR',
      status: status || undefined,
      throttled: status === 429,
    };
    expect(h.state().failure).toMatchObject(failure);
    expect(h.failedUsage?.().tasks).toEqual([
      expect.objectContaining({
        worker: 'executor',
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      }),
    ]);
    // A successful subsequent turn must not overwrite the retained failure facts.
    mockPlannerHook = undefined;
    mockPlan = { plan: 'Finished', status: 'done' };
    await h.session.send('finish');
    expect(h.state().failure).toMatchObject(failure);
    expect(h.failedUsage?.().tasks).toHaveLength(1);
  },
);

test('a background worker overflow retains its code in the task and follow outcome', async () => {
  const { h } = await ready();
  const since = h.state().settledSeq;
  const error = new LlmError(
    'private prompt and credential',
    MODEL_CONTEXT_EXCEEDED,
  );
  mockRun.mockImplementationOnce(async () => {
    throw new Error('private wrapper', { cause: error });
  });
  await h.session.send('go').catch(() => undefined);
  await until(() => h.state().lastFailedSeq > since);
  expect(h.session.snapshot().tasks).toContainEqual(
    expect.objectContaining({
      state: 'failed',
      terminalErrorCode: MODEL_CONTEXT_EXCEEDED,
      error: 'Запит перевищує контекст моделі',
    }),
  );
  const controller = new AbortController();
  const followed = followDialogue(h, {
    delivery: h.outbox.beginDelivery(),
    since,
    signal: controller.signal,
  });
  try {
    for await (const item of followed) {
      if (item.kind !== 'end') continue;
      expect(item).toMatchObject({
        reason: 'error',
        cause: 'Запит перевищує контекст моделі',
        code: MODEL_CONTEXT_EXCEEDED,
      });
    }
  } finally {
    controller.abort();
  }
});

test('a failed worker report keeps SAP diagnostics in live events and restored results', async () => {
  const { h } = await ready();
  const diagnostic = 'HTTP 400: Activation failed. Syntax error in ZCL_DEMO.';
  const summary = 'SAP rejected the class activation';
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  mockRun.mockResolvedValue({
    errorClass: 'epicfail',
    output: diagnostic,
    summary,
  });

  await h.session.send('activate');
  await until(() => h.session.snapshot().tasks[0]?.state === 'failed');
  const result = {
    state: 'failed',
    output: diagnostic,
    error: diagnostic,
    summary,
  };
  expect(h.session.snapshot().tasks[0]).toMatchObject(result);
  expect(events).toContainEqual({
    kind: 'task',
    task: expect.objectContaining({ state: 'failed', error: diagnostic }),
  });
  await until(() => h.state().running === 0);
  await h.outbox.flushed();
  const stored = await getDialogueStoreBackend().load('alice', 'key');
  expect(stored?.tasks[0]).toMatchObject(result);
});

test('a failed turn keeps planner spend observed before the failure', async () => {
  const { h } = await ready();
  mockPlannerHook = async () => {
    // A completed model call inside the planner, then a model outage.
    reportLlmSpend(
      { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      'planner-model',
    );
    throw Object.assign(new LlmError('private'), { response: { status: 503 } });
  };
  await h.session.send('go').catch(() => undefined);
  await until(() => h.state().lastFailedSeq > 0);
  expect(h.state().failure?.cause).toBe('LLM unavailable (HTTP 503)');
  expect(h.failedUsage?.().planner).toEqual({
    promptTokens: 5,
    completionTokens: 2,
    totalTokens: 7,
    models: {
      'planner-model': {
        promptTokens: 5,
        completionTokens: 2,
        totalTokens: 7,
        requests: 1,
      },
    },
  });
});

test('a later non-model failure does not inherit an earlier model cause', async () => {
  const { h } = await ready();
  mockPlannerHook = async () => {
    throw Object.assign(new LlmError('private'), { response: { status: 429 } });
  };
  await h.session.send('first').catch(() => undefined);
  await until(() => h.state().lastFailedSeq > 0);
  expect(h.state().failure?.cause).toBe('LLM unavailable (HTTP 429)');
  const failed = h.state().lastFailedSeq;
  mockPlannerHook = async () => {
    throw new Error('storage unavailable');
  };
  await h.session.send('second').catch(() => undefined);
  await until(() => h.state().lastFailedSeq > failed);
  expect(h.state().failure).toBeUndefined();
});

test.each([true, false])(
  'worker observed spend survives failure without doubling success (%s)',
  async (fails) => {
    const { h } = await ready();
    mockRun.mockImplementation(async () => {
      reportLlmSpend(
        { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        'worker-model',
      );
      if (fails) throw new Error('worker failed after model call');
      return {
        output: 'done',
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      };
    });
    mockPlannerHook = async (text) => {
      if (text.startsWith('[task events]'))
        throw new LlmError('planner failed');
    };
    await h.session.send('go');
    await until(() => h.state().lastFailedSeq > 0);
    expect(h.failedUsage?.().tasks).toEqual([
      expect.objectContaining({
        worker: 'executor',
        usage: {
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          models: {
            'worker-model': {
              promptTokens: 7,
              completionTokens: 3,
              totalTokens: 10,
              requests: 1,
            },
          },
        },
      }),
    ]);
  },
);

test('failed worker spend reaches message usage once when the planner recovers', async () => {
  const { h } = await ready();
  mockRun.mockImplementation(async () => {
    reportLlmSpend(
      { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      'worker-model',
    );
    throw new Error('worker failed');
  });
  await h.session.send('go');
  await until(() =>
    h.outbox
      .history()
      .some((message) =>
        message.usage?.tasks?.some((task) => task.usage.totalTokens === 10),
      ),
  );
  const recorded = () =>
    h.outbox.history().flatMap((message) => message.usage?.tasks ?? []);
  expect(recorded()).toHaveLength(1);
  expect(
    sumPlannerUsage(h.outbox.history().map((message) => message.usage))
      ?.totalTokens,
  ).toBeGreaterThanOrEqual(10);
  mockPlan = { plan: 'Finished', status: 'done' };
  await h.session.send('finish');
  expect(recorded()).toHaveLength(1);
});

test.each([false, true])(
  'stall-triggered coordinator turns and queued user turns do not inherit worker tool scopes (verdict: %s)',
  async (verdict) => {
    const innerCall = jest.fn(async () => ({
      ok: true as const,
      value: { content: 'called' },
    }));
    const recorder = new RecordingMcpClient({
      listTools: async () => ({
        ok: true,
        value: ['delegate_task', 'stop_task', 'caller_denied'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' as const },
        })),
      }),
      callTool: innerCall,
    });
    const { h } = await runWithToolScope(
      {
        ...captureToolScope(),
        profileTools: { allows: (name) => name !== 'caller_denied' },
      },
      () => ready(),
    );
    let stall: (() => void) | undefined;
    const originalTimer = global.setTimeout;
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 300_000)
          stall = AsyncResource.bind(() => callback(...args));
        return originalTimer(callback, delay, ...args);
      });
    let finishWorker!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    let workerChecked = false;
    mockRun.mockImplementation(() =>
      runWithVerdictTools(verdict, () =>
        runWithRequiredProfileTools(() =>
          runWithReadOnlyTools(() =>
            runWithProfileTools(
              new AgentToolPermissions(['Read']),
              async () => {
                expect(await recorder.listTools()).toEqual({
                  ok: true,
                  value: [],
                });
                expect(
                  await recorder.callTool('delegate_task', {}),
                ).toMatchObject({ value: { isError: true } });
                reportWorkerActivity('tool Read');
                workerChecked = true;
                await blocked;
                expect(verdictToolsEnabled()).toBe(verdict);
                expect(await recorder.callTool('stop_task', {})).toMatchObject({
                  value: { isError: true },
                });
                return { output: 'done' };
              },
            ),
          ),
        ),
      ),
    );
    let eventStarted = false;
    let releaseEvent!: () => void;
    const eventBlocked = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    const checked: string[] = [];
    let preparations = 0;
    mockPlannerPreparationHook = () => {
      const scope = captureToolScope();
      expect(scope.readOnlyTools).toBeUndefined();
      expect(scope.requiredProfileTools).toBeUndefined();
      expect(scope.verdictTools).toBeUndefined();
      expect(scope.profileTools?.allows('delegate_task')).toBe(true);
      expect(scope.profileTools?.allows('caller_denied')).toBe(false);
      preparations++;
    };
    mockPlannerHook = async (text) => {
      if (text.includes('start') && !text.startsWith('[task events]')) return;
      expect(getRequestSessionId()).toBe('key');
      expect(getRequestUserId()).toBe('alice');
      expect(verdictToolsEnabled()).toBe(false);
      expect(await recorder.listTools()).toMatchObject({
        value: [{ name: 'delegate_task' }, { name: 'stop_task' }],
      });
      for (const name of ['delegate_task', 'stop_task'])
        expect(await recorder.callTool(name, {})).toMatchObject({
          value: { content: 'called' },
        });
      expect(await recorder.callTool('caller_denied', {})).toMatchObject({
        value: { isError: true },
      });
      checked.push(text);
      if (text.startsWith('[task events]')) {
        eventStarted = true;
        await eventBlocked;
      } else mockPlan = { status: 'done' };
    };
    try {
      await h.session.send('start');
      await until(() => workerChecked && !!stall);
      if (!stall) throw new Error('Missing worker stall timer');
      stall();
      await until(() => eventStarted);
      const queued = h.session.send('queued');
      await runWithProfileTools(new AgentToolPermissions([]), () =>
        ready('bob'),
      );
      releaseEvent();
      await queued;
      expect(checked.some((text) => text.startsWith('[task events]'))).toBe(
        true,
      );
      expect(checked.some((text) => text.includes('queued'))).toBe(true);
      expect(innerCall).toHaveBeenCalledTimes(4);
      expect(preparations).toBeGreaterThanOrEqual(3);
    } finally {
      releaseEvent?.();
      finishWorker?.();
      timer.mockRestore();
    }
  },
);

test('worker scope emits content-free activity and background turns identify completed tasks', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  mockRun.mockImplementation(async () => {
    reportWorkerActivity('tool ReadObject');
    reportWorkerActivity('llm call');
    return { output: 'secret result' };
  });
  await turnSource.run('api', () => h.session.send('inspect'));
  await until(() =>
    events.some(
      (event) => event.kind === 'turn' && event.source === 'background',
    ),
  );
  expect(events).toContainEqual({
    kind: 'turn',
    source: 'api',
    text: 'inspect',
  });
  const activity = events.filter(
    (event) =>
      event.kind === 'activity' && !event.action.startsWith('queued ('),
  );
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({
    taskId: 't1',
    worker: 'executor',
    action: 'tool ReadObject',
  });
  expect(JSON.stringify(activity)).not.toContain('secret');
  expect(events).toContainEqual({
    kind: 'turn',
    source: 'background',
    text: 'after task t1',
  });
});

test('turn events carry the full request and its source', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  await clientTurnId.run('request-123', () =>
    turnSource.run('webui', () => h.session.send('x'.repeat(350))),
  );
  expect(events).toContainEqual({
    kind: 'turn',
    source: 'webui',
    text: 'x'.repeat(350),
    clientTurnId: 'request-123',
  });
});

test('sessions have independent queues by default and publish queued activity', async () => {
  mockExecutorPool = undefined;
  const finishes: Array<() => void> = [];
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve({ output: 'done' }));
      }),
  );
  try {
    const { h } = await ready();
    const { h: other } = await ready('bob');
    const events: DialogueEvent[] = [];
    h.subscribe((event) => events.push(event));
    expect(sharedExecutorPool()).toBeUndefined();
    for (let index = 0; index < 3; index++) {
      await h.session.callTool('delegate_task', {
        worker: 'executor',
        goal: 'Read',
      });
    }
    await until(() => finishes.length === 2);
    expect(
      events.some(
        (event) =>
          event.kind === 'activity' && event.action === 'queued (0 ahead)',
      ),
    ).toBe(true);
    await other.session.callTool('delegate_task', {
      worker: 'executor',
      goal: 'Read',
    });
    await until(() => finishes.length === 3);
    finishes.forEach((finish) => {
      finish();
    });
    await until(() => finishes.length === 4);
    finishes[3]();
    await until(() =>
      h.session.snapshot().tasks.every((task) => task.state === 'done'),
    );
    await closeDialogue('bob', 'bob-key', 'explicit');
  } finally {
    finishes.forEach((finish) => {
      finish();
    });
    mockExecutorPool = 1;
  }
});

test('hub queue labels update in snapshots without notifying the running-only board', async () => {
  mockExecutorPool = 1;
  const finishes: Array<() => void> = [];
  mockRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve({ output: 'done' }));
      }),
  );
  const { h } = await ready();
  const note = jest.spyOn(h.session, 'noteActivity');
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  try {
    for (let index = 0; index < 3; index++) {
      await h.session.callTool('delegate_task', {
        worker: 'executor',
        goal: 'Read',
      });
    }
    await until(() => finishes.length === 1);
    const queued = h.session
      .snapshot()
      .tasks.filter((task) => task.state === 'queued');
    expect(queued.map((task) => task.currentAction)).toEqual([
      'queued (0 ahead)',
      'queued (1 ahead)',
    ]);
    expect(note).not.toHaveBeenCalled();
    finishes[0]();
    await until(() => finishes.length === 2);
    expect(
      h.session.snapshot().tasks.find((task) => task.id === queued[1].id)
        ?.currentAction,
    ).toBe('queued (0 ahead)');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'activity',
        taskId: queued[1].id,
        action: 'queued (0 ahead)',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({
          id: queued[1].id,
          currentAction: 'queued (1 ahead)',
        }),
      }),
    );
    finishes[1]();
    await until(() => finishes.length === 3);
    finishes[2]();
    await until(() =>
      h.session.snapshot().tasks.every((task) => task.state === 'done'),
    );
  } finally {
    finishes.forEach((finish) => {
      finish();
    });
    note.mockRestore();
  }
});

test('closing one user session preserves the other user LLMs and signals', async () => {
  const { longSessionLlms } = await import('../../srv/lib/session-llms');
  const { h: alice } = await ready('alice');
  const { h: bob } = await ready('bob');
  const aliceOwner = longSessionLlms({ userId: 'alice', key: 'key' });
  const bobOwner = longSessionLlms({ userId: 'bob', key: 'bob-key' });
  const aliceDispose = jest.spyOn(aliceOwner, 'dispose');
  const bobDispose = jest.spyOn(bobOwner, 'dispose');
  const bobEvents: DialogueEvent[] = [];
  bob.subscribe((event) => bobEvents.push(event));
  await closeDialogue('alice', 'key', 'explicit');
  expect(aliceDispose).toHaveBeenCalled();
  expect(bobDispose).not.toHaveBeenCalled();
  expect(longSessionLlms({ userId: 'bob', key: 'bob-key' })).toBe(bobOwner);
  dialogueSignals().emit(
    'dialogue.wait',
    { tasks: [] },
    JSON.stringify(['bob', 'bob-key']),
  );
  expect(bobEvents).toEqual([{ kind: 'wait', tasks: [] }]);
  await bob.session.send('go');
  await until(() => bob.session.snapshot().tasks[0]?.state === 'done');
  expect(alice.session.snapshot().tasks).toEqual([]);
});

test.each([
  {
    output:
      '{"verdict":"pass","findings":[{"claim":"Created ZREQ","status":"confirmed","evidence":{"callId":"create"},"reason":"Result confirms the claim."}]}',
    state: 'done',
    verdict: 'pass',
  },
  {
    output: 'unusable verdict: missing or invalid findings',
    state: 'pending',
    verdict: undefined,
  },
])(
  'dialogue preserves the result of a planned check: $state',
  async ({ output, state, verdict }) => {
    const { h } = await ready();
    mockRun.mockImplementation(async (input) => ({
      output: input.task.includes('Verify') ? output : 'Created ZREQ',
    }));
    await h.session.callTool('plan_update', {
      steps: [
        { id: 'write', goal: 'Create ZREQ', result: 'report' },
        {
          id: 'check',
          goal: 'Verify',
          result: 'verdict',
          dependsOn: ['write'],
        },
      ],
    });
    const work = await h.session.callTool('delegate_task', {
      worker: 'executor',
      step_id: 'write',
      goal: 'Create ZREQ',
    });
    expect(work.ok && !work.value.isError).toBe(true);
    await until(() => h.session.snapshot().tasks[0]?.state === 'done');
    const check = await h.session.callTool('delegate_task', {
      worker: 'checker',
      step_id: 'check',
      goal: 'Verify',
    });
    expect(check.ok && !check.value.isError).toBe(true);
    await until(() => h.session.snapshot().tasks[1]?.state === 'done');
    const plan = h.session.snapshot().plan;
    if (!plan || typeof plan === 'string')
      throw new Error('Expected structured plan');
    const step = plan.steps.find(({ id }) => id === 'check');
    expect(step?.state).toBe(state);
    expect(step?.verdict).toBe(verdict);
    const taskId = h.session.snapshot().tasks[0].id;
    const delivery: {
      result?: Awaited<ReturnType<PlannerToolsClient['callTool']>>;
    } = {};
    mockPlannerHook = async () => {
      delivery.result ??= await new PlannerToolsClient().callTool('deliver', {
        task_id: taskId,
      });
    };
    mockPlan = { status: 'active' };
    await h.session.send('Deliver the result when the check allows it.');
    expect(delivery.result?.ok && !delivery.result.value.isError).toBe(
      verdict === 'pass',
    );
  },
);

test('hub dialogue sessions receive a session-scoped task result store', async () => {
  const open = jest.spyOn(DialogueSession, 'open');
  try {
    await dialogueFor('alice', 'key', 'TEST');
    const options = open.mock.calls[0]?.[0];
    expect(options?.resultStore).toBeDefined();
    const store = options?.resultStore;
    if (!store) throw new Error('Hub did not configure a task result store');
    const written = await store.put({
      id: 'wiring-test',
      worker: 'executor',
      goal: 'Verify store wiring',
      result: 'report',
      outcome: 'done',
      summary: 'Stored',
      output: 'Wired result',
    });
    if (!written.ok) throw new Error(written.error.message);
    expect(await store.read(written.value)).toEqual({
      ok: true,
      value: 'Wired result',
    });
  } finally {
    open.mockRestore();
  }
});

test('the coordinator runs on the user coordinator model over the request model', async () => {
  const { coordinatorModel } = await import('../../srv/lib/coordinator-model');
  const { setRoleModels, clearRoleModels } = await import(
    '../../srv/lib/role-model-settings'
  );
  const { effectiveRoleModels } = await import(
    '../../srv/lib/role-models-scope'
  );
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'request,user-coordinator';
  setRoleModels('alice', 'key', { coordinator: { model: 'user-coordinator' } });
  try {
    await dialogueFor('alice', 'key', 'TEST', 'request');
    mockPlannerPreparationHook = () =>
      expect(coordinatorModel()).toBe('user-coordinator');
    const { h } = await ready();
    await h.session.send('go');
    expect(effectiveRoleModels('alice', 'key').coordinator).toMatchObject({
      model: 'user-coordinator',
      source: 'user',
    });
    clearRoleModels('alice', 'key');
    expect(effectiveRoleModels('alice', 'key').coordinator).toMatchObject({
      model: 'request',
      source: 'request',
    });
  } finally {
    clearRoleModels('alice', 'key');
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test.each([
  [
    'createWorker uses the user executor model over the delegate_task model',
    'executor',
    'A',
  ],
  [
    'createWorker uses the user checker model for a verdict profile',
    'checker',
    'B',
  ],
  [
    'createWorker keeps the delegate_task model when no user setting exists',
    'none',
    'A',
  ],
])('%s', async (_name, role, expected) => {
  const { setRoleModels, clearRoleModels } = await import(
    '../../srv/lib/role-model-settings'
  );
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'A,B';
  if (role === 'executor')
    setRoleModels('alice', 'key', { executor: { model: 'A' } });
  if (role === 'checker')
    setRoleModels('alice', 'key', { checker: { model: 'B' } });
  try {
    const { h } = await ready();
    const delegated = await h.session.callTool('delegate_task', {
      worker: role === 'checker' ? 'checker' : 'executor',
      goal: 'Read',
      model: role === 'executor' ? 'B' : 'A',
    });
    if (delegated.ok && delegated.value.isError)
      throw new Error(JSON.stringify(delegated.value));
    await until(() => mockRun.mock.calls.length > 0);
    expect(mockWorkerModel).toBe(expected);
    await until(() =>
      h.session.snapshot().tasks.some((t) => t.state === 'done'),
    );
  } finally {
    clearRoleModels('alice', 'key');
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test('a user model removed from the allowlist is refused at the next worker with MODEL_NOT_ALLOWED', async () => {
  const { setRoleModels, clearRoleModels } = await import(
    '../../srv/lib/role-model-settings'
  );
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'removed';
  setRoleModels('alice', 'key', { executor: { model: 'removed' } });
  try {
    const { h } = await ready();
    await h.session.callTool('delegate_task', {
      worker: 'executor',
      goal: 'Read',
    });
    await until(() =>
      h.session.snapshot().tasks.some((t) => t.state === 'done'),
    );
    expect(mockWorkerModel).toBe('removed');
    process.env.LLM_AGENT_MODELS = '';
    mockRun.mockClear();
    await h.session.callTool('delegate_task', {
      worker: 'executor',
      goal: 'Read again',
    });
    await until(() =>
      h.session.snapshot().tasks.some((t) => t.state === 'failed'),
    );
    expect(h.session.snapshot().tasks.at(-1)?.error).toContain(
      'MODEL_NOT_ALLOWED',
    );
    expect(mockRun).not.toHaveBeenCalled();
  } finally {
    clearRoleModels('alice', 'key');
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test('session entry points replace an inherited role scope with the caller own session settings', async () => {
  const { setRoleModels, clearRoleModels } = await import(
    '../../srv/lib/role-model-settings'
  );
  const { currentRoleModel, withRoleModels } = await import(
    '../../srv/lib/role-models-scope'
  );
  const previous = process.env.LLM_AGENT_MODELS;
  process.env.LLM_AGENT_MODELS = 'alice-only,other-session';
  setRoleModels('alice', 'key', { executor: { model: 'alice-only' } });
  setRoleModels('alice', 'other-key', { executor: { model: 'other-session' } });
  try {
    const { h } = await ready();
    const { h: bob } = await ready('bob');
    await withRoleModels({ executor: { model: 'foreign' } }, async () => {
      await Promise.all([
        h.runStep(async () => {
          expect(currentRoleModel('executor')).toBe('alice-only');
          return { ok: true };
        }),
        bob.runStep(async () => {
          expect(currentRoleModel('executor')).toBeUndefined();
          return { ok: true };
        }),
      ]);
    });
  } finally {
    clearRoleModels('alice', 'key');
    clearRoleModels('alice', 'other-key');
    if (previous === undefined) delete process.env.LLM_AGENT_MODELS;
    else process.env.LLM_AGENT_MODELS = previous;
  }
});

test('closing the session clears its settings', async () => {
  const { setRoleModels, getRoleModels } = await import(
    '../../srv/lib/role-model-settings'
  );
  const { setExecutionLimits, getExecutionLimits } = await import(
    '../../srv/lib/execution-limits'
  );
  setRoleModels('alice', 'key', { executor: { model: 'gpt-5' } });
  setExecutionLimits('alice', 'key', { toolResultMaxChars: 'off' });
  setRoleModels('bob', 'bob-key', { checker: { model: 'gpt-5' } });
  await closeDialogue('alice', 'key', 'explicit');
  expect(getRoleModels('alice', 'key')).toEqual({});
  expect(getExecutionLimits('alice', 'key')).toEqual({});
  expect(getRoleModels('bob', 'bob-key')).toEqual({
    checker: { model: 'gpt-5' },
  });
});

test('dialogue forwards the same request caller through planner and worker dispatch', async () => {
  const bind = jest.spyOn(getHubRagAccess().access.bindings, 'bind');
  const result = await bindCaller('key', 'alice', false);
  if (!result.ok) throw result.error;
  const { h } = await ready('alice', result.value);
  expect(bind).toHaveBeenCalledTimes(1);
  await h.session.send('go', callOptionsFor(result.value));
  await until(() => mockRun.mock.calls.length > 0);
  expect(mockPlannerCallers[0]).toBe(result.value);
  expect(mockRun.mock.calls[0][0].caller).toBe(result.value);
  expect(mockRun.mock.calls[0][0].sessionId).toBe(result.value.sessionId);
});

test.each(['off', 'on'] as const)(
  'dialogue %s excludes saved transcript history and selects its explicit history source',
  async (policy) => {
    mockClientHistory = policy;
    const caller = isolationCallers[0];
    const history = new SessionHistoryRouter(
      new InMemoryRagProvider({ name: 'exclusive-dialogue' }),
    );
    mockIsolationHistory = history;
    const prompts: import('@mcp-abap-adt/llm-agent').Message[][] = [];
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async (messages) => {
          prompts.push(messages);
          return {
            ok: true,
            value: { content: 'Plain answer', finishReason: 'stop' },
          };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const h = await dialogueFor(caller.userId, caller.sessionId, 'TEST');
    try {
      await h.session.send('SERVER_TRANSCRIPT_ONLY');
      await history.waitForTurns(caller.sessionId);
      await history.forgetSessionHistory(caller.sessionId);
      await history.recordTurn({
        caller,
        userText: 'Recall',
        assistantText: 'HISTORY_RAG_ONLY',
      });
      prompts.length = 0;
      const channel = dialogueChat(
        typedRequest(fakeReq({})),
        caller.userId,
        {
          userId: caller.userId,
          key: caller.sessionId,
          createdAt: 0,
          lastActivity: 0,
          revived: false,
        },
        'TEST',
        typedResponse(fakeRes()),
      );
      const messages =
        policy === 'on'
          ? [
              { role: 'user' as const, content: 'CONSUMER_ONLY' },
              { role: 'assistant' as const, content: 'Consumer answer' },
              { role: 'user' as const, content: 'Recall' },
            ]
          : [{ role: 'user' as const, content: 'Recall' }];
      const toolCall: import('@mcp-abap-adt/llm-agent').Message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'active-read',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      };
      const result = await channel.process(
        [
          ...messages,
          toolCall,
          {
            role: 'tool',
            tool_call_id: 'active-read',
            content: 'CURRENT_CLIENT_LOOP',
          },
        ],
        callOptionsFor(caller),
      );
      if (!result.ok) throw result.error;
      const prompt = JSON.stringify(prompts);
      expect(prompt).not.toContain('SERVER_TRANSCRIPT_ONLY');
      expect(prompt.includes('CONSUMER_ONLY')).toBe(policy === 'on');
      expect(prompt.includes('HISTORY_RAG_ONLY')).toBe(policy === 'off');
      expect(prompt).toContain('CURRENT_CLIENT_LOOP');
      expect(prompts.flat()).toContainEqual(toolCall);
    } finally {
      await closeDialogue(caller.userId, caller.sessionId, 'ttl');
    }
  },
);

test.each(
  (['off', 'on'] as const).flatMap((policy) =>
    [false, true].flatMap((newRequest) =>
      (['done', 'stall', 'long_running'] as const).map((event) => ({
        policy,
        newRequest,
        event,
      })),
    ),
  ),
)(
  'late A $event event retains only A work after B finishes ($policy, new request: $newRequest), without history RAG',
  async ({ policy, newRequest, event }) => {
    mockClientHistory = policy;
    expect(mockIsolationHistory).toBeUndefined();
    mockLongTaskMs = event === 'long_running' ? 1_234_567 : undefined;
    const prompts: import('@mcp-abap-adt/llm-agent').Message[][] = [];
    let stall: (() => void) | undefined;
    let longRunning: (() => void) | undefined;
    const originalTimer = global.setTimeout;
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 300_000)
          stall = AsyncResource.bind(() => callback(...args));
        if (delay !== undefined && delay > 1_200_000 && delay <= 1_234_567)
          longRunning = AsyncResource.bind(() => callback(...args));
        return originalTimer(callback, delay, ...args);
      });
    let finish!: () => void;
    mockRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          reportWorkerActivity('tool Read');
          finish = () => resolve({ output: 'TASK_A_FINISHED' });
        }),
    );
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async (messages) => {
          prompts.push(structuredClone(messages));
          const tools = new PlannerToolsClient();
          if (prompts.length === 1) {
            const delegated = await tools.callTool('delegate_task', {
              worker: 'executor',
              goal: 'IN_FLIGHT_A',
            });
            if (!delegated.ok || delegated.value.isError)
              throw new Error('delegation failed');
          } else if (prompts.length === 2 && newRequest) {
            const restarted = await tools.callTool('new_request', {});
            if (!restarted.ok || restarted.value.isError)
              throw new Error('new request failed');
          }
          const prompt = JSON.stringify(messages);
          return {
            ok: true,
            value: {
              content: prompt.includes('[task events]')
                ? 'A_EVENT_ANSWER'
                : prompt.includes('CLIENT_B')
                  ? 'B_ANSWER'
                  : 'A_IN_FLIGHT_ANSWER',
              finishReason: 'stop',
            },
          };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const { h } = await ready();
    const clientLoop: import('@mcp-abap-adt/llm-agent').Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'a-read',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'a-read', content: 'A_CLIENT_LOOP' },
    ];
    try {
      const first = await clientTurnMessages.run(
        [
          { role: 'user', content: 'A_CONSUMER_HISTORY' },
          { role: 'assistant', content: 'A_CONSUMER_ANSWER' },
          {
            role: 'user',
            content: 'CLIENT_A ORIGINAL_REQUEST: only read ZSAFE; never write',
          },
          ...clientLoop,
        ],
        () =>
          h.session.send(
            'CLIENT_A ORIGINAL_REQUEST: only read ZSAFE; never write',
          ),
      );
      expect(first.text).toBe('A_IN_FLIGHT_ANSWER');
      await until(() => !!finish);
      const second = await h.session.send('CLIENT_B');
      expect(second.text).toBe('B_ANSWER');
      const eventStart = prompts.length;
      if (event === 'stall') {
        if (!stall) throw new Error('Missing real worker stall callback');
        stall();
      } else if (event === 'long_running') {
        if (!longRunning) throw new Error('Missing real long-running callback');
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1_234_567);
        try {
          longRunning();
        } finally {
          clock.mockRestore();
        }
      } else finish();
      await until(() =>
        h.outbox.history().some((message) => message.text === 'A_EVENT_ANSWER'),
      );
      await h.outbox.flushed();
      const eventPrompts = prompts.slice(eventStart);
      expect(eventPrompts.length).toBeGreaterThan(0);
      for (const messages of eventPrompts) {
        const prompt = JSON.stringify(messages);
        expect(prompt).toContain('CLIENT_A');
        expect(prompt).toContain(
          'ORIGINAL_REQUEST: only read ZSAFE; never write',
        );
        expect(prompt).toContain('A_IN_FLIGHT_ANSWER');
        expect(prompt).toContain('IN_FLIGHT_A');
        expect(prompt).toContain('[task events]');
        expect(prompt).toContain('A_CLIENT_LOOP');
        expect(messages).toContainEqual(clientLoop[0]);
        expect(prompt.includes('A_CONSUMER_HISTORY')).toBe(policy === 'on');
        expect(prompt.includes('A_CONSUMER_ANSWER')).toBe(policy === 'on');
        expect(prompt).not.toContain('CLIENT_B');
        expect(prompt).not.toContain('B_ANSWER');
      }
      if (event === 'stall') {
        expect(h.session.snapshot().tasks[0].state).toBe('running');
        expect(JSON.stringify(eventPrompts)).toContain('no activity for');
        expect(JSON.stringify(eventPrompts)).toContain('tool Read');
      } else if (event === 'long_running') {
        expect(h.session.snapshot().tasks[0].state).toBe('running');
        expect(JSON.stringify(eventPrompts)).toContain(
          'is still running after',
        );
      }
    } finally {
      mockLongTaskMs = undefined;
      timer.mockRestore();
      finish?.();
    }
  },
);

test.each(['off', 'on'] as const)(
  'dialogue %s distinguishes fresh requests from tool-result replays',
  async (policy) => {
    mockClientHistory = policy;
    const caller = isolationCallers[0];
    const history = new SessionHistoryRouter(
      new InMemoryRagProvider({ name: 'dialogue-turn-identity' }),
    );
    mockIsolationHistory = history;
    const prompts: string[] = [];
    let answer = '';
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async (messages) => {
          prompts.push(JSON.stringify(messages));
          return { ok: true, value: { content: answer, finishReason: 'stop' } };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const send = async (
      messages: import('@mcp-abap-adt/llm-agent').Message[],
      reply: string,
    ) => {
      answer = reply;
      const channel = dialogueChat(
        typedRequest(fakeReq({})),
        caller.userId,
        {
          userId: caller.userId,
          key: caller.sessionId,
          createdAt: 0,
          lastActivity: 0,
          revived: false,
        },
        'TEST',
        typedResponse(fakeRes()),
      );
      const result = await channel.process(messages, callOptionsFor(caller));
      if (!result.ok) throw result.error;
    };
    const user = { role: 'user' as const, content: 'status?' };
    const loop: import('@mcp-abap-adt/llm-agent').Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'status-read',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'status-read',
        content: 'CURRENT_TOOL_RESULT',
      },
    ];
    try {
      await send([user], 'First status');
      await send([user], 'Second status');
      await send([user, ...loop], 'Status after read');
      const freshPrefix = {
        role: 'assistant' as const,
        content: 'FRESH_CLIENT_PREFIX',
      };
      await send(
        policy === 'on' ? [freshPrefix, user, ...loop] : [user, ...loop],
        'Replay status',
      );
      await history.waitForTurns(caller.sessionId);
      const turns = await history.listTurns(caller);
      expect(turns.map((turn) => turn.assistantText).sort()).toEqual([
        'First status',
        'Second status',
        'Status after read',
      ]);
      expect(prompts.at(-1)).toContain('CURRENT_TOOL_RESULT');
      expect(prompts.at(-1)?.includes('FRESH_CLIENT_PREFIX')).toBe(
        policy === 'on',
      );
    } finally {
      await closeDialogue(caller.userId, caller.sessionId, 'ttl');
      await history.stopWrites();
    }
  },
);

test.each(['direct', 'api', 'api-stream', 'api-disconnect'] as const)(
  '%s dialogue sends store full turns once, independently of delivery history',
  async (mode) => {
    const caller = isolationCallers[0];
    const history = new SessionHistoryRouter(
      new InMemoryRagProvider({ name: 'dialogue-history' }),
    );
    mockIsolationHistory = history;
    const record = jest.spyOn(history, 'recordTurn');
    const res = fakeRes();
    const finalAnswer = 'Full final answer. '.repeat(700);
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async () => {
          if (mode === 'api-disconnect') res.disconnect();
          return {
            ok: true,
            value: { content: finalAnswer, finishReason: 'stop' },
          };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const text = 'Full original request. '.repeat(400);
    const h = await dialogueFor(caller.userId, caller.sessionId, 'TEST');
    const send = jest.spyOn(h.session, 'send');
    try {
      const previous = 'Already stored reply from a previous turn';
      await h.outbox.upsert([
        { id: 'previous', text: previous, trigger: 'event', createdAt: 1 },
      ]);
      if (mode === 'direct') await h.session.send(text);
      else {
        const channel = dialogueChat(
          typedRequest(fakeReq({})),
          caller.userId,
          {
            userId: caller.userId,
            key: caller.sessionId,
            createdAt: 0,
            lastActivity: 0,
            revived: false,
          },
          'TEST',
          typedResponse(res),
        );
        const messages = [{ role: 'user' as const, content: text }];
        if (mode === 'api') {
          const result = await channel.process(
            messages,
            callOptionsFor(caller),
          );
          if (!result.ok) throw result.error;
          expect(result.value.content).toContain(previous);
          expect(result.value.content).toContain(finalAnswer);
        } else {
          let delivered = '';
          for await (const chunk of channel.streamProcess(
            messages,
            callOptionsFor(caller),
          )) {
            if (!chunk.ok) throw chunk.error;
            delivered += chunk.value.content ?? '';
          }
          expect(delivered).toContain(previous);
          expect(delivered).toContain(finalAnswer);
        }
      }
      expect(send).toHaveBeenCalledTimes(1);
      const answer = await send.mock.results[0].value;
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        caller: expect.objectContaining(caller),
        userText: text,
        assistantText: answer.text,
        id: expect.stringMatching(/^dialogue:/),
      });
      await history.query(
        new TextOnlyEmbedding(text),
        5,
        callOptionsFor(caller),
      );
      expect(await history.listTurns(caller)).toEqual([
        expect.objectContaining({ userText: text, assistantText: answer.text }),
      ]);
      expect(answer.text).toContain(finalAnswer);
    } finally {
      await closeDialogue(caller.userId, caller.sessionId, 'ttl');
    }
  },
);

test.each([
  { initialReply: 'NO_MESSAGE', profileFails: false },
  { initialReply: 'Initial reply; work is still running', profileFails: false },
  { initialReply: 'Initial reply; work is still running', profileFails: true },
])(
  'records the late dialogue final once after $initialReply (profile fails: $profileFails)',
  async ({ initialReply, profileFails }) => {
    const caller = ragCaller;
    const history = new SessionHistoryRouter(
      new InMemoryRagProvider({ name: 'late-dialogue-history' }),
    );
    mockIsolationHistory = history;
    const record = jest.spyOn(history, 'recordTurn');
    let finish!: () => void;
    if (profileFails) {
      mockWorkerPreparationHook = () =>
        new Promise((_, reject) => {
          finish = () =>
            reject(new Error('Worker profile could not be loaded'));
        });
    } else {
      mockRun.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ output: 'Worker finished' });
          }),
      );
    }
    let calls = 0;
    const finalAnswer = profileFails
      ? 'Task A failed because the worker profile could not be loaded.'
      : 'FINAL_EVENT_ANSWER: all original constraints were preserved.';
    const secondAnswer = 'Answer to the next user turn.';
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async (messages) => {
          calls++;
          if (calls === 1) {
            const delegated = await new PlannerToolsClient().callTool(
              'delegate_task',
              {
                worker: 'executor',
                goal: 'Read ZSAFE',
              },
            );
            if (!delegated.ok || delegated.value.isError)
              throw new Error('delegation failed');
          }
          const nextTurn = messages.some(
            ({ content }) =>
              typeof content === 'string' && content.includes('CLIENT_B'),
          );
          return {
            ok: true,
            value: {
              content:
                calls === 1
                  ? initialReply
                  : nextTurn
                    ? secondAnswer
                    : finalAnswer,
              finishReason: 'stop',
            },
          };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const opened = jest.spyOn(DialogueSession, 'open');
    const { h } = await ready(caller.userId);
    const text = 'ORIGINAL_REQUEST: only read table ZSAFE; never write.';
    try {
      const first = await clientTurnId.run('stable-late-turn', () =>
        h.session.send(text),
      );
      expect(first.text).toContain(initialReply);
      await until(() => !!finish);
      expect(record).not.toHaveBeenCalled();
      finish();
      await until(() => record.mock.calls.length === 1);
      await h.outbox.flushed();
      if (profileFails) {
        expect(h.session.snapshot().tasks[0]).toMatchObject({
          state: 'failed',
          error: expect.stringContaining('Worker profile could not be loaded'),
        });
        expect(mockRun).not.toHaveBeenCalled();
      }
      const final = h.outbox
        .history()
        .find((message) => message.text === finalAnswer);
      expect(final).toBeDefined();
      if (!final) throw new Error('late final answer was not delivered');
      // Delivery replay and a repeated client turn ID must not write another turn.
      const onMessage = opened.mock.calls.at(-1)?.[0].onMessage;
      onMessage?.(final);
      onMessage?.(final);
      await clientTurnId.run('stable-late-turn', () => h.session.send(text));
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        caller: expect.objectContaining(caller),
        userText: text,
        assistantText: finalAnswer,
        id: 'dialogue:stable-late-turn',
      });
      if (profileFails) {
        await clientTurnId.run('next-turn', () => h.session.send('CLIENT_B'));
        expect(record).toHaveBeenCalledTimes(2);
        expect(record).toHaveBeenLastCalledWith({
          caller: expect.objectContaining(caller),
          userText: 'CLIENT_B',
          assistantText: secondAnswer,
          id: 'dialogue:next-turn',
        });
      }
      await history.query(
        new TextOnlyEmbedding(text),
        5,
        callOptionsFor(caller),
      );
      const persisted = await history.listTurns(caller);
      expect(persisted).toHaveLength(profileFails ? 2 : 1);
      expect(persisted).toContainEqual(
        expect.objectContaining({
          id: 'dialogue:stable-late-turn',
          userText: text,
          assistantText: finalAnswer,
        }),
      );
    } finally {
      finish?.();
      opened.mockRestore();
      await closeDialogue(caller.userId, caller.sessionId, 'ttl');
    }
  },
);

test.each(
  ['NO_MESSAGE', 'Initial reply; work is still running'].flatMap(
    (initialReply) =>
      [1, 2].flatMap((taskCount) =>
        [false, true].map((correctionFails) => ({
          initialReply,
          taskCount,
          correctionFails,
        })),
      ),
  ),
)(
  'records each turn once when B consumes A tasks ($taskCount tasks, $initialReply, correction fails: $correctionFails)',
  async ({ initialReply, taskCount, correctionFails }) => {
    const caller = ragCaller;
    const history = new SessionHistoryRouter(
      new InMemoryRagProvider({ name: 'corrected-dialogue-history' }),
    );
    mockIsolationHistory = history;
    const record = jest.spyOn(history, 'recordTurn');
    const finishes = new Map<string, () => void>();
    const taskAnswers = Array.from(
      { length: taskCount },
      (_, i) => `TASK_A_${i}: ${'Full worker result. '.repeat(4000)}END_A_${i}`,
    );
    mockRun.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          const index = Number(input.task.split(' ').at(-1));
          finishes.set(input.task, () =>
            resolve({ output: taskAnswers[index] }),
          );
        }),
    );
    const prompts: string[] = [];
    const finalAnswer = 'Final A and B: all work completed.';
    let calls = 0;
    let completeTasks = async () => {};
    mockCaptureLlm = async () => {
      const llm: ILlm = {
        chat: async (messages) => {
          prompts.push(messages.map((message) => message.content).join('\n'));
          calls++;
          const tools = new PlannerToolsClient();
          if (calls === 1) {
            for (let i = 0; i < taskCount; i++) {
              const delegated = await tools.callTool('delegate_task', {
                worker: 'executor',
                goal: `Read ZSAFE ${i}`,
              });
              if (!delegated.ok || delegated.value.isError)
                throw new Error('delegation failed');
            }
          } else if (calls === 2) {
            await completeTasks();
            const plan = await tools.callTool('plan_update', {
              plan: 'Review A results and answer B',
              status: 'active',
            });
            if (!plan.ok || plan.value.isError)
              throw new Error('plan update failed');
          } else if (calls === 3) {
            if (correctionFails) throw new Error('B correction failed');
            const plan = await tools.callTool('plan_update', {
              status: 'done',
            });
            if (!plan.ok || plan.value.isError)
              throw new Error('final plan update failed');
          }
          return {
            ok: true,
            value: {
              content:
                calls === 1
                  ? initialReply
                  : calls === 2
                    ? 'Draft B before reviewing task events'
                    : finalAnswer,
              finishReason: 'stop',
            },
          };
        },
        async *streamChat(messages, tools, options) {
          yield await llm.chat(messages, tools, options);
        },
      };
      return llm;
    };
    const { h } = await ready(caller.userId);
    const events: DialogueEvent[] = [];
    h.subscribe((event) => events.push(event));
    completeTasks = async () => {
      for (let i = 0; i < taskCount; i++) {
        const goal = `Read ZSAFE ${i}`;
        await until(() => finishes.has(goal));
        finishes.get(goal)?.();
        await until(() =>
          h.session
            .snapshot()
            .tasks.some((task) => task.goal === goal && task.state === 'done'),
        );
        expect(record).not.toHaveBeenCalled();
      }
    };
    try {
      const first = await clientTurnId.run('correction-A', () =>
        h.session.send('CLIENT_A'),
      );
      expect(first.text).toBe(initialReply);
      expect(record).not.toHaveBeenCalled();
      const sendB = () =>
        clientTurnId.run('correction-B', () => h.session.send('CLIENT_B'));
      if (correctionFails) {
        await expect(sendB()).rejects.toMatchObject({
          code: 'LLM_ERROR',
          message: 'Planner turn failed.',
        });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0][0].userText).toBe('CLIENT_A');
      }
      const second = await sendB();
      expect(second.text).toBe(finalAnswer);
      expect(calls).toBe(correctionFails ? 4 : 3);
      expect(prompts[2]).toContain('[check]');
      expect(prompts[2]).toContain('[task events]');
      expect(h.state().running).toBe(0);
      expect(h.state().queuedInputs).toBe(0);
      expect(
        events
          .filter((event) => event.kind === 'turn')
          .map((event) => event.source),
      ).toEqual(correctionFails ? ['mcp', 'mcp', 'mcp'] : ['mcp', 'mcp']);
      expect(record).toHaveBeenCalledTimes(2);
      const expected = [
        {
          id: 'dialogue:correction-A',
          userText: 'CLIENT_A',
          assistantText: taskAnswers.join('\n\n'),
        },
        {
          id: 'dialogue:correction-B',
          userText: 'CLIENT_B',
          assistantText: finalAnswer,
        },
      ];
      for (const turn of expected)
        expect(record).toHaveBeenCalledWith({
          caller: expect.objectContaining(caller),
          ...turn,
        });
      expect(h.session.snapshot().tasks[0].output).toBe(taskAnswers[0]);
      await history.query(
        new TextOnlyEmbedding('CLIENT_A CLIENT_B'),
        5,
        callOptionsFor(caller),
      );
      expect(await history.listTurns(caller)).toEqual(
        expected.map((turn) => expect.objectContaining(turn)),
      );
      await clientTurnId.run('correction-A', () => h.session.send('CLIENT_A'));
      await clientTurnId.run('correction-B', () => h.session.send('CLIENT_B'));
      await h.drainPending();
      await h.outbox.flushed();
      expect(record).toHaveBeenCalledTimes(2);
    } finally {
      await closeDialogue(caller.userId, caller.sessionId, 'ttl');
    }
  },
);
