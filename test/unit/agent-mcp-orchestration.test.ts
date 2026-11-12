import { ragTextResult } from '../../srv/agent-mcp-rag';
import {
  BriefPlanAuthor,
  planAuthorBriefRequest,
} from '../../srv/lib/brief-plan-author';
import { revisionPlanSchema } from '../../srv/lib/dialogue-store';
import { bindCaller, callOptionsFor } from '../../srv/lib/rag-caller';
import {
  runWithSessionId,
  runWithStatelessKnowledge,
} from '../../srv/request-session';

const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};
const sessionCaller1 = { ...taskCaller, sessionId: 'owned' };

import type {
  DialoguePlan,
  IPlanAuthor,
  ISmartAgent,
  ISubAgent,
  ISubAgentInput,
} from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  InMemoryDialogueStateStore,
} from '@mcp-abap-adt/llm-agent-libs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { z } from 'zod';
import {
  executeOrchestrationTool,
  orchestrationDefinitions,
  orchestrationTools,
  registerOrchestrationTools,
} from '../../srv/agent-mcp-orchestration';
import { userCollectionId } from '../../srv/collection-ids';
import { AgentProfileRunner } from '../../srv/lib/agent-profile-runner';
import { LocalRagMcpClient } from '../../srv/lib/dialogue-rag-tools';
import * as plannerMemory from '../../srv/lib/planner-memory';
import {
  disposeSessionLlms,
  longSessionLlms,
} from '../../srv/lib/session-llms';
import { CollectionRegistry } from '../../srv/rag-collections';
import {
  getRagCallerIdentity,
  getRequestUserId,
  profileToolAllowed,
} from '../../srv/request-session';

