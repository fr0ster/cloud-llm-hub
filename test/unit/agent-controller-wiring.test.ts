/**
 * Wiring contract for `buildAgentForDestination`: the DAG coordinator
 * (executor worker + reviewer finalizer) must be assembled with a
 * `RecordingMcpClient` wrapping the destination's mcpAdapter, passed AS the
 * mcpAdapter into the executor worker (so the worker's tool calls — with
 * their RESULTS — are captured), and the SAME instance handed to the
 * `NoticeFinalizer` so its ground truth reflects what the worker actually
 * ran. A live build needs AI Core creds this environment does not have, so
 * `SmartAgentBuilder` and `makeLlm` are mocked (same technique as
 * `executor-worker.test.ts`) to capture what the build path DOES, without
 * any network/model work.
 */

const withRequestLogger = jest.fn();
const withCoordinator = jest.fn();
const withDagCoordinator = jest.fn();
const withSkillManager = jest.fn();
const withMcpClients = jest.fn();
const withMcpFailureClassifier = jest.fn();
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
  builder.withMcpClients = chainable(withMcpClients);
  builder.setToolsRag = chainable(jest.fn());
  builder.withSkillManager = chainable(withSkillManager);
  builder.withEmbedder = chainable(jest.fn());
  builder.withClassification = chainable(jest.fn());
  builder.withLlmCallStrategy = chainable(jest.fn());
  builder.withToolReselection = chainable(jest.fn());
  builder.withToolCache = chainable(jest.fn());
  builder.withMetrics = chainable(jest.fn());
  builder.withSessionManager = chainable(jest.fn());
  builder.withHistorySummarization = chainable(jest.fn());
  builder.withClientAdapter = chainable(jest.fn());
  builder.withRequestLogger = chainable(withRequestLogger);
  builder.withCoordinator = chainable(withCoordinator);
  builder.withDagCoordinator = chainable(withDagCoordinator);
  builder.withMcpFailureClassifier = chainable(withMcpFailureClassifier);
  builder.build = buildMock;
  return builder;
}

// Each build() call gets its own fake agent object — the worker build and the
// controller build both call builder.build(), and we need to tell them apart.
const workerAgent = { process: jest.fn(), streamProcess: jest.fn() };
const controllerAgent = { process: jest.fn(), streamProcess: jest.fn() };

jest.mock('@mcp-abap-adt/llm-agent-libs', () => {
  const actual = jest.requireActual('@mcp-abap-adt/llm-agent-libs');
  return {
    ...actual,
    SmartAgentBuilder: jest
      .fn()
      .mockImplementation(() => makeChainableBuilder()),
    makeLlm: jest.fn(async () => ({ chat: jest.fn(), streamChat: jest.fn() })),
  };
});

import { DagPlanInterpreter } from '@mcp-abap-adt/llm-agent-libs';
import type { AgentConfig } from '../../srv/agent-config';
// buildAgentForDestination is exported (like buildExecutorWorker) purely so
// this wiring contract can be driven directly, without going through the
// full destination-initialization path.
import * as agentManager from '../../srv/agent-manager';
import { FixedExecutorPlanner } from '../../srv/lib/fixed-executor-planner';
import { outageClassifier } from '../../srv/lib/mcp-outage';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { WaitIfShortEnough } from '../../srv/lib/throttle-strategy';

const config: AgentConfig = {
  llm: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2000,
    apiKey: 'test-key',
    baseUrl: 'http://localhost',
    whenThrottled: new WaitIfShortEnough(20_000),
  },
  mcp: { destination: 'TEST_DEST' },
  agent: {
    mode: 'smart',
    maxIterations: 10,
    ragType: 'in-memory',
    ragQueryK: 5,
  },
};

