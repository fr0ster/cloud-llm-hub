jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: async () => llm,
}));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: {},
  },
}));

import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  type ILlm,
  InMemoryRag,
  type Message,
  type RagCaller,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  PlannerToolsClient,
  unwrapBuilderResult,
} from '@mcp-abap-adt/llm-agent-libs';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildLlmOnlyAgent,
  buildPlannerAgent,
  configureDestinationAgentBuilder,
  ExpositionFilteringRag,
  getSharedHistoryRag,
  initProviders,
} from '../../srv/agent-manager';
import { clientHistoryMessages } from '../../srv/lib/client-history';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { startProviders } from '../../srv/lib/providers';
import { getHubRagAccess } from '../../srv/lib/rag-access';
import { callOptionsFor } from '../../srv/lib/rag-caller';
import { withRagContext } from '../../srv/lib/rag-context-marker';
import { migrateSharedHistory } from '../../srv/lib/session-history-collection';
import { recordTurn } from '../../srv/lib/session-turns';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { legacyProvider } from './helpers/legacy-history-provider';

afterEach(() => {
  jest.restoreAllMocks();
  setLongSessionsForTest(undefined);
});
const seen: Message[][] = [];
const items = Array.from(
  { length: 9 },
  (_, i) => `Named_Item_${i + 1}: ${'detail '.repeat(100)}`,
).join('\n');
const llm: ILlm = {
  chat: async (messages) => {
    seen.push(messages);
    return {
      ok: true,
      value: {
        content:
          messages
            .map((message) => message.content)
            .join('\n')
            .match(/PRIVATE_S[12]/g)
            ?.join(' ') ?? 'Saved fact',
        finishReason: 'stop',
      },
    };
  },
  async *streamChat(messages, tools, options) {
    yield await this.chat(messages, tools, options);
  },
};
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
    model: 'gpt-4o-mini',
    classifierModel: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2000,
    apiKey: 'test-key',
    baseUrl: 'http://localhost',
    whenThrottled: new WaitIfShortEnough(20_000),
  },
  mcp: { destination: 'TEST_DEST', systemDestinations: {} },
  agent: {
    dialogue: {
      executors: 3,
      executorPool: 6,
      maxTasks: 50,
      maxCorrections: 2,
      followMaxMs: 1_800_000,
    },
    chatCoordinator: 'fixed',
    mode: 'smart',
    maxIterations: 10,
    ragType: 'in-memory',
    ragQueryK: 5,
    skillRagK: 3,
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

test.each(
  [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ].flatMap(([migrated, coordinator]) =>
    [false, true].map((embedded) => [migrated, coordinator, embedded]),
  ),
)(
  'production history recall isolates two sessions (migrated=%s, coordinator=%s, embedded=%s)',
  async (migrated, coordinator, embedded) => {
    const providers = await startProviders(config);
    const breaker = new CircuitBreaker();
    const embed = jest.fn(async () => ({ vector: [1, 2] }));
    const embedder = new CircuitBreakerEmbedder({ embed }, breaker);
    initProviders({
      ...providers,
      embedding: embedded
        ? {
            embedder,
            breaker,
            retrieval: symmetricEmbedder(embedder),
            fingerprint: {
              provider: config.llm.provider,
              embeddingModel: config.llm.model,
            },
          }
        : null,
    });
    const callers: RagCaller[] = ['s1', 's2'].map((sessionId) => ({
      userId: 'u1',
      sessionId,
      isAdmin: false,
    }));
    for (const caller of callers)
      await getHubRagAccess().access.bindings.bind(
        caller.sessionId,
        caller.userId,
      );
    const registry = new LongSessionRegistry(
      { ttlMs: 1e15, maxSessions: 10, maxPerUser: 10, queueLength: 1 },
      { onClose: async () => {} },
    );
    for (const caller of callers)
      registry.open(caller.userId, { key: caller.sessionId });
    setLongSessionsForTest(registry);
    const router = getSharedHistoryRag();
    for (const caller of callers)
      await router.forgetSessionHistory(caller.sessionId);
    const provider = legacyProvider(
      migrated
        ? callers.map((caller) => ({
            id: caller.sessionId,
            text: `User: session fact\nAssistant: MIGRATED_${caller.sessionId.toUpperCase()}`,
            metadata: {
              owner: JSON.stringify([caller.userId, caller.sessionId]),
              userId: caller.userId,
              sessionId: caller.sessionId,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          }))
        : [],
      // biome-ignore lint/complexity/useLiteralKeys: Seed the actual production provider without replacing the builder hook.
      router['provider'],
    );
    const writes: Promise<boolean>[] = [];
    const query = jest.spyOn(router, 'query');
    const write = router.recordTurn.bind(router);
    jest.spyOn(router, 'recordTurn').mockImplementation((input) => {
      const pending = write(input);
      writes.push(pending);
      return pending;
    });
    for (const caller of callers) {
      recordTurn(
        caller,
        { role: 'user', content: 'session fact' },
        `PRIVATE_${caller.sessionId.toUpperCase()}\n${items}`,
      );
    }
    expect(await Promise.all(writes)).toEqual([true, true]);
    for (const caller of callers) {
      const stored = await router.listTurns(caller);
      expect(stored).toContainEqual(
        expect.objectContaining({
          userText: 'session fact',
          assistantText: `PRIVATE_${caller.sessionId.toUpperCase()}\n${items}`,
        }),
      );
    }

    const checkRecall = async (afterMigration: boolean) => {
      // A fresh agent has no recent-action memory: recall must read the store.
      const recallBuilder = await configureDestinationAgentBuilder(
        {
          listTools: async () => ({ ok: true, value: [] }),
          callTool: async () => ({ ok: true, value: { content: '' } }),
        },
        new ExpositionFilteringRag(new InMemoryRag()),
        config,
        coordinator ? { skipSkills: true, skipRetrieval: true } : undefined,
      );
      const recall = unwrapBuilderResult(await recallBuilder.build());
      if (coordinator) expect(recall.ragStores.tools).toBeUndefined();
      for (const caller of callers) {
        seen.length = 0;
        const result = await recall.agent.process(
          'recall session fact',
          callOptionsFor(caller),
        );
        if (!result.ok) throw result.error;
        expect(seen).toHaveLength(1);
        const context = JSON.stringify(seen);
        const own = caller.sessionId.toUpperCase();
        const other = own === 'S1' ? 'S2' : 'S1';
        expect(context).toContain(`PRIVATE_${own}`);
        for (let i = 1; i <= 9; i++)
          expect(context).toContain(`Named_Item_${i}`);
        expect(query).toHaveBeenLastCalledWith(
          expect.anything(),
          5,
          expect.objectContaining({
            caller: expect.objectContaining({ sessionId: caller.sessionId }),
          }),
        );
        expect(context).not.toContain(`PRIVATE_${other}`);
        if (migrated && afterMigration) {
          expect(context).toContain(`MIGRATED_${own}`);
          expect(context).not.toContain(`MIGRATED_${other}`);
        }
      }
    };
    const author = await buildPlannerAgent(
      config,
      'Recall the session facts.',
      {
        listTools: async () => ({ ok: true, value: [] }),
        callTool: async () => ({ ok: true, value: { content: '' } }),
      },
      callOptionsFor(callers[0]),
    );
    seen.length = 0;
    const authored = await author.process(
      'recall session fact',
      callOptionsFor(callers[0]),
    );
    if (!authored.ok) throw authored.error;
    expect(JSON.stringify(seen)).toContain('PRIVATE_S1');
    expect(JSON.stringify(seen)).not.toContain('PRIVATE_S2');
    await checkRecall(false);
    expect(await migrateSharedHistory(provider)).toEqual({
      ok: true,
      value: { moved: migrated ? 2 : 0 },
    });
    await checkRecall(true);
    expect(await migrateSharedHistory(provider)).toEqual({
      ok: true,
      value: { moved: 0 },
    });
    for (const caller of callers)
      await router.forgetSessionHistory(caller.sessionId);
  },
);

test.each(
  (['off', 'on'] as const).flatMap((policy) =>
    (['planner', 'author', 'executor', 'controller', 'llm-only'] as const).map(
      (path) => ({ policy, path }),
    ),
  ),
)(
  'exclusive history: $policy / $path / process and stream',
  async ({ policy: clientHistory, path }) => {
    initProviders(await startProviders(config));
    const caller: RagCaller = {
      userId: 'history-user',
      sessionId: `client-history-${clientHistory}-${path}`,
      isAdmin: false,
    };
    await getHubRagAccess().access.bindings.bind(
      caller.sessionId,
      caller.userId,
    );
    const registry = new LongSessionRegistry(
      { ttlMs: 1e15, maxSessions: 10, maxPerUser: 10, queueLength: 1 },
      { onClose: async () => {} },
    );
    registry.open(caller.userId, { key: caller.sessionId });
    setLongSessionsForTest(registry);
    const router = getSharedHistoryRag();
    for (let index = 0; index < 3; index++)
      expect(
        await router.recordTurn({
          caller,
          userText: 'current request',
          assistantText: `RETRIEVED_${index} ${'complete detail '.repeat(600)}`,
        }),
      ).toBe(true);
    const query = jest.spyOn(router, 'query');
    const runConfig: AgentConfig = {
      ...config,
      agent: {
        ...config.agent,
        clientHistory,
        ragQueryK: 2,
        // Off must retain every message in the current turn despite this.
        historyRecencyWindow: clientHistory === 'off' ? 1 : undefined,
      },
    };
    const mcp = {
      listTools: async () => ({ ok: true as const, value: [] }),
      callTool: async () => ({ ok: true as const, value: { content: '' } }),
    };
    const agent =
      path === 'planner' || path === 'author'
        ? await buildPlannerAgent(
            runConfig,
            'Answer the current request.',
            path === 'author' ? mcp : undefined,
          )
        : path === 'llm-only'
          ? (await buildLlmOnlyAgent(runConfig, 'waiting')).agent
          : unwrapBuilderResult(
              await (
                await configureDestinationAgentBuilder(
                  mcp,
                  new ExpositionFilteringRag(new InMemoryRag()),
                  runConfig,
                  path === 'controller'
                    ? { skipSkills: true, skipRetrieval: true }
                    : undefined,
                )
              ).build(),
            ).agent;
    const originalChat = llm.chat.bind(llm);
    const chat = jest
      .spyOn(llm, 'chat')
      .mockImplementation(async (messages, tools, options) => {
        if (
          messages.some((message) =>
            message.content?.includes('Classify the last user request'),
          )
        ) {
          seen.push(messages);
          return {
            ok: true,
            value: {
              content: '{"action":false,"language":"en"}',
              finishReason: 'stop',
            },
          };
        }
        return originalChat(messages, tools, options);
      });
    const current: Message = { role: 'user', content: 'current request' };
    const rounds: Message[] = Array.from(
      { length: clientHistory === 'off' ? 12 : 3 },
      (_, index) => [
        {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: `call-${index}`,
              type: 'function' as const,
              function: { name: 'read', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool' as const,
          content: `TOOL_RESULT_${index} ${'tool detail '.repeat(100)}`,
          tool_call_id: `call-${index}`,
        },
      ],
    ).flat();
    const messages = clientHistoryMessages(
      [
        { role: 'system', content: 'client protocol' },
        { role: 'user', content: 'CLIENT_EARLIER_REQUEST' },
        { role: 'assistant', content: 'CLIENT_EARLIER_ANSWER' },
        current,
        ...rounds,
      ],
      clientHistory,
    );
    let answer = '';
    for (const streaming of [false, true]) {
      seen.length = 0;
      answer = '';
      if (streaming) {
        for await (const chunk of agent.streamProcess(
          messages,
          callOptionsFor(caller),
        )) {
          if (!chunk.ok) throw chunk.error;
          if (chunk.value.content && !chunk.value.ephemeral)
            answer += chunk.value.content;
        }
      } else {
        const result = await agent.process(messages, callOptionsFor(caller));
        if (!result.ok) throw result.error;
        answer = result.value.content;
      }
      expect(seen).toHaveLength(path === 'llm-only' ? 2 : 1);
      const modelMessages = seen[seen.length - 1];
      const context = JSON.stringify(modelMessages);
      expect(context.includes('CLIENT_EARLIER_REQUEST')).toBe(
        clientHistory === 'on',
      );
      expect(context.includes('CLIENT_EARLIER_ANSWER')).toBe(
        clientHistory === 'on',
      );
      expect(
        modelMessages.filter((message) => message.role === 'user'),
      ).toHaveLength(clientHistory === 'off' ? 1 : 2);
      expect(context).toContain('current request');
      if (clientHistory === 'off') {
        expect(context.match(/RETRIEVED_\d/g)).toHaveLength(2);
        expect(context.match(/complete detail /g)).toHaveLength(1200);
        expect(JSON.stringify(seen)).not.toContain('CLIENT_EARLIER');
      } else {
        expect(JSON.stringify(seen)).not.toContain('RETRIEVED_');
        expect(query).not.toHaveBeenCalled();
      }
      for (const round of rounds) {
        if (round.role === 'tool') {
          const delivered = modelMessages.find(
            (message) => message.tool_call_id === round.tool_call_id,
          );
          expect(delivered?.content).toContain(round.content);
        } else {
          expect(modelMessages).toContainEqual(round);
        }
      }
      if (clientHistory === 'off')
        expect(query).toHaveBeenLastCalledWith(
          expect.anything(),
          2,
          expect.objectContaining({ caller }),
        );
    }
    // Use the production completion hook, with collection context attached.
    // Recall waits for the registered write; the stored request stays verbatim.
    recordTurn(caller, withRagContext(current, 'NOT_USER_TEXT'), answer);
    await router.query(
      new TextOnlyEmbedding('current request'),
      2,
      callOptionsFor(caller),
    );
    expect(await router.listTurns(caller)).toContainEqual(
      expect.objectContaining({
        userText: 'current request',
        assistantText: answer,
      }),
    );
    expect(JSON.stringify(await router.listTurns(caller))).not.toContain(
      'NOT_USER_TEXT',
    );
    expect(messages).toHaveLength(
      (clientHistory === 'off' ? 2 : 4) + rounds.length,
    );
    await router.forgetSessionHistory(caller.sessionId);
    chat.mockRestore();
  },
);

test('real dialogue corrections through the production planner retain ORIGINAL_REQUEST constraints', async () => {
  initProviders(await startProviders(config));
  const caller: RagCaller = {
    userId: 'history-user',
    sessionId: 'dialogue-correction',
    isAdmin: false,
  };
  await getHubRagAccess().access.bindings.bind(caller.sessionId, caller.userId);
  const calls: Message[][] = [];
  jest.spyOn(llm, 'chat').mockImplementation(async (messages) => {
    calls.push(messages);
    const result = await new PlannerToolsClient().callTool('plan_update', {
      steps: [{ id: 'read', goal: 'Read table ZSAFE' }],
      status: calls.length === 1 ? 'active' : 'waiting_user',
      ...(calls.length === 1 ? {} : { question: 'Proceed with the read?' }),
    });
    if (!result.ok || result.value.isError)
      throw new Error('plan update failed');
    return {
      ok: true,
      value: { content: 'Plan updated', finishReason: 'stop' },
    };
  });
  const planner = await buildPlannerAgent(
    { ...config, agent: { ...config.agent, clientHistory: 'off' } },
    'Keep the original request constraints during corrections.',
    new PlannerToolsClient(),
  );
  const session = await DialogueSession.open({
    id: caller.sessionId,
    caller,
    planner,
    maxCorrections: 2,
    board: { workers: new Map(), maxConcurrent: 1, maxTasks: 10 },
  });
  try {
    await session.send('ORIGINAL_REQUEST: only read table ZSAFE; never write.');
    expect(calls).toHaveLength(2);
    const correction = JSON.stringify(calls[1]);
    expect(correction).toContain(
      'ORIGINAL_REQUEST: only read table ZSAFE; never write.',
    );
    expect(correction).toContain('[actions]');
    expect(correction).toContain('[check]');
  } finally {
    await session.close();
  }
});
