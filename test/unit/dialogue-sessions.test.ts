import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import express from 'express';
import { executeRagTool } from '../../srv/agent-mcp-rag';
import { chatStream, streamDialogue } from '../../srv/lib/chat-stream';
import { dialogueChat } from '../../srv/lib/dialogue-chat';
import { followDialogue } from '../../srv/lib/dialogue-follow';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { sumPlannerUsage } from '../../srv/lib/usage-wire';
import { CollectionRegistry } from '../../srv/rag-collections';
import { liveSession } from './helpers/canonical-rag';

jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: jest.fn(async () => ({
    authenticationType: 'BasicAuthentication',
  })),
}));

import {
  LongSessionRegistry,
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
  ISubAgentInput,
  ISubAgentResult,
  TokenUsage,
  ToolTrace,
} from '@mcp-abap-adt/llm-agent';
import {
  PlannerToolsClient,
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
  lookupDialogue,
  onDialogueCreated,
  sharedExecutorPool,
} from '../../srv/lib/dialogue-sessions';
import { dialogueSignals } from '../../srv/lib/dialogue-signals';
import {
  getDialogueStoreBackend,
  hasDialogueState,
} from '../../srv/lib/dialogue-store';
import { evaluateGated } from '../../srv/lib/step-reviewer';
import {
  getRagCallerIdentity,
  getRequestHistory,
  getRequestSessionId,
  getRequestUserId,
  runWithSessionId,
} from '../../srv/request-session';

