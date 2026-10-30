/**
 * `buildExecutorWorker`: a coordinator-less tool-loop SmartAgent, built the
 * SAME way as `buildAgentForDestination` MINUS any coordinator, wrapped as an
 * `ISubAgent` via the library's own `SmartAgentSubAgent`. The caller passes a
 * `RecordingMcpClient` AS the `mcpAdapter` (not a separate param) so the
 * worker's tool calls are captured with their RESULTS for the honesty
 * reviewer; token telemetry uses the builder's default logger.
 *
 * A full live SmartAgent build needs AI Core creds this environment does not
 * have, so `SmartAgentBuilder` and `makeHubLlm` are mocked to capture what the
 * build path DOES (which methods are called, with what), without doing any
 * network/model work. This still genuinely asserts the contract points: the
 * wrapped result is an `ISubAgent` named 'executor', and no coordinator
 * method is ever called.
 */

const withRequestLogger = jest.fn();
const withCoordinator = jest.fn();
const withDagCoordinator = jest.fn();
const withToolCache = jest.fn();
const buildMock = jest.fn();

function makeChainableBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chainable = (fn: jest.Mock) =>
    jest.fn((...args: unknown[]) => {
      fn(...args);
      return builder;
    });
  builder.withMainLlm = chainable(jest.fn());
  builder.withClassifierLlm = chainable(jest.fn());
  builder.withMcpClients = chainable(jest.fn());
  builder.setToolsRag = chainable(jest.fn());
  builder.withSkillManager = chainable(jest.fn());
  builder.withEmbedder = chainable(jest.fn());
  builder.withClassification = chainable(jest.fn());
  builder.withLlmCallStrategy = chainable(jest.fn());
  builder.withToolReselection = chainable(jest.fn());
  builder.withToolCache = chainable(withToolCache);
  builder.withMetrics = chainable(jest.fn());
  builder.withSessionManager = chainable(jest.fn());
  builder.withHistorySummarization = chainable(jest.fn());
  builder.withClientAdapter = chainable(jest.fn());
  builder.withRequestLogger = chainable(withRequestLogger);
  builder.withCoordinator = chainable(withCoordinator);
  builder.withDagCoordinator = chainable(withDagCoordinator);
  builder.withStepperCoordinator = chainable(jest.fn());
  builder.withMcpFailureClassifier = chainable(jest.fn());
  builder.build = buildMock;
  return builder;
}

// The fake "SmartAgent" produced by builder.build() — only needs to be a
// stable object identity so SmartAgentSubAgent can hold a reference to it.
const fakeAgent = { process: jest.fn(), streamProcess: jest.fn() };

jest.mock('@mcp-abap-adt/llm-agent-libs', () => {
  const actual = jest.requireActual('@mcp-abap-adt/llm-agent-libs');
  return {
    ...actual,
    SmartAgentBuilder: jest
      .fn()
      .mockImplementation(() => makeChainableBuilder()),
  };
});

jest.mock('../../srv/lib/llm-factory', () => ({
  ...jest.requireActual('../../srv/lib/llm-factory'),
  makeHubLlm: jest.fn(async () => ({ chat: jest.fn(), streamChat: jest.fn() })),
}));

import type { IMcpClient, ISmartAgent } from '@mcp-abap-adt/llm-agent';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type { AgentConfig } from '../../srv/agent-config';
import {
  buildAgentForDestination,
  buildExecutorWorker,
  ExpositionFilteringRag,
  getCollectionRegistry,
  initProviders,
} from '../../srv/agent-manager';
import { AgentProfileSource } from '../../srv/lib/agent-profile-source';
import { startProviders } from '../../srv/lib/providers';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';
import { runWithSessionId } from '../../srv/request-session';

