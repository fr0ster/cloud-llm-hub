const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};
const sessionCaller1 = { ...taskCaller, sessionId: 'legacy-check' };
const sessionCaller2 = { ...taskCaller, sessionId: 'large-context' };
const sessionCaller3 = { ...taskCaller, sessionId: 'migration' };

import {
  plannerWithAttachments,
  plannerWithEnvironment,
} from '../../srv/lib/dialogue-planner-content';

jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
  },
}));

import type { DialogueState } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '@mcp-abap-adt/llm-agent-libs';
import {
  createDialogueStateStore,
  DIALOGUE_TOOL_CONTRACT_VERSION,
  deleteDialogueState,
  getDialogueStoreBackend,
  hasDialogueState,
  initializeDialogueStore,
  MemoryDialogueStore,
  migrateDialogueToolContract,
  touchDialogueState,
} from '../../srv/lib/dialogue-store';
import { loadSessionConfig } from '../../srv/lib/session-config';

jest.mock('../../srv/agent-manager', () => ({ isProvidersReady: () => false }));

import { hasSessionState } from '../../srv/lib/session-state';

const state: DialogueState = {
  conversation: [{ role: 'user', content: 'hello' }],
  tasks: [],
  pending: [],
  savedAt: 1,
};
beforeEach(() => initializeDialogueStore(loadSessionConfig({})));
it.each<NonNullable<DialogueState['tasks'][number]['checkerVerdict']>>([
  { verdict: 'pass' },
  { verdict: 'fail', count: 2, note: 'Claims lack supporting evidence' },
  { unusable: true },
])(
  'round-trips task result references, summaries and checker verdict %j',
  async (checkerVerdict) => {
    const store = new MemoryDialogueStore();
    const snapshot: DialogueState = {
      ...state,
      tasks: [
        {
          id: 't1',
          worker: 'checker',
          goal: 'Verify report',
          state: 'done',
          createdAt: 1,
          resultRef: { collection: 'task-results', record: 't1', chars: 1200 },
          summary: 'Report verification completed',
          checkerVerdict,
        },
      ],
    };
    await store.save('alice', 'task-results', snapshot);
    const restored = await store.load('alice', 'task-results');
    expect(restored).toEqual(snapshot);
    if (!restored) throw new Error('missing restored state');
    await store.save('alice', 'task-results', restored);
    expect(await store.load('alice', 'task-results')).toEqual(snapshot);
  },
);
it('round-trips terminal request errors and terminal task error codes', async () => {
  const store = new MemoryDialogueStore();
  const snapshot: DialogueState = {
    ...state,
    requests: [
      {
        id: 'r1',
        openedAt: 1,
        text: 'describe',
        terminalError: {
          code: 'LLM_OUTPUT_TRUNCATED',
          message: 'Provider stopped at the output token limit',
        },
      },
    ],
    tasks: [
      {
        id: 't1',
        worker: 'executor',
        goal: 'read',
        state: 'failed',
        createdAt: 1,
        error: 'Provider stopped at the output token limit',
        terminalErrorCode: 'LLM_OUTPUT_TRUNCATED',
      },
    ],
  };
  await store.save('alice', 'terminal', snapshot);
  const restored = await store.load('alice', 'terminal');
  expect(restored).toEqual(snapshot);
  if (!restored) throw new Error('missing restored state');
  await store.save('alice', 'terminal', restored);
  expect(await store.load('alice', 'terminal')).toEqual(snapshot);
});
it('round-trips planner projections, provider output and usage details', async () => {
  const store = new MemoryDialogueStore();
  const usage = {
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 3,
    reasoningTokens: 1,
    models: {
      planner: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        requests: 1,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 3,
        reasoningTokens: 1,
      },
    },
  };
  const providerOutput = {
    protocol: 'openai-responses',
    items: [{ type: 'reasoning', encrypted_content: 'opaque' }],
  };
  const snapshot: DialogueState = {
    ...state,
    conversation: [
      ...state.conversation,
      { role: 'assistant', content: 'Complete answer', providerOutput },
    ],
    conversationLeadingActions: [0],
    requests: [
      {
        id: 'closed',
        openedAt: 1,
        closedAt: 2,
        text: 'previous',
        resolvedFailures: ['failed-previous'],
      },
      {
        id: 'open',
        openedAt: 3,
        text: 'current',
        resolvedFailures: ['failed-current'],
        deliveredTaskIds: ['t1'],
        transcript: [
          { role: 'user', content: 'current' },
          {
            role: 'assistant',
            content: 'Complete answer',
            providerOutput,
            plannerReference: 'Delivered answer',
          },
          { role: 'user', content: '[actions] none', internalKind: 'actions' },
          {
            role: 'user',
            content: '[task events] task t1 done',
            internalKind: 'events',
          },
          {
            role: 'user',
            content: '[dropped 1 earlier messages]',
            internalKind: 'note',
          },
        ],
      },
    ],
    tasks: [
      {
        id: 't1',
        worker: 'executor',
        goal: 'read',
        state: 'done',
        createdAt: 1,
        usage,
      },
    ],
    pending: [
      {
        id: 'reply',
        text: 'done',
        createdAt: 4,
        trigger: 'event',
        usage: { planner: usage },
      },
    ],
  };
  await store.save('alice', 'projection', snapshot);
  const restored = await store.load('alice', 'projection');
  expect(restored).toEqual(snapshot);
  if (!restored) throw new Error('missing restored state');
  await store.save('alice', 'projection', restored);
  expect(await store.load('alice', 'projection')).toEqual(snapshot);
});
it('strips legacy archives and preserves open and closed request transcripts', async () => {
  const store = new MemoryDialogueStore();
  const closed = {
    id: 'r1',
    openedAt: 1,
    closedAt: 2,
    text: 'earlier',
    transcript: state.conversation,
  };
  const open = {
    id: 'r2',
    openedAt: 2,
    text: 'current',
    transcript: state.conversation,
  };
  const legacy = {
    ...state,
    messages: 'ignored legacy archive',
    requests: [
      {
        ...closed,
        replies: null,
        closedPlan: 'old',
        transcriptExpired: true,
      },
      { ...open, replies: ['old'], closedPlan: {}, transcriptExpired: true },
    ],
  };
  await store.save('alice', 'legacy-archives', legacy);
  const expected = { ...state, requests: [closed, open] };
  const restored = await store.load('alice', 'legacy-archives');
  expect(restored).toEqual(expected);
  if (!restored) throw new Error('missing restored state');
  await store.save('alice', 'legacy-archives', restored);
  expect(await store.load('alice', 'legacy-archives')).toEqual(expected);
});
it('restores a long 9.0.x legacy plan and persists normalized state and later progress', async () => {
  const id = 'legacy';
  const store = createDialogueStateStore('alice', id);
  const legacy: DialogueState = {
    ...state,
    plan: 'x'.repeat(50_000),
    planStatus: 'active',
  };
  await store.save(id, legacy);
  const options = {
    caller: { ...taskCaller, sessionId: id },
    id,
    store,
    board: { workers: new Map() },
    planner: {
      process: jest.fn(async () => ({
        ok: true as const,
        value: { content: 'Progress saved' },
      })),
    },
  };
  const session = await DialogueSession.open(options);
  expect(session.snapshot().plan).toEqual({
    version: 1,
    steps: [],
    note: legacy.plan,
    status: 'active',
  });
  const normalized = session.snapshot();
  await store.save(id, normalized);
  expect(await store.load(id)).toEqual(normalized);

  const reopened = await DialogueSession.open(options);
  expect(reopened.snapshot()).toEqual(normalized);
  await reopened.send('Continue with the next task');
  const progressed = reopened.snapshot();
  expect(progressed.plan).toEqual(normalized.plan);
  expect(progressed.conversation).toContainEqual({
    role: 'assistant',
    content: 'Progress saved',
  });
  expect(progressed.savedAt).toBeGreaterThan(legacy.savedAt);
  expect(await store.load(id)).toEqual(progressed);
  expect((await DialogueSession.open(options)).snapshot()).toEqual(progressed);
});
it.each([undefined, 'Previous note'])(
  'loads legacy checking steps with note %s as done and drops their embedded checks',
  async (note) => {
    const store = createDialogueStateStore('alice', 'legacy-check');
    const step = {
      id: 'read',
      goal: 'Read record',
      state: 'done' as const,
      taskIds: ['work-1'],
      workTaskId: 'work-1',
      note: [
        note,
        'Legacy check was not run; plan a separate check step if needed',
      ]
        .filter(Boolean)
        .join('; '),
    };
    const plan = {
      version: 1 as const,
      status: 'active' as const,
      steps: [step],
    };
    // Supply the old serialized format through the public persistence boundary.
    const legacy = {
      ...state,
      toJSON: () => ({
        ...state,
        plan: {
          ...plan,
          steps: [
            {
              ...step,
              state: 'checking',
              note,
              check: {
                by: 'checker',
                goal: 'Verify record',
                verdict: 'fail',
                taskId: 'check-1',
              },
            },
          ],
        },
      }),
    };
    await store.save('legacy-check', legacy);
    const normalized = { ...state, plan };
    expect(await store.load('legacy-check')).toEqual(normalized);
    const session = await DialogueSession.open({
      caller: sessionCaller1,
      id: 'legacy-check',
      store,
      board: { workers: new Map() },
      planner: {
        process: async () => ({ ok: true, value: { content: 'Done' } }),
      },
    });
    expect(session.snapshot().plan).toEqual({
      ...plan,
      steps: [{ ...step, result: 'report' }],
      status: 'done',
    });
    await store.save('legacy-check', session.snapshot());
    expect((await store.load('legacy-check'))?.plan).toEqual({
      ...plan,
      steps: [{ ...step, result: 'report' }],
      status: 'done',
    });
  },
);
it('backfills legacy workTaskId from the last task excluding the check task', async () => {
  const store = createDialogueStateStore('alice', 'legacy-work');
  const step = {
    id: 'read',
    goal: 'Read record',
    state: 'done' as const,
    taskIds: ['work-1', 'work-2', 'check-1'],
  };
  const plan = {
    version: 1 as const,
    status: 'active' as const,
    steps: [step],
  };
  const legacy = {
    ...state,
    toJSON: () => ({
      ...state,
      plan: { ...plan, steps: [{ ...step, check: { taskId: 'check-1' } }] },
    }),
  };
  await store.save('legacy-work', legacy);
  expect((await store.load('legacy-work'))?.plan).toEqual({
    ...plan,
    steps: [{ ...step, workTaskId: 'work-2' }],
  });
});
it('round trips structured plans and retained task ownership without stripping fields', async () => {
  const store = createDialogueStateStore('alice', 'structured');
  const value: DialogueState = {
    ...state,
    plan: {
      scopeConsent: true,
      version: 1,
      status: 'waiting_user',
      question: 'Continue?',
      note: 'A plan',
      steps: [
        {
          id: 'read',
          goal: 'Read record',
          items: ['A', 'B'],
          dependsOn: ['discover'],
          worker: 'executor',
          state: 'done',
          workTaskId: 'work-2',
          successfulWorkTaskId: 'work-2',
          taskIds: ['work-1', 'work-2', 'check-1'],
          verdict: 'fail',
          checkedTaskIds: { discover: 'work-2' },
          note: 'Retry',
        },
      ],
    },
    planStatus: 'waiting_user',
    tasks: [
      {
        id: 'work-2',
        worker: 'executor',
        goal: 'Read record',
        state: 'done',
        budgetExhausted: true,
        toolCalls: 30,
        maxToolCalls: 30,
        output: 'Partial',
        createdAt: 1,
        finishedAt: 2,
      },
    ],
    taskSteps: {
      'work-1': 'read',
      'work-2': 'read',
      'check-1': 'read',
      removed: 'old-step',
    },
  };
  await store.save('structured', value);
  expect(await store.load('structured')).toEqual(value);
});
it.each(['active', 'waiting_user', 'done'] as const)(
  'round trips plan status %s',
  async (planStatus) => {
    const store = createDialogueStateStore('alice', 'status');
    await store.save('status', { ...state, plan: 'Work', planStatus });
    expect(await store.load('status')).toEqual({
      ...state,
      plan: 'Work',
      planStatus,
    });
  },
);
it('round trips with explicit owners, isolates equal keys, and deletes', async () => {
  const a = createDialogueStateStore('alice', 'same');
  const b = createDialogueStateStore('bob', 'same');
  await a.save('same', state);
  expect(await a.load('same')).toEqual(state);
  expect(await b.load('same')).toBeUndefined();
  expect(hasSessionState('alice', 'same')).toBe(true);
  expect(hasDialogueState('bob', 'same')).toBe(false);
  await deleteDialogueState('alice', 'same');
  expect(await a.load('same')).toBeUndefined();
});
it('ignores mismatched ids for every operation', async () => {
  const s = createDialogueStateStore('alice', 'key');
  await s.save('wrong', state);
  expect(await s.load('key')).toBeUndefined();
  await s.save('key', state);
  await s.delete('wrong');
  expect(await s.load('wrong')).toBeUndefined();
  expect(await s.load('key')).toEqual(state);
  await s.delete('key');
  expect(await s.load('key')).toBeUndefined();
});
it('bounds memory, clones state, and applies the TTL backstop and sweep', async () => {
  const s = new MemoryDialogueStore(1, 100);
  await s.save('a', 'k', state);
  const copy = await s.load('a', 'k');
  if (!copy) throw new Error('missing state');
  copy.conversation.length = 0;
  expect((await s.load('a', 'k'))?.conversation).toHaveLength(1);
  await s.save('b', 'k', state);
  expect(await s.load('a', 'k')).toBeUndefined();
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 101);
  try {
    expect(s.hasDialogueState('b', 'k')).toBe(false);
    expect(await s.load('b', 'k')).toBeUndefined();
    await s.sweepExpired(Date.now());
  } finally {
    now.mockRestore();
  }
});
it.each([
  { ...state, savedAt: NaN },
  { ...state, conversationLeadingActions: [-1] },
])(
  'rejects malformed state and preserves the last valid save',
  async (value) => {
    const store = createDialogueStateStore('alice', 'invalid');
    await store.save('invalid', state);
    await store.save('invalid', value);
    expect(await store.load('invalid')).toEqual(state);
  },
);