const mockPlan: DialoguePlan = {
  version: 1,
  status: 'active',
  steps: [{ id: 'read', goal: 'Read', state: 'pending', taskIds: [] }],
};
const mockCreate: IPlanAuthor['create'] = jest.fn(async () => ({
  ok: true as const,
  value: structuredClone(mockPlan),
}));
const mockRevise: IPlanAuthor['revise'] = jest.fn(async (input) => ({
  ok: true as const,
  value: input.plan,
}));
const mockAuthorAgent: ISmartAgent = {
  process: async () => ({
    ok: true,
    value: {
      content: JSON.stringify({
        steps: mockPlan.steps,
        status: mockPlan.status,
      }),
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    },
  }),
  streamProcess: async function* () {},
};
let mockSession: DialogueSession;
const mockHeadless = jest.fn(async () => ({
  session: mockSession,
  caller: sessionCaller1,
}));
const mockRelease = jest.fn();
const mockLongSession = { userId: 'alice', key: 'owned', destination: 'TEST' };
const mockRun = jest.fn(async (_input: ISubAgentInput) => ({
  output: 'read done',
}));
const mockWorker: ISubAgent = {
  name: 'executor',
  capabilities: { contextPolicy: 'optional' },
  run: (input) => mockRun(input),
};
const mockStore = new InMemoryDialogueStateStore();
const mockSource = {
  get: async () => ({
    ok: true as const,
    value: {
      name: 'executor',
      description: 'Read',
      systemPrompt: '',
      tools: 'all' as const,
      result: 'report' as const,
    },
  }),
  list: async () => ({
    ok: true as const,
    value: [
      { name: 'executor', description: 'Read', result: 'report' as const },
    ],
  }),
  getPrompts: async () => ({ ok: true as const, value: {} }),
};
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-manager', () => ({
  createAgentProfileSource: () => mockSource,
  getSmartAgent: async () => ({
    profileRunner: {
      preparePlanAuthor: async () => ({ ok: true, value: mockAuthorAgent }),
    },
  }),
  runWithCallerExposition: (_levels: string[], run: () => Promise<object>) =>
    run(),
}));
jest.mock('../../srv/lib/dialogue-sessions', () => ({
  headlessDialogueFor: () => mockHeadless(),
}));
jest.mock('../../srv/lib/session-lifecycle', () => ({
  resolveSession: async (user: string, key: string) =>
    user === 'alice' && key === 'owned' ? mockLongSession : undefined,
}));
jest.mock('../../srv/lib/long-session', () => ({
  longSessions: () => ({ get: () => mockLongSession, hold: () => () => {} }),
}));
jest.mock('../../srv/lib/gatekeeper', () => ({
  leaseSession: () => ({ release: mockRelease }),
}));
jest.mock('../../srv/lib/usage/runtime', () => ({
  usageRuntime: () => undefined,
}));
const caller = { userId: 'alice', exposition: undefined };
const req = Object.assign(express.request, {
  headers: { 'x-sap-destination': 'TEST' },
});
const call = (
  name: (typeof orchestrationTools)[number],
  args: Parameters<typeof executeOrchestrationTool>[3] = {},
) => executeOrchestrationTool(req, caller, name, args);
// Component coverage formerly exercised through the removed sessionless MCP path.
// The author now receives a real, bound session rather than a random trace session.
async function callBoundPlanAuthor(
  name: 'plan_create' | 'plan_revise',
  args: Parameters<typeof executeOrchestrationTool>[3],
) {
  const bound = await bindCaller('owned', 'alice', false);
  if (!bound.ok) throw bound.error;
  const retrieval = await plannerMemory.plannerSessionOptions('alice', 'owned');
  const author = new BriefPlanAuthor({
    caller: bound.value,
    source: mockSource,
    runner: {
      preparePlanAuthor: async () => ({ ok: true, value: mockAuthorAgent }),
      createWorker: async () => {
        throw new Error('Unexpected worker');
      },
      preparePlanner: async () => {
        throw new Error('Unexpected planner');
      },
    },
    notes: async (options) =>
      plannerMemory.planAuthorContextNotes(
        retrieval,
        'owned',
        planAuthorBriefRequest(),
        options,
      ),
  });
  return runWithSessionId(
    'owned',
    () =>
      runWithStatelessKnowledge(async () => {
        try {
          const options = callOptionsFor(bound.value);
          const result =
            name === 'plan_create'
              ? await author.create(
                  z
                    .object({
                      goal: z.string(),
                      context: z.string().optional(),
                    })
                    .parse(args),
                  options,
                )
              : await author.revise(
                  z
                    .object({ change: z.string(), plan: revisionPlanSchema })
                    .parse(args),
                  options,
                );
          return result.ok
            ? ragTextResult(JSON.stringify(result.value))
            : ragTextResult(result.error.message, true);
        } catch (error) {
          return ragTextResult(
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
      }),
    undefined,
    'alice',
    { admin: false, channel: 'mcp-agent' },
  );
}

beforeEach(async () => {
  longSessionLlms({ userId: 'alice', key: 'owned' });
  jest.clearAllMocks();
  mockRun.mockImplementation(async () => ({ output: 'read done' }));
  mockSession = await DialogueSession.open({
    caller: sessionCaller1,
    id: 'owned',
    planAuthor: { create: mockCreate, revise: mockRevise },
    planner: {
      process: async () => ({ ok: true, value: { content: 'Ready' } }),
    },
    board: { workers: new Map([['executor', mockWorker]]) },
    store: mockStore,
    maxCorrections: 0,
  });
});
afterEach(async () => {
  await mockSession.close();
  disposeSessionLlms({ userId: 'alice', key: 'owned' });
});

test.each(
  orchestrationTools.filter(
    (name) => name !== 'plan_create' && name !== 'plan_revise',
  ),
)('%s requires an owned session', async (name) => {
  expect(await call(name)).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('SESSION_REQUIRED') }],
  });
  expect(await call(name, { session: 'foreign' })).toMatchObject({
    isError: true,
    content: [{ text: 'SESSION_NOT_FOUND' }],
  });
  expect(mockHeadless).not.toHaveBeenCalled();
});
test.each(['plan_create', 'plan_revise'] as const)(
  '%s refuses an explicitly unknown session',
  async (name) => {
    expect(await call(name, { session: 'missing' })).toMatchObject({
      isError: true,
      content: [{ text: 'SESSION_NOT_FOUND' }],
    });
  },
);
test('bound author returns a plan without opening or storing a dialogue', async () => {
  const result = await callBoundPlanAuthor('plan_create', { goal: 'Read' });
  expect(result).not.toMatchObject({ isError: true });
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    version: 1,
    steps: [{ id: 'read' }],
  });
  expect(mockHeadless).not.toHaveBeenCalled();
  expect(mockSession.snapshot().plan).toBeUndefined();
});
test('bound revise accepts an explicit current plan and stores nothing', async () => {
  const result = await callBoundPlanAuthor('plan_revise', {
    change: 'Keep the goal',
    plan: z.json().parse(mockPlan),
    context: 'Keep completed work',
  });
  expect(result).not.toMatchObject({ isError: true });
  expect(mockHeadless).not.toHaveBeenCalled();
  expect(mockSession.snapshot().plan).toBeUndefined();
});
test('bound revise requires an explicit plan', async () => {
  expect(
    await callBoundPlanAuthor('plan_revise', {
      change: 'Read',
      context: JSON.stringify(mockPlan),
    }),
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('plan') }],
  });
});

