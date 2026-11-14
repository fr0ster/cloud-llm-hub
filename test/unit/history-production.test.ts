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
  type ILlm,
  InMemoryRag,
  type Message,
  type RagCaller,
} from '@mcp-abap-adt/llm-agent';
import { unwrapBuilderResult } from '@mcp-abap-adt/llm-agent-libs';
import type { AgentConfig } from '../../srv/agent-config';
import {
  configureDestinationAgentBuilder,
  ExpositionFilteringRag,
  getSharedHistoryRag,
  initProviders,
} from '../../srv/agent-manager';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { startProviders } from '../../srv/lib/providers';
import { getHubRagAccess } from '../../srv/lib/rag-access';
import { callOptionsFor } from '../../srv/lib/rag-caller';
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

test.each([false, true])(
  'production history recall isolates two sessions (migrated=%s)',
  async (migrated) => {
    initProviders(await startProviders(config));
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
      );
      const recall = unwrapBuilderResult(await recallBuilder.build());
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