it('round trips large dialogue state with closed request transcripts', async () => {
  const store = new MemoryDialogueStore();
  const content = '\u0000'.repeat(65_000);
  const value: DialogueState = {
    ...state,
    conversation: Array.from({ length: 201 }, () => ({
      role: 'user',
      content,
    })),
    requests: Array.from({ length: 201 }, (_, i) => ({
      id: `r${i}`,
      openedAt: i,
      closedAt: i + 1,
      text: i === 0 ? content : 'request',
      ...(i === 0 ? { transcript: [{ role: 'user', content }] } : {}),
    })),
    tasks: Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      worker: 'executor',
      goal: 'Read',
      state: 'done',
      createdAt: 1,
      output: content,
    })),
    plan: {
      version: 1,
      steps: [{ id: 'read', goal: content, state: 'done', taskIds: [] }],
      status: 'done',
    },
  };
  await store.save('alice', 'large', value);
  expect(await store.load('alice', 'large')).toEqual(value);
});

it('dialogue activity touches persistence at most once per 60 seconds', async () => {
  const backend = getDialogueStoreBackend();
  await backend.save('alice', 'touch', state);
  const save = jest.spyOn(backend, 'save');
  const start = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(start);
  try {
    await touchDialogueState('alice', 'touch');
    now.mockReturnValue(start + 59_999);
    await touchDialogueState('alice', 'touch');
    expect(save).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + 60_000);
    await touchDialogueState('alice', 'touch');
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    save.mockRestore();
  }
});