test.each([
  { ...mockPlan, version: 2 },
  { ...mockPlan, steps: Array.from({ length: 1001 }, () => mockPlan.steps[0]) },
  { ...mockPlan, steps: [{ ...mockPlan.steps[0], goal: 'x'.repeat(20001) }] },
])('bound revise rejects invalid or oversized plans', async (plan) => {
  expect(
    await callBoundPlanAuthor('plan_revise', {
      change: 'Read',
      plan: z.json().parse(plan),
    }),
  ).toMatchObject({
    isError: true,
  });
});

test('session revise ignores the supplied plan and uses the session plan', async () => {
  await call('plan_create', { session: 'owned', goal: 'Read' });
  const sessionPlan = mockSession.snapshot().plan;
  expect(
    await call('plan_revise', {
      session: 'owned',
      change: 'Keep',
      plan: {
        ...z.object({}).passthrough().parse(mockPlan),
        note: 'Ignore supplied plan',
      },
    }),
  ).not.toMatchObject({ isError: true });
  expect(mockRevise).toHaveBeenCalledWith(
    expect.objectContaining({ plan: sessionPlan }),
    expect.anything(),
  );
});

test('session plan_create delegates and reads a completed task with MCP identity', async () => {
  expect(
    (await call('plan_create', { session: 'owned', goal: 'Read' })).isError,
  ).toBeUndefined();
  mockRun.mockImplementation(async () => {
    expect(getRequestUserId()).toBe('alice');
    expect(getRagCallerIdentity().channel).toBe('mcp-agent');
    return { output: 'read done' };
  });
  const result = await call('delegate_task', {
    session: 'owned',
    worker: 'executor',
    goal: 'Read',
    step_id: 'read',
  });
  expect(result).not.toMatchObject({ isError: true });
  for (
    let i = 0;
    i < 50 && mockSession.snapshot().tasks[0]?.state !== 'done';
    i++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  const task = mockSession.snapshot().tasks[0];
  expect(task.state).toBe('done');
  expect(
    await call('get_task', { session: 'owned', task_id: task.id }),
  ).toMatchObject({
    content: [{ text: expect.stringContaining('read done') }],
  });
  expect(mockRelease).toHaveBeenCalled();
});
test('a busy shared dialogue refuses MCP tools and retains its plan', async () => {
  await call('plan_create', { session: 'owned', goal: 'Read' });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockSession.close();
  mockSession = await DialogueSession.open({
    caller: sessionCaller1,
    id: 'owned',
    planAuthor: { create: mockCreate, revise: mockRevise },
    planner: {
      process: async () => {
        await gate;
        return { ok: true, value: { content: 'Ready' } };
      },
    },
    board: { workers: new Map() },
    maxCorrections: 0,
  });
  await call('plan_create', { session: 'owned', goal: 'Read' });
  const turn = mockSession.send('hello');
  try {
    const result = await call('plan_update', {
      session: 'owned',
      plan: 'replacement',
    });
    expect(result.isError).toBe(true);
    expect(mockSession.snapshot().plan).toMatchObject(mockPlan);
  } finally {
    release();
    await turn;
  }
});
test('wire schemas reuse library definitions and accept delegation', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  const client = new Client({ name: 'test', version: '1' });
  await registerOrchestrationTools(server, req, caller, (_name, run) => run);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  try {
    const listed = await client.listTools();
    const definitions = await orchestrationDefinitions(mockSource);
    expect(listed.tools).toHaveLength(8);
    for (const tool of definitions) {
      const wire = listed.tools.find((item) => item.name === tool.name);
      expect(wire?.description).toContain(tool.description);
      if (tool.name === 'plan_revise') {
        expect(wire?.inputSchema.properties?.plan).toMatchObject({
          type: 'object',
        });
        expect(wire?.description).toContain('current session plan is used');
      }
      const {
        plan: _plan,
        session: _session,
        destination: _destination,
        ...properties
      } = wire?.inputSchema.properties ?? {};
      const expected = z
        .record(z.string(), z.json())
        .parse(tool.inputSchema.properties);
      if (tool.name === 'plan_revise') delete expected.plan;
      expect({
        ...properties,
        ...(tool.name !== 'plan_revise' && _plan ? { plan: _plan } : {}),
      }).toEqual(expected);
      expect(wire?.inputSchema.required ?? []).toEqual(
        tool.inputSchema.required,
      );
    }
    await client.callTool({
      name: 'plan_create',
      arguments: { session: 'owned', goal: 'Read' },
    });
    expect(
      await client.callTool({
        name: 'delegate_task',
        arguments: {
          session: 'owned',
          worker: 'executor',
          goal: 'Read',
          step_id: 'read',
        },
      }),
    ).not.toMatchObject({ isError: true });
  } finally {
    await client.close();
    await server.close();
  }
});