const mockRun = jest.fn<Promise<ISubAgentResult>, [ISubAgentInput]>();
const mockRelease = jest.fn();
const mockDrain = jest.fn(async () => {});
const mockDrop = jest.fn();
const mockPlannerTurns: string[] = [];
const mockEnvironments: string[] = [];
let mockGoal = 'read';
let mockPlannerHook: ((text: string) => Promise<void>) | undefined;
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
const mockRegister = { track: <T>(p: Promise<T>) => p };
jest.mock('../../srv/agent-config', () => ({
  ...jest.requireActual('../../srv/agent-config'),
  getAgentConfig: () => ({
    ...jest.requireActual('../../srv/agent-config').getAgentConfig(),
    agent: {
      dialogue: {
        executors: 2,
        executorPool: 1,
        maxTasks: 50,
        maxCorrections: 2,
      },
    },
  }),
}));
jest.mock('../../srv/agent-manager', () => ({
  getProviders: () => ({ embedding: undefined }),
  forgetPlannerMemory: jest.fn(async () => true),
  releasePlannerAgent: jest.fn(),
  setSessionDestination: jest.fn(),
  createAgentProfileSource: () => ({
    list: async () => ({
      ok: true,
      value: [{ name: 'executor', description: '', result: 'report' }],
    }),
    get: async () => ({
      ok: true,
      value: {
        name: 'executor',
        description: '',
        systemPrompt: '',
        tools: 'all',
        result: 'report',
      },
    }),
    getPrompts: async () => ({
      ok: true,
      value: { workerBase: '', planner: '' },
    }),
  }),
  buildPlannerAgent: jest.fn(async () => ({
    process: async (messages: { content: string }[]) => {
      mockEnvironments.push(
        messages.find((m) => m.content.startsWith('[environment]'))?.content ??
          '',
      );
      const input = messages.at(-1)?.content ?? '';
      const text = input.includes('[task events]')
        ? input.slice(input.indexOf('[task events]'))
        : input;
      mockPlannerTurns.push(text);
      await mockPlannerHook?.(text);
      if (mockPlan) {
        await new PlannerToolsClient().callTool('update_plan', mockPlan);
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
      return {
        ok: true,
        value: {
          content: text.startsWith('[task events]') ? text : 'delegated',
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
  })),
  getSmartAgent: jest.fn(async () => ({
    profileRunner: {
      createWorker: async () => ({
        ok: true,
        value: {
          name: 'executor',
          capabilities: { contextPolicy: 'optional' },
          run: (input: ISubAgentInput) => mockRun(input),
        },
      }),
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
      getToolRecords: () => [],
      dropRequest: (id: string) => mockDrop(id),
    },
    criticLlm: {},
  })),
  runWithRequestConnection: jest.fn((_c: unknown, fn: () => unknown) => fn()),
}));
jest.mock('../../srv/lib/gatekeeper', () => ({
  leaseSession: () => ({ release() {} }),
  admitBackground: jest.fn(async () => ({
    admitted: {
      run: (fn: () => unknown) => runWithAdmission(mockRegister, fn),
      drain: () => mockDrain(),
      release: () => mockRelease(),
    },
  })),
}));
jest.mock('../../srv/lib/step-reviewer', () => ({
  evaluateGated: jest.fn(async () => ({ ok: true })),
}));

async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}
async function ready(user = 'alice') {
  const h = await dialogueFor(user, 'key', 'TEST');
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
  jest.clearAllMocks();
  mockPlannerTurns.length = 0;
  mockEnvironments.length = 0;
  mockGoal = 'read';
  mockPlannerHook = undefined;
  mockPlanUsage = undefined;
  mockPlan = undefined;
  mockRun.mockReset().mockResolvedValue({ output: 'read done' });
  jest.mocked(evaluateGated).mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await closeDialogue('alice', 'key', 'ttl');
  await closeDialogue('bob', 'key', 'ttl');
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
      ).toEqual(['plan', 'message', 'settled']);
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
    expect(events).toEqual([]);
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
    ['key', 'failed', 1, 1],
    ['other', 'failed', 1, 1],
    ['key', 'ok', 2, 1],
    ['key', 'failed', 3, 3],
    ['key', 'ok', 4, 3],
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
    'key',
  );
  const activity = { turnActive: false, queuedInputs: 1, running: 0, ready: 0 };
  bus.emit('dialogue.activity', activity, 'key');
  expect(h.state().idle).toBe(false);
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, ready: 1 },
    'key',
  );
  expect(h.state().idle).toBe(false);
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, turnActive: true },
    'key',
  );
  expect(h.state()).toMatchObject({ turnActive: true, idle: false });
  bus.emit(
    'dialogue.activity',
    { ...activity, queuedInputs: 0, running: 1 },
    'key',
  );
  expect(h.state()).toMatchObject({ running: 1, idle: false });
  bus.emit('dialogue.activity', { ...activity, queuedInputs: 0 }, 'key');
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
    dialogueFor('bob', 'key', 'TEST'),
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
  const release = await sharedExecutorPool().acquire();
  release();
  const lease = await h.pool.acquire();
  expect(lease.connection).toBe(connection);
  await lease.release(true);
});
test('honesty notice reaches task output and planner', async () => {
  const { h } = await ready();
  const events: DialogueEvent[] = [];
  h.subscribe((event) => events.push(event));
  const usage = { promptTokens: 7, completionTokens: 4, totalTokens: 11 };
  mockRun.mockResolvedValue({ output: 'read done', usage });
  jest.mocked(evaluateGated).mockResolvedValue({
    ok: false,
    issues: [
      {
        kind: 'unsupported-claim',
        confidence: 'high',
        reasons: 'unsupported',
      },
    ],
  });
  await h.session.send('go');
  await until(() => h.outbox.pending().length > 0);
  expect(h.session.snapshot().tasks[0].output).toContain('UNVERIFIED_WRITE:');
  expect(h.outbox.pending()[0].text).toContain('UNVERIFIED_WRITE:');
  expect(h.session.snapshot().tasks[0].usage).toEqual(usage);
  expect(h.outbox.pending()[0].usage).toEqual({
    plannerMs: expect.any(Number),
    planner: {
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
    tasks: [
      {
        id: h.session.snapshot().tasks[0].id,
        worker: 'executor',
        usage,
        durationMs: expect.any(Number),
      },
    ],
  });
  expect(events.find((event) => event.kind === 'message')).toEqual({
    kind: 'message',
    message: h.outbox.pending()[0],
  });
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
  const built = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: {
      maxIterations: 100,
      classificationEnabled: false,
      ragTranslateEnabled: false,
      heartbeatIntervalMs: 1,
    },
  })
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
    .build();
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
  const release = await sharedExecutorPool().acquire();
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
  const releasePool = await sharedExecutorPool().acquire();
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
    expect(registry.get('alice', 'key')?.lastActivity).toBe(0);
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
    ).process([{ role: 'user', content: 'go' }]);
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
    if (!reply || reply.kind !== 'message') throw new Error('Missing reply');
    const update = events.find(
      (event) => event.kind === 'usage' && event.id === reply.message.id,
    );
    if (!update || update.kind !== 'usage')
      throw new Error('Missing usage update');
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