it('saves dialogue state when temporary attachment content exceeds the message limit', async () => {
  const context = new WeakMap<object, string>();
  const knowledge = 'attached content '.repeat(6000);
  const inputs: string[] = [];
  const store = createDialogueStateStore('alice', 'large-context');
  const session = await DialogueSession.open({
    caller: sessionCaller2,
    id: 'large-context',
    store,
    planner: plannerWithEnvironment(
      plannerWithAttachments(
        {
          async process(input) {
            inputs.push(JSON.stringify(input));
            return { ok: true, value: { content: 'answer' } };
          },
        },
        context,
      ),
      () => 'Hub',
    ),
    board: { workers: new Map(), maxConcurrent: 1 },
  });
  try {
    const trace = { traceId: 'large' };
    context.set(trace, knowledge);
    await session.send('hello', { trace }).finally(() => context.delete(trace));
    expect(inputs[0]).toContain(knowledge);
    const snapshot = session.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('attached content');
    expect(await store.load('large-context')).toEqual(snapshot);
    await session.send('next');
    expect(inputs.at(-1)).not.toContain('[attached files]');
    expect(await store.load('large-context')).toEqual(session.snapshot());
  } finally {
    await session.close();
  }
});

it('round trips confirmed outbox entries and ack mode, and loads legacy rows', async () => {
  const store = new MemoryDialogueStore();
  const entry = {
    id: 'm1',
    text: 'hello',
    createdAt: 1,
    trigger: 'event' as const,
  };
  const row = {
    ...state,
    outbox: [
      { ...entry, confirmed: true },
      { ...entry, id: 'm2' },
    ],
    ackMode: true,
  };
  await store.save('alice', 'new', row);
  expect(await store.load('alice', 'new')).toEqual(row);
  const legacy = { ...state, outbox: [entry] };
  await store.save('alice', 'old', legacy);
  expect(await store.load('alice', 'old')).toEqual(legacy);
  await store.save('alice', 'empty', { ...state, ackMode: true });
  expect(await store.load('alice', 'empty')).toEqual({
    ...state,
    ackMode: true,
  });
});