describe('buildAgentForDestination — DAG coordinator wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // First build() call is the executor worker (buildExecutorWorker), the
    // second is the top-level controller — matches call order in the wiring.
    buildMock
      .mockResolvedValueOnce({ agent: workerAgent, ragStores: {} })
      .mockResolvedValueOnce({ agent: controllerAgent, ragStores: {} });
  });

  it('wires withDagCoordinator exactly once with the correct dep shapes', async () => {
    const handle = await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    expect(withDagCoordinator).toHaveBeenCalledTimes(1);
    const deps = withDagCoordinator.mock.calls[0][0];

    expect(deps.planner).toBeInstanceOf(FixedExecutorPlanner);
    expect(deps.interpreter).toBeInstanceOf(DagPlanInterpreter);
    expect(deps.workers).toBeInstanceOf(Map);
    expect(deps.workers.has('executor')).toBe(true);
    expect(deps.workers.size).toBe(1);
    expect(deps.finalizer).toBeInstanceOf(NoticeFinalizer);

    expect(handle).toBeDefined();
  });

  it('never calls withRequestLogger — RecordingRequestLogger is gone', async () => {
    await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    expect(withRequestLogger).not.toHaveBeenCalled();
  });

  it('wires a RecordingMcpClient into the worker (withMcpClients) and into the finalizer — same instance', async () => {
    await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    // withMcpClients is called twice: once inside buildExecutorWorker (via
    // configureDestinationAgentBuilder), once for the controller build.
    expect(withMcpClients).toHaveBeenCalledTimes(2);
    const workerMcpClients = withMcpClients.mock.calls[0][0];
    expect(workerMcpClients[0]).toBeInstanceOf(RecordingMcpClient);

    const deps = withDagCoordinator.mock.calls[0][0];
    const finalizer = deps.finalizer as unknown as { recMcp: unknown };
    expect(finalizer.recMcp).toBe(workerMcpClients[0]);
  });

  it('exposes recMcp on the returned handle (same instance the finalizer holds)', async () => {
    const handle = (await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    )) as unknown as { recMcp: unknown };

    const deps = withDagCoordinator.mock.calls[0][0];
    const finalizer = deps.finalizer as unknown as { recMcp: unknown };
    expect(handle.recMcp).toBe(finalizer.recMcp);
  });

  it('binds the worker under the key "executor" — matches the planner node', async () => {
    await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    const deps = withDagCoordinator.mock.calls[0][0];
    const plan = await new FixedExecutorPlanner().plan({
      prompt: 'x',
      agents: [],
      sessionId: 's',
    } as never);
    expect(plan.plan.nodes[0].agent).toBe('executor');
    expect(deps.workers.has(plan.plan.nodes[0].agent)).toBe(true);
  });

  it('vectorizes skills for the worker build only — controller build skips them', async () => {
    // The controller's tool-loop stage is gated off whenever the DAG
    // coordinator is active (default-pipeline.js: `when:'!coordinatorActive'`),
    // so its skill vectorization would be 100% wasted real-embedding cost
    // (18 skills) on every destination init. Only the executor worker build
    // (buildExecutorWorker, called first) should wire a skill manager.
    await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    expect(withSkillManager).toHaveBeenCalledTimes(1);
  });

  it('buildExecutorWorker alone still wires skills (worker keeps them enabled)', async () => {
    buildMock.mockReset();
    buildMock.mockResolvedValueOnce({ agent: workerAgent, ragStores: {} });

    await agentManager.buildExecutorWorker({} as never, {} as never, config);

    expect(withSkillManager).toHaveBeenCalledTimes(1);
  });

  // NOTE: a "wires outageClassifier into the executor worker's builder via
  // buildAgentForDestination" test used to live here, asserting on
  // `withMcpFailureClassifier.mock.calls[0][0]`. Removed: it passes even
  // against the WRONG wiring (the classifier installed only on the
  // DAG-coordinator's own controller builder, never reaching the worker's
  // tool loop) whenever that is the ONLY call `configureDestinationAgentBuilder`
  // makes in the mock's build order — `calls[0]` is still the (sole) call,
  // with the right argument, so the assertion is satisfied by an
  // indistinguishable wrong implementation. The test below — calling
  // `buildExecutorWorker` DIRECTLY, with no controller build in the picture
  // at all — is the one that actually proves the worker's builder gets it.
  it('buildExecutorWorker alone still wires the failure classifier', async () => {
    buildMock.mockReset();
    buildMock.mockResolvedValueOnce({ agent: workerAgent, ragStores: {} });

    await agentManager.buildExecutorWorker({} as never, {} as never, config);

    expect(withMcpFailureClassifier).toHaveBeenCalledWith(outageClassifier);
  });

  it('buildLlmOnlyAgent never wires a coordinator', async () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../srv/agent-manager.ts'),
      'utf-8',
    );
    const start = src.indexOf('async function buildLlmOnlyAgent');
    expect(start).toBeGreaterThan(-1);
    // Slice from buildLlmOnlyAgent to the next top-level function to scope
    // the search to just that function body.
    const rest = src.slice(start);
    const nextFnRelative = rest.indexOf('\nasync function ', 1);
    const nextFn2Relative = rest.indexOf('\nfunction ', 1);
    const candidates = [nextFnRelative, nextFn2Relative].filter((n) => n > -1);
    const end = candidates.length ? Math.min(...candidates) : rest.length;
    const body = rest.slice(0, end);

    expect(body).not.toContain('withDagCoordinator');
    expect(body).not.toContain('withCoordinator');
  });
});