test.each([true, false])(
  'reviewer usage is included in task usage for verdict ok=%s',
  async (ok) => {
    const { h } = await ready();
    mockRun.mockResolvedValue({
      output: 'read done',
      usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
    });
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    jest.mocked(evaluateGated).mockResolvedValue(
      ok
        ? { ok: true, usage }
        : {
            ok: false,
            usage,
            issues: [
              {
                kind: 'unsupported-claim',
                confidence: 'high',
                reasons: 'test',
              },
            ],
          },
    );
    await h.session.send('go');
    await until(() => h.session.snapshot().tasks[0]?.state === 'done');
    expect(h.session.snapshot().tasks[0].usage).toMatchObject({
      promptTokens: 9,
      completionTokens: 5,
      totalTokens: 14,
    });
  },
);

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
  dialogueSignals().emit('dialogue.wait', { tasks }, 'key');
  expect(events).toEqual([{ kind: 'wait', tasks }]);
  const replay: DialogueEvent[] = [];
  h.subscribe((event) => replay.push(event));
  expect(replay).toEqual([]);
  expect(h.outbox.pending()).toEqual([]);
  await closeDialogue('alice', 'key', 'explicit');
  dialogueSignals().emit('dialogue.wait', { tasks }, 'key');
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
  const allowed: boolean[] = [];
  mockPlannerHook = async (text: string) => {
    if (text.startsWith('[task events]')) return;
    const identity = getRagCallerIdentity();
    channels.push(identity.channel);
    const result = await executeRagTool(
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
    allowed.push(!result.isError);
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
  expect(allowed).toEqual([true, false]);
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

test('queued background tasks keep their scheduling turn identity across later callers', async () => {
  const { h } = await ready();
  const release = await sharedExecutorPool().acquire();
  const identities: { admin: boolean; channel: string }[] = [];
  mockRun.mockImplementation(async () => {
    const { admin, channel } = getRagCallerIdentity();
    identities.push({ admin, channel });
    return { output: 'done' };
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
    release();
  }
  await until(() => identities.length === 2);
  expect(identities).toEqual([
    { admin: true, channel: 'anthropic' },
    { admin: false, channel: 'openai' },
  ]);
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

test.each([
  { reconnect: false, isError: false },
  { reconnect: true, isError: false },
  { reconnect: false, isError: true },
  { reconnect: true, isError: true },
  { reconnect: true, isError: false, initial: true },
])(
  'worker RAG result reaches the active stream once (reconnect: $reconnect, error: $isError)',
  async ({ reconnect, isError, initial }) => {
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
      await new PlannerToolsClient().callTool('update_plan', {
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
        source: agent.streamProcess([{ role: 'user', content: 'go' }]),
        run: (fn) =>
          runWithSessionId('key', fn, [], 'alice', {
            admin: false,
            channel: 'openai',
            onToolResult: originalSink,
          }),
        maxMs: 10000,
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
      const first = await fetch(url, { signal: controller.signal });
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
        response = await fetch(url);
        await until(() => followers >= (initial ? 3 : 4));
      }
      // Settle the plan after the delayed tool result reaches the follower.
      mockPlannerHook = undefined;
      mockPlan = { status: 'done' };
      finishTool();
      const body = await response.text();
      expect(body.match(/: tool-result /g)).toHaveLength(1);
      expect(body).toContain('saved-id');
      expect(body).toContain('record_add');
      expect(body).toContain(JSON.stringify(toolResult));
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
  'retains worker results with session-events attached after follow timeout: %s',
  async (timeout) => {
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
    const follow = (maxMs: number) =>
      followDialogue(h, {
        delivery: h.outbox.beginDelivery(),
        since: 0,
        signal: new AbortController().signal,
        maxMs,
      });
    try {
      await h.session.send('go');
      await until(() => report !== undefined);
      if (timeout) {
        const items = [];
        for await (const item of follow(1)) {
          items.push(item);
          if (item.kind === 'tool-result') item.written?.();
        }
        expect(items.at(-1)).toMatchObject({ kind: 'end', reason: 'limit' });
      }
      const record = {
        call: { id: 'retained', name: 'record_get', arguments: {} },
        result: { content: 'saved' },
      };
      report?.(record);
      const items = [];
      for await (const item of follow(1)) {
        items.push(item);
        if (item.kind === 'tool-result') item.written?.();
      }
      expect(items.filter((item) => item.kind === 'tool-result')).toEqual([
        { kind: 'tool-result', record, written: expect.any(Function) },
      ]);
      const replay = [];
      for await (const item of follow(1)) replay.push(item);
      expect(replay.filter((item) => item.kind === 'tool-result')).toEqual([]);
    } finally {
      detach();
      finish();
    }
  },
);