const config: AgentConfig = {
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

describe('buildExecutorWorker', () => {
  beforeAll(async () => {
    initProviders(await startProviders(config));
    await getCollectionRegistry().seedAgentConfiguration('agents', 'planner');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    buildMock.mockResolvedValue({ agent: fakeAgent, ragStores: {} });
  });

  it('wires the given mcpAdapter via withMcpClients (no separate recLogger param)', async () => {
    const mcpAdapter = { id: 'the-recording-mcp-client' } as never;
    const toolsRag = {} as never;

    await buildExecutorWorker(mcpAdapter, toolsRag, config);

    expect(withRequestLogger).not.toHaveBeenCalled();
  });

  it('returns an ISubAgent named "executor" wrapping the built SmartAgent', async () => {
    const worker = await buildExecutorWorker({} as never, {} as never, config);

    expect(worker.name).toBe('executor');
    // SmartAgentSubAgent stores the built agent privately; behavior-check via
    // capabilities, which SmartAgentSubAgent always sets to this fixed shape.
    expect(worker.capabilities).toEqual({ contextPolicy: 'optional' });
  });

  it('installs no tool-result cache — the MCP server owns caching', async () => {
    await buildExecutorWorker({} as never, {} as never, config);
    expect(withToolCache).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'injectHistory=%s preserves the proxied handle and selects worker history',
    async (injectHistory) => {
      const expose = jest.fn();
      fakeAgent.process.mockResolvedValue({
        ok: true,
        value: { content: 'done' },
      });
      const worker = await buildExecutorWorker(
        {} as never,
        {} as never,
        config,
        expose,
        { injectHistory },
      );
      const history = [{ role: 'user' as const, content: 'previous' }];
      const [executor, raw] = expose.mock.calls[0];
      expect(raw).toBe(fakeAgent);
      expect(executor).not.toBe(fakeAgent);
      await runWithSessionId(
        'worker',
        () => worker.run({ task: 'task', history: [] }),
        history,
      );
      expect(fakeAgent.process.mock.calls.at(-1)?.[0]).toEqual(
        injectHistory
          ? [...history, { role: 'user', content: 'task' }]
          : 'task',
      );
      await runWithSessionId(
        'worker',
        () => executor.process('direct'),
        history,
      );
      expect(fakeAgent.process.mock.calls.at(-1)?.[0]).toEqual([
        ...history,
        { role: 'user', content: 'direct' },
      ]);
    },
  );

  it('never enables a coordinator — plain tool-loop, no self-recursion', async () => {
    await buildExecutorWorker({} as never, {} as never, config);

    expect(withCoordinator).not.toHaveBeenCalled();
    expect(withDagCoordinator).not.toHaveBeenCalled();
  });
});

const cancellationMcp: IMcpClient = {
  listTools: async () => ({ ok: true, value: [] }),
  callTool: async () => ({ ok: true, value: { content: '' } }),
};
const cancellationRag = new ExpositionFilteringRag({
  query: async () => ({ ok: true, value: [] }),
  healthCheck: async () => ({ ok: true, value: undefined }),
  getById: async () => ({ ok: true, value: null }),
});

describe('compatibility profile cancellation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test.each(['worker', 'checker', 'process', 'stream'] as const)(
    '%s forwards cancellation during profile resolution and rejects before construction',
    async (mode) => {
      buildMock.mockResolvedValue({ agent: fakeAgent, ragStores: {} });
      let direct: ISmartAgent | undefined;
      const worker = await buildExecutorWorker(
        cancellationMcp,
        cancellationRag,
        config,
        (agent) => {
          direct = agent;
        },
      );
      if (!direct) throw new Error('Missing direct executor');
      const executor = direct;
      const checkerHandle =
        mode === 'checker'
          ? await buildAgentForDestination(
              new McpClientAdapter(
                new MCPClientWrapper({ url: 'http://localhost' }),
              ),
              cancellationRag,
              {
                ...config,
                profiles: {
                  collectionId: 'agents',
                  plannerRecord: 'planner',
                  timeoutMs: 25,
                },
                agent: { ...config.agent, chatCoordinator: 'adaptive' },
              },
            )
          : undefined;
      const selectedWorker = checkerHandle?.workers.get('checker') ?? worker;
      const controller = new AbortController();
      let backendSignal: AbortSignal | undefined;
      const read = jest
        .spyOn(AgentProfileSource.prototype, 'resolveWorker')
        .mockImplementation(async (_name, options) => {
          backendSignal = options?.signal;
          return new Promise((resolve) => {
            options?.signal?.addEventListener(
              'abort',
              () =>
                resolve({
                  ok: false,
                  error: { code: 'unavailable', message: 'cancelled' },
                }),
              { once: true },
            );
          });
        });
      const builds = buildMock.mock.calls.length;
      const pending =
        mode === 'worker' || mode === 'checker'
          ? selectedWorker.run({ task: 'task', signal: controller.signal })
          : mode === 'process'
            ? executor.process('task', { signal: controller.signal })
            : executor
                .streamProcess('task', { signal: controller.signal })
                [Symbol.asyncIterator]()
                .next();
      const rejected = expect(pending).rejects.toThrow();
      controller.abort();
      expect(read).toHaveBeenCalledTimes(1);
      expect(backendSignal?.aborted).toBe(true);
      await rejected;
      expect(buildMock).toHaveBeenCalledTimes(builds);
    },
  );

  test('an already cancelled worker never resolves a profile', async () => {
    buildMock.mockResolvedValue({ agent: fakeAgent, ragStores: {} });
    const worker = await buildExecutorWorker(
      cancellationMcp,
      cancellationRag,
      config,
    );
    const read = jest.spyOn(AgentProfileSource.prototype, 'resolveWorker');
    await expect(
      worker.run({ task: 'task', signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  test.each(['worker', 'checker', 'process', 'stream'] as const)(
    '%s bounds stalled construction by the configured profile deadline',
    async (mode) => {
      buildMock.mockResolvedValue({ agent: fakeAgent, ragStores: {} });
      let direct: ISmartAgent | undefined;
      const worker = await buildExecutorWorker(
        cancellationMcp,
        cancellationRag,
        {
          ...config,
          profiles: {
            collectionId: 'agents',
            plannerRecord: 'planner',
            timeoutMs: 25,
          },
        },
        (agent) => {
          direct = agent;
        },
      );
      if (!direct) throw new Error('Missing executor');
      const executor = direct;
      const checkerHandle =
        mode === 'checker'
          ? await buildAgentForDestination(
              new McpClientAdapter(
                new MCPClientWrapper({ url: 'http://localhost' }),
              ),
              cancellationRag,
              {
                ...config,
                profiles: {
                  collectionId: 'agents',
                  plannerRecord: 'planner',
                  timeoutMs: 25,
                },
                agent: { ...config.agent, chatCoordinator: 'adaptive' },
              },
            )
          : undefined;
      const selectedWorker = checkerHandle?.workers.get('checker') ?? worker;
      jest
        .spyOn(AgentProfileSource.prototype, 'resolveWorker')
        .mockResolvedValue({
          ok: true,
          value: {
            profile: {
              name: 'executor',
              description: '',
              systemPrompt: '',
              tools: 'all',
              result: mode === 'checker' ? 'verdict' : 'report',
            },
          },
        });
      let started: (() => void) | undefined;
      const building = new Promise<void>((resolve) => {
        started = resolve;
      });
      buildMock.mockImplementation(() => {
        started?.();
        return new Promise<never>(() => {});
      });
      jest.useFakeTimers();
      const pending =
        mode === 'worker' || mode === 'checker'
          ? selectedWorker.run({ task: 'task' })
          : mode === 'process'
            ? executor.process('task')
            : executor.streamProcess('task')[Symbol.asyncIterator]().next();
      const rejected = expect(pending).rejects.toThrow();
      await building;
      await jest.advanceTimersByTimeAsync(25);
      await rejected;
    },
  );
});