test('callTool receives cancellation, trace and long session id', async () => {
  const spy = jest.spyOn(mockSession, 'callTool');
  const signal = new AbortController().signal;
  await executeOrchestrationTool(
    req,
    caller,
    'plan_get',
    { session: 'owned' },
    signal,
  );
  expect(spy).toHaveBeenCalledWith(
    'plan_get',
    {},
    {
      signal,
      usage: undefined,
      trace: { traceId: expect.any(String) },
      sessionId: 'owned',
      caller: sessionCaller1,
    },
  );
  expect(spy.mock.calls[0]?.[2]?.caller).toBe(sessionCaller1);
});

test('delegated profiles cannot execute tools beyond the caller grants', async () => {
  await mockSession.close();
  const runner = new AgentProfileRunner({
    catalogue: () => [{ name: 'write', effect: 'write' }],
    grants: () => new Set(),
    buildPlanner: async () => {
      throw new Error('No turn expected');
    },
    buildWorker: async (profile) => ({
      name: profile.name,
      capabilities: { contextPolicy: 'optional' },
      run: async () => {
        if (!profileToolAllowed('write'))
          throw new Error('Tool forbidden by caller grants');
        return { output: 'written' };
      },
    }),
  });
  const source = {
    ...mockSource,
    get: async () => ({
      ok: true as const,
      value: {
        name: 'executor',
        description: '',
        systemPrompt: '',
        tools: { allow: ['write'] },
        result: 'report' as const,
      },
    }),
  };
  mockSession = await DialogueSession.open({
    caller: sessionCaller1,
    id: 'owned',
    planner: { process: async () => ({ ok: true, value: { content: '' } }) },
    board: { profileSource: source, profileRunner: runner },
    maxCorrections: 0,
  });
  await call('delegate_task', {
    session: 'owned',
    worker: 'executor',
    goal: 'Write',
  });
  for (
    let i = 0;
    i < 50 && mockSession.snapshot().tasks[0]?.state !== 'failed';
    i++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockSession.snapshot().tasks[0]).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('forbidden by caller grants'),
  });
});