it('round trips task, pending and outbox usage and still loads legacy state', async () => {
  const usage = {
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
    models: {
      m: { promptTokens: 3, completionTokens: 2, totalTokens: 5, requests: 1 },
    },
  };
  const message = {
    id: 'reply',
    text: 'done',
    createdAt: 1,
    trigger: 'event' as const,
    usage: { planner: usage, tasks: [{ id: 't1', worker: 'executor', usage }] },
  };
  const value = {
    ...state,
    tasks: [
      {
        id: 't1',
        worker: 'executor',
        goal: 'work',
        state: 'done' as const,
        createdAt: 1,
        usage,
      },
    ],
    pending: [message],
    outbox: [message],
  };
  const store = getDialogueStoreBackend();
  await store.save('alice', 'usage', value);
  expect(await store.load('alice', 'usage')).toEqual(value);
  await store.save('alice', 'legacy-usage', state);
  expect(await store.load('alice', 'legacy-usage')).toEqual(state);
});

test('stored session agents selection survives state validation and restoration', async () => {
  const store = new MemoryDialogueStore();
  await store.save('reader', 'selection', {
    ...state,
    agentsCollectionId: 'own-agents',
  });
  expect(await store.load('reader', 'selection')).toMatchObject({
    agentsCollectionId: 'own-agents',
  });
});

