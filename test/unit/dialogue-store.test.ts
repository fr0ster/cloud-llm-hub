import {
  plannerWithEnvironment,
  plannerWithRetrievedContext,
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
  DIALOGUE_BYTE_LIMIT,
  deleteDialogueState,
  getDialogueStoreBackend,
  hasDialogueState,
  initializeDialogueStore,
  MemoryDialogueStore,
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
          state: 'checking',
          workTaskId: 'work-2',
          successfulWorkTaskId: 'work-2',
          taskIds: ['work-1', 'work-2', 'check-1'],
          check: {
            by: 'checker',
            goal: 'Record matches',
            verdict: 'fail',
            taskId: 'check-1',
          },
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
it('rejects oversized structured fields and ownership maps', async () => {
  const store = createDialogueStateStore('alice', 'bounded');
  for (const extra of [
    {
      taskSteps: Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [String(i), 'step']),
      ),
    },
    { taskSteps: { task: 'x'.repeat(1001) } },
    {
      plan: {
        version: 1,
        status: 'active',
        steps: [],
        question: 'x'.repeat(20001),
      },
    },
    {
      plan: {
        version: 1,
        status: 'active',
        steps: [
          {
            id: 'a',
            goal: 'Read',
            state: 'pending',
            taskIds: [],
            note: 'x'.repeat(20001),
          },
        ],
      },
    },
    {
      plan: {
        version: 1,
        status: 'active',
        steps: [
          { id: 'a', goal: 'x'.repeat(20001), state: 'pending', taskIds: [] },
        ],
      },
    },
  ]) {
    await store.save('bounded', { ...state, ...extra } as DialogueState);
    expect(await store.load('bounded')).toBeUndefined();
  }
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
  { ...state, conversation: Array(201).fill({ role: 'user', content: 'x' }) },
  { ...state, conversation: [{ role: 'user', content: 'x'.repeat(20001) }] },
  { ...state, tasks: Array(51).fill({}) },
])('rejects invalid or oversized states without truncating', async (value) => {
  const s = createDialogueStateStore('alice', 'k');
  await s.save('k', value as DialogueState);
  expect(await s.load('k')).toBeUndefined();
});

it('guards states exceeding the byte limit without replacing the last save', async () => {
  const store = new MemoryDialogueStore();
  await store.save('alice', 'bytes', state);
  await store.save('alice', 'bytes', {
    ...state,
    plan: 'x'.repeat(DIALOGUE_BYTE_LIMIT),
  });
  expect(await store.load('alice', 'bytes')).toEqual(state);
});

it('round trips library retention budgets with two-byte text and request ownership', async () => {
  const store = new MemoryDialogueStore();
  const messageText = 'я'.repeat(20_000);
  const value: DialogueState = {
    ...state,
    conversation: Array.from({ length: 200 }, () => ({
      role: 'user',
      content: messageText,
    })),
    requestSeq: 200,
    taskRequests: { task1: 'r200' },
    messages: Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      text: messageText,
      createdAt: i,
      trigger: 'user',
    })),
    requests: Array.from({ length: 200 }, (_, i) => ({
      id: `r${i + 1}`,
      openedAt: i,
      text: messageText,
      replies: Array.from({ length: 50 }, (_, j) => `m${j}`),
      ...(i < 199 ? { closedAt: i + 1 } : {}),
      transcript:
        i === 199
          ? Array.from({ length: 4 }, () => ({
              role: 'user',
              content: 'я'.repeat(100_000),
            }))
          : i === 198
            ? [{ role: 'user', content: 'я'.repeat(1_999_900) }]
            : [],
      ...(i === 198
        ? { closedPlan: { version: 1, steps: [], status: 'done' } }
        : {}),
      ...(i === 0 ? { legacy: true, transcriptExpired: true } : {}),
    })),
  };
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(
    2 * 1024 * 1024,
  );
  await store.save('alice', 'bounds', value);
  expect(await store.load('alice', 'bounds')).toEqual(value);
});

it('persists and restores the configured task boundary of 60', async () => {
  const config = require('../../srv/agent-config');
  const spy = jest.spyOn(config, 'dialogueMaxTasks').mockReturnValue(60);
  try {
    const store = createDialogueStateStore('alice', 'boundary');
    const value = {
      ...state,
      tasks: Array.from({ length: 60 }, (_, i) => ({
        id: String(i),
        worker: 'executor',
        goal: 'read',
        state: 'done' as const,
        createdAt: 1,
      })),
    };
    await store.save('boundary', value);
    expect((await store.load('boundary'))?.tasks).toHaveLength(60);
  } finally {
    spy.mockRestore();
  }
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

it('saves dialogue state when temporary retrieved context exceeds the message limit', async () => {
  const context = new WeakMap<object, string>();
  const knowledge = 'retrieved knowledge '.repeat(6000);
  const inputs: string[] = [];
  const store = createDialogueStateStore('alice', 'large-context');
  const session = await DialogueSession.open({
    id: 'large-context',
    store,
    planner: plannerWithEnvironment(
      plannerWithRetrievedContext(
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
    expect(JSON.stringify(snapshot)).not.toContain('retrieved knowledge');
    expect(await store.load('large-context')).toEqual(snapshot);
    await session.send('next');
    expect(inputs.at(-1)).not.toContain('[retrieved context]');
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
