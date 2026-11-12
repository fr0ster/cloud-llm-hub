const taskCaller = {
  sessionId: 'test-session',
  userId: 'test-user',
  isAdmin: false,
};

import type { ISmartAgent, WorkerProfile } from '@mcp-abap-adt/llm-agent';
import { formatTrustTag, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { AgentProfileRunner } from '../../srv/lib/agent-profile-runner';
import { AgentProfileSource } from '../../srv/lib/agent-profile-source';
import { isTrustStore, WRITTEN_BY } from '../../srv/lib/collection-persistence';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { resolverFor, TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import type { RagDocument } from '../../srv/rag-collections';

test('source and record values, live inheritance, history and restart', async () => {
  const rag = new InMemoryRag();
  const store = new TrustStore(rag, 3);
  const resolver = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
  );
  await store.setSource('skills', 4, 'admin');
  await store.setRecord('skills', 'a', 1.5, 'admin');
  expect(await resolver.skill('a')).toBe(1.5);
  expect(await resolver.skill('b')).toBe(4);
  await store.setRecord('skills', 'a', null, 'admin');
  expect(await resolver.skill('a')).toBe(4);
  const restored = new TrustStore(rag, 3);
  expect(await restored.getSource('skills')).toBe(4);
  expect(await restored.getRecordHistory('skills', 'a')).toHaveLength(2);
  for (let n = 0; n < 25; n++) await store.setSource('skills', n % 5, 'admin');
  expect(await restored.getSourceHistory('skills')).toHaveLength(20);
});
test('role maps are separate', () => {
  const resolver = new TrustResolver(
    undefined,
    undefined,
    parseTrustDefaults(undefined),
  );
  for (const value of [1, 2, 3, 4, 5])
    expect(
      resolver.forProfile({ trust: { target: value } }).systemTool('GetClass'),
    ).toBe(value);
  expect(resolver.systemTool('GetClass')).toBe(4.3);
});

test('writes touch only their own key and reads never use a facade cache', async () => {
  const rag = new InMemoryRag();
  const write = jest.spyOn(rag, 'upsert');
  const read = jest.spyOn(rag, 'getById');
  const store = new TrustStore(rag, 3);
  await store.setRecord('skills', 'one', 1, 'admin');
  write.mockClear();
  await store.setRecord('skills', 'two', 2, 'admin');
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[1]).toEqual({ id: 'record:skills:two' });
  read.mockClear();
  expect(await store.getRecord('skills', 'one')).toBe(1);
  expect(await store.getRecord('skills', 'one')).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test('five role maps remain bound through coordinator, author, executor and checker calls', async () => {
  const root = new TrustResolver(
    undefined,
    undefined,
    parseTrustDefaults(undefined),
  );
  const current = () =>
    resolverFor({ currentMeta: () => undefined }).classDefault('user');
  const observed: string[] = [];
  const roleRecord = (
    name: string,
    kind: string,
    value: number,
  ): RagDocument => ({
    id: name,
    text: name,
    createdAt: '',
    metadata: {
      canonicalKey: name,
      name,
      kind,
      trust: { user: value },
      ...(kind === 'profile'
        ? {
            description: '',
            tools: 'read-only',
            result: name === 'checker' ? 'verdict' : 'report',
          }
        : {}),
    },
  });
  const source = new AgentProfileSource(
    {
      readAgentCollection: async () => ({
        meta: {
          id: 'agents',
          logicalId: 'agents',
          displayName: 'Agents',
          description: '',
          scope: 'global',
          collectionKind: 'agents',
          createdAt: '',
          documentCount: 6,
          sourceCount: 6,
        },
        documents: [
          {
            id: '_worker-base',
            text: '',
            createdAt: '',
            metadata: {
              canonicalKey: '_worker-base',
              name: '_worker-base',
              kind: 'worker-base',
            },
          },
          roleRecord('coordinator', 'coordinator', 1),
          roleRecord('planner-create', 'planner-author', 2),
          roleRecord('planner-revise', 'planner-author', 3),
          roleRecord('executor', 'profile', 4),
          roleRecord('checker', 'profile', 5),
        ],
      }),
    },
    {
      userId: 'alice',
      globalCollectionId: 'agents',
      selectedCollectionId: () => 'agents',
      plannerRecord: 'coordinator',
      timeoutMs: 3000,
    },
  );
  const prompts = await source.getPrompts();
  if (!prompts.ok) throw new Error(prompts.error.message);
  const agent = (): ISmartAgent => ({
    process: async () => {
      await Promise.resolve();
      observed.push(formatTrustTag('user:Notes/r', current()));
      return {
        ok: true,
        value: {
          content: '',
          iterations: 0,
          toolCallCount: 0,
          stopReason: 'stop',
        },
      };
    },
    streamProcess: async function* () {},
  });
  const runner = new AgentProfileRunner({
    trustResolver: () => root,
    catalogue: () =>
      ['rag_search', 'rag_read', 'collection_records', 'collections_list'].map(
        (name) => ({ name, effect: 'read' }),
      ),
    grants: () => new Set(),
    buildPlanner: async () => agent(),
    buildPlanAuthor: async () => agent(),
    buildWorker: async (profile) => ({
      name: profile.name,
      capabilities: { contextPolicy: 'optional' },
      run: async () => {
        observed.push(formatTrustTag('user:Notes/r', current()));
        return { output: '' };
      },
    }),
  });
  const coordinator = await runner.preparePlanner({
    systemPrompt: '',
    trust: prompts.value.trust?.coordinator,
  });
  const create = await runner.preparePlanAuthor({
    systemPrompt: '',
    mode: 'create',
    trust: prompts.value.trust?.plannerCreate,
  });
  const revise = await runner.preparePlanAuthor({
    systemPrompt: '',
    mode: 'revise',
    trust: prompts.value.trust?.plannerRevise,
  });
  for (const result of [coordinator, create, revise]) {
    if (!result.ok) throw new Error(result.error.message);
    await result.value.process('test', {
      caller: taskCaller,
      sessionId: taskCaller.sessionId,
    });
  }
  for (const [name, value] of [
    ['executor', 4],
    ['checker', 5],
  ] as const) {
    const resolved = await source.get(name);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const profile: WorkerProfile = resolved.value;
    expect(profile.trust?.user).toBe(value);
    const worker = await runner.createWorker({ profile });
    if (!worker.ok) throw new Error(worker.error.message);
    await worker.value.run({ caller: taskCaller, task: 'test' });
  }
  expect(observed).toEqual(
    [1, 2, 3, 4, 5].map((value) => `[source: user:Notes/r; trust ${value}]`),
  );
  expect(root.classDefault('user')).toBe(3.5);
});

test('rebinding a role starts from deploy defaults rather than the previous role map', () => {
  const root = new TrustResolver(
    undefined,
    undefined,
    parseTrustDefaults(undefined),
  );
  const coordinator = root.forProfile({ trust: { user: 5 } });
  expect(
    coordinator.forProfile({ trust: { docs: 4 } }).classDefault('user'),
  ).toBe(3.5);
});

test('orphan sweep recognizes prefixed trust stores', () => {
  const record = {
    storeName: 'deployment_h_trust',
    name: 'h_trust',
    scope: 'global',
    attributes: { writtenBy: WRITTEN_BY, source: 'trust' },
  } as const;
  expect(isTrustStore(record, 'deployment')).toBe(true);
  expect(isTrustStore(record)).toBe(false);
});