it('round-trips empty tool evidence and legacy tasks without evidence', async () => {
  const store = new MemoryDialogueStore();
  const legacy: DialogueState['tasks'][number] = {
    id: 'legacy',
    worker: 'executor',
    goal: 'Read',
    state: 'done',
    createdAt: 1,
  };
  const current: DialogueState = {
    ...state,
    tasks: [
      legacy,
      {
        ...legacy,
        id: 'empty',
        toolTrace: { entries: [], omittedCount: 0, complete: true },
      },
    ],
  };
  await store.save('alice', 'trace-compatibility', current);
  const restored = await store.load('alice', 'trace-compatibility');
  expect(restored).toEqual(current);
  expect(restored?.tasks[0]).not.toHaveProperty('toolTrace');
});

it.each(['rag_list', 'rag_add', 'rag_correct', 'rag_deprecate'])(
  'interrupts old queued %s work without replaying writes on library restore',
  async (name: string) => {
    const legacy = {
      ...state,
      toolContractVersion: 0,
      conversation: [
        {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'old-call',
              type: 'function' as const,
              function: {
                name,
                arguments: '{"id":"tech-spec","newText":"old"}',
              },
            },
          ],
        },
      ],
      tasks: [
        {
          id: 't1',
          worker: 'executor',
          goal: name,
          state: 'queued' as const,
          createdAt: 1,
        },
        {
          id: 't2',
          worker: 'executor',
          goal: 'completed write',
          state: 'done' as const,
          output: 'saved tech-spec',
          createdAt: 1,
        },
      ],
      plan: {
        version: 1 as const,
        status: 'active' as const,
        steps: [
          { id: 's1', goal: name, state: 'pending' as const, taskIds: ['t1'] },
        ],
      },
    };
    const migrated = migrateDialogueToolContract(legacy);
    expect(migrated.toolContractVersion).toBe(DIALOGUE_TOOL_CONTRACT_VERSION);
    expect(migrated.conversation).toEqual(legacy.conversation);
    expect(migrated.tasks[1]).toEqual(legacy.tasks[1]);
    expect(migrated.tasks[0].state).toBe('interrupted');
    expect(
      typeof migrated.plan === 'object' && migrated.plan.steps[0].state,
    ).toBe('blocked');
    expect(migrateDialogueToolContract(migrated)).toBe(migrated);
    const run = jest.fn(async () => ({ output: 'must not run' }));
    const session = await DialogueSession.open({
      caller: sessionCaller3,
      id: 'migration',
      store: {
        load: async () => migrated,
        save: async () => {},
        delete: async () => {},
      },
      board: {
        workers: new Map([
          [
            'executor',
            {
              name: 'executor',
              description: '',
              capabilities: { contextPolicy: 'optional' as const },
              run,
            },
          ],
        ]),
      },
      planner: {
        process: async () => ({
          ok: true,
          value: { content: 'Replan with canonical tools' },
        }),
      },
    });
    await session.send('Review existing record IDs before replanning');
    expect(run).not.toHaveBeenCalled();
    expect(session.snapshot().tasks[0].state).toBe('interrupted');
    expect(session.snapshot().tasks[1].output).toBe('saved tech-spec');
  },
);