test('bound author reads caller knowledge while agents stay hidden and blocked', async () => {
  const registry = new CollectionRegistry();
  for (const [id, owner, collectionKind] of [
    ['knowledge', 'alice', 'knowledge'],
    ['agents', 'alice', 'agents'],
    ['foreign', 'bob', 'knowledge'],
  ] as const) {
    await registry.createCollection({
      id: userCollectionId(id, owner),
      logicalId: id,
      displayName: id,
      description: '',
      scope: 'user',
      owner,
      collectionKind,
    });
    if (collectionKind === 'agents') continue;
    await registry.addDocument(userCollectionId(id, owner), {
      id: 'rule',
      text: 'Planning rule',
      metadata: {},
    });
  }
  const client = new LocalRagMcpClient(
    {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => ({
        ok: false,
        error: {
          code: 'UNEXPECTED',
          name: 'McpError',
          message: 'Unexpected upstream call',
        },
      }),
    },
    () => registry,
  );
  const original = mockAuthorAgent.process;
  const process = jest
    .spyOn(mockAuthorAgent, 'process')
    .mockImplementation(async (...args) => {
      expect(
        await client.callTool('rag_read', {
          collection: 'knowledge',
          id: 'rule',
        }),
      ).toMatchObject({
        ok: true,
        value: { content: expect.stringContaining('Planning rule') },
      });
      for (const collection of ['agents', 'foreign']) {
        expect(
          await client.callTool('rag_read', { collection, id: 'rule' }),
        ).toMatchObject({ value: { isError: true } });
      }
      const listed = await client.callTool('collections_list', {});
      expect(listed).toMatchObject({
        value: { content: expect.stringContaining('knowledge') },
      });
      expect(listed).not.toMatchObject({
        value: { content: expect.stringContaining('agents') },
      });
      expect(
        await client.callTool('record_add', {
          collection: 'knowledge',
          text: 'Forbidden',
        }),
      ).toMatchObject({ value: { isError: true } });
      return original(...args);
    });
  try {
    expect(
      await callBoundPlanAuthor('plan_create', { goal: 'Read guidance' }),
    ).not.toMatchObject({ isError: true });
    expect(process).toHaveBeenCalled();
  } finally {
    process.mockRestore();
  }
});

test.each(['plan_create', 'plan_revise'] as const)(
  '%s retrieves configured planning guidance for a bound author from its brief',
  async (name) => {
    const search = jest.fn(async () => [
      { collection: 'planning', id: 'rule', text: 'Configured planning rule' },
    ]);
    const setup = jest
      .spyOn(plannerMemory, 'plannerSessionOptions')
      .mockResolvedValue({ plannerKnowledge: [{ name: 'planning', search }] });
    const original = mockAuthorAgent.process;
    const process = jest
      .spyOn(mockAuthorAgent, 'process')
      .mockImplementation(async (...args) => {
        expect(JSON.stringify(args[0])).toContain('Configured planning rule');
        return original(...args);
      });
    try {
      const result = await callBoundPlanAuthor(
        name,
        name === 'plan_create'
          ? { goal: 'Read objects', context: 'Use configured rules' }
          : {
              change: 'Read objects',
              context: 'Use configured rules',
              plan: z.json().parse(mockPlan),
            },
      );
      expect(result).not.toMatchObject({ isError: true });
      expect(search).toHaveBeenCalledWith(
        { text: expect.stringContaining('Read objects') },
        4,
        expect.anything(),
      );
      expect(process).toHaveBeenCalled();
    } finally {
      process.mockRestore();
      setup.mockRestore();
    }
  },
);