it('persists the tool contract marker without changing completed evidence', async () => {
  const store = new MemoryDialogueStore();
  const migrated = migrateDialogueToolContract(state);
  await store.save('alice', 'contract', migrated);
  expect(await store.load('alice', 'contract')).toEqual(migrated);
  expect(migrated.conversation).toEqual(state.conversation);
});

test('v1 migration interrupts unfinished work and translates historical planning calls', () => {
  const legacy = {
    ...state,
    toolContractVersion: 1,
    conversation: [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'read',
            type: 'function' as const,
            function: { name: 'get_plan', arguments: '{}' },
          },
          {
            id: 'write',
            type: 'function' as const,
            function: { name: 'update_plan', arguments: '{"steps":[]}' },
          },
        ],
      },
    ],
    tasks: [
      {
        id: 'running',
        worker: 'executor',
        goal: 'Read',
        state: 'running' as const,
        createdAt: 1,
      },
    ],
    plan: {
      version: 1 as const,
      status: 'active' as const,
      steps: [
        {
          id: 'step',
          goal: 'Read',
          state: 'running' as const,
          taskIds: ['running'],
        },
      ],
    },
  };
  const migrated = migrateDialogueToolContract(legacy);
  expect(migrated.toolContractVersion).toBe(DIALOGUE_TOOL_CONTRACT_VERSION);
  expect(migrated.plan).toMatchObject({ steps: [{ state: 'blocked' }] });
  expect(migrated.tasks).toMatchObject([{ state: 'interrupted' }]);
  expect(
    migrated.conversation[0].tool_calls?.map((call) => call.function.name),
  ).toEqual(['plan_get', 'plan_update']);
  expect(legacy.conversation[0].tool_calls[0].function.name).toBe('get_plan');
});

it.each([undefined, 'chosen-model'])(
  'restores task records with optional model %s',
  async (model) => {
    const store = new MemoryDialogueStore();
    const task = {
      id: 'task',
      worker: 'executor',
      goal: 'Read',
      state: 'done' as const,
      createdAt: 1,
      ...(model === undefined ? {} : { model }),
    };
    await store.save('alice', 'models', { ...state, tasks: [task] });
    expect((await store.load('alice', 'models'))?.tasks).toEqual([task]);
  },
);

it.each([1, 2])('interrupts unfinished contract version %s', (version) => {
  const migrated = migrateDialogueToolContract({
    ...state,
    toolContractVersion: version,
    tasks: [
      {
        id: 'old',
        worker: 'executor',
        goal: 'write',
        state: 'running',
        createdAt: 1,
      },
    ],
    plan: {
      version: 1,
      status: 'active',
      steps: [{ id: 's', goal: 'write', state: 'running', taskIds: ['old'] }],
    },
  });
  expect(migrated.tasks[0].state).toBe('interrupted');
  expect(
    typeof migrated.plan === 'object' && migrated.plan.steps[0].state,
  ).toBe('blocked');
});