import {
  clearExecutionLimits,
  currentLimit,
  setExecutionLimits,
} from '../../srv/lib/execution-limits';
import {
  clearRoleModels,
  setRoleModels,
} from '../../srv/lib/role-model-settings';
import { currentRoleModel } from '../../srv/lib/role-models-scope';

let previousAllowlist: string | undefined;
beforeEach(() => {
  previousAllowlist = process.env.LLM_AGENT_MODELS;
});

afterEach(() => {
  if (previousAllowlist === undefined) delete process.env.LLM_AGENT_MODELS;
  else process.env.LLM_AGENT_MODELS = previousAllowlist;
  clearRoleModels('alice', 'owned');
  clearExecutionLimits('alice', 'owned');
});

test('plan_create runs the plan author on the session planner model', async () => {
  process.env.LLM_AGENT_MODELS = 'planner-session';
  setRoleModels('alice', 'owned', { planner: { model: 'planner-session' } });
  const create = jest.spyOn(mockSession, 'callTool');
  jest.mocked(mockCreate).mockImplementationOnce(async () => {
    expect(currentRoleModel('planner')).toBe('planner-session');
    return { ok: true, value: structuredClone(mockPlan) };
  });
  expect(
    (await call('plan_create', { session: 'owned', goal: 'Read' })).isError,
  ).toBeUndefined();
  expect(mockCreate).toHaveBeenCalled();
  create.mockRestore();
});

test('plan_revise runs the plan author on the session planner model', async () => {
  process.env.LLM_AGENT_MODELS = 'planner-session';
  await call('plan_create', { session: 'owned', goal: 'Read' });
  setRoleModels('alice', 'owned', { planner: { model: 'planner-session' } });
  jest.mocked(mockRevise).mockImplementationOnce(async (input) => {
    expect(currentRoleModel('planner')).toBe('planner-session');
    return { ok: true, value: input.plan };
  });
  expect(
    (await call('plan_revise', { session: 'owned', change: 'Read' })).isError,
  ).toBeUndefined();
  expect(mockRevise).toHaveBeenCalled();
});

test('delegate_task to the checker profile runs on the session checker model', async () => {
  process.env.LLM_AGENT_MODELS = 'checker-session';
  await mockSession.close();
  const runner = new AgentProfileRunner({
    catalogue: () => [],
    grants: () => new Set(),
    buildPlanner: async () => {
      throw new Error('No planner expected');
    },
    buildWorker: async (profile) => {
      expect(
        currentRoleModel(profile.result === 'verdict' ? 'checker' : 'executor'),
      ).toBe('checker-session');
      expect(currentLimit('checker', 'maxIterations')).toBe(2);
      return { ...mockWorker, name: 'checker', run: (input) => mockRun(input) };
    },
  });
  mockSession = await DialogueSession.open({
    caller: sessionCaller1,
    id: 'owned',
    planner: { process: async () => ({ ok: true, value: { content: '' } }) },
    board: {
      profileSource: {
        ...mockSource,
        list: async () => ({
          ok: true,
          value: [{ name: 'checker', description: '', result: 'verdict' }],
        }),
        get: async () => ({
          ok: true,
          value: {
            name: 'checker',
            description: '',
            systemPrompt: '',
            tools: 'all',
            result: 'verdict',
          },
        }),
      },
      profileRunner: runner,
    },
    maxCorrections: 0,
  });
  setRoleModels('alice', 'owned', { checker: { model: 'checker-session' } });
  setExecutionLimits('alice', 'owned', { checker: { maxIterations: 2 } });
  mockRun.mockImplementation(async () => {
    expect(currentRoleModel('checker')).toBe('checker-session');
    expect(currentLimit('checker', 'maxIterations')).toBe(2);
    return { output: 'checked' };
  });
  expect(
    await call('delegate_task', {
      session: 'owned',
      worker: 'checker',
      goal: 'Check',
    }),
  ).not.toMatchObject({ isError: true });
  for (let i = 0; i < 50 && !mockRun.mock.calls.length; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockRun).toHaveBeenCalled();
});
