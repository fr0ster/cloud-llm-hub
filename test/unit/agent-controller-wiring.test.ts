/**
 * Task 10 — wiring contract for `buildAgentForDestination`: the DAG
 * coordinator (executor worker + reviewer finalizer) must be assembled with
 * the SAME `RecordingRequestLogger` instance flowing into the worker, the
 * controller's `withRequestLogger`, and the `NoticeFinalizer` — Verified fact
 * 9 (a mismatch silently makes the finalizer see zero executed tools, i.e. a
 * false-positive honesty guard on every write). A live build needs AI Core
 * creds this environment does not have, so `SmartAgentBuilder` and `makeLlm`
 * are mocked (same technique as Task 7's `executor-worker.test.ts`) to
 * capture what the build path DOES, without any network/model work.
 */

const withRequestLogger = jest.fn();
const withCoordinator = jest.fn();
const withDagCoordinator = jest.fn();
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
  builder.withToolCache = chainable(jest.fn());
  builder.withMetrics = chainable(jest.fn());
  builder.withSessionManager = chainable(jest.fn());
  builder.withHistorySummarization = chainable(jest.fn());
  builder.withClientAdapter = chainable(jest.fn());
  builder.withRequestLogger = chainable(withRequestLogger);
  builder.withCoordinator = chainable(withCoordinator);
  builder.withDagCoordinator = chainable(withDagCoordinator);
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
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { RecordingRequestLogger } from '../../srv/lib/recording-request-logger';

const config: AgentConfig = {
  llm: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2000,
    apiKey: 'test-key',
    baseUrl: 'http://localhost',
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

  it('injects the SAME RecordingRequestLogger into worker, controller, and finalizer', async () => {
    await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    );

    // withRequestLogger is called twice: once inside buildExecutorWorker
    // (Task 7), once by buildAgentForDestination for the controller itself.
    expect(withRequestLogger).toHaveBeenCalledTimes(2);
    const workerLogger = withRequestLogger.mock.calls[0][0];
    const controllerLogger = withRequestLogger.mock.calls[1][0];

    expect(workerLogger).toBeInstanceOf(RecordingRequestLogger);
    expect(controllerLogger).toBe(workerLogger);

    const deps = withDagCoordinator.mock.calls[0][0];
    const finalizer = deps.finalizer as NoticeFinalizer;
    // NoticeFinalizer holds the logger privately behind a `readonly` ctor
    // param — reaching it is the whole point of this identity assertion.
    expect((finalizer as unknown as { recLogger: unknown }).recLogger).toBe(
      workerLogger,
    );
  });

  it('exposes recLogger on the returned handle (same instance)', async () => {
    const handle = (await agentManager.buildAgentForDestination(
      {} as never,
      {} as never,
      config,
    )) as unknown as { recLogger: unknown };

    const deps = withDagCoordinator.mock.calls[0][0];
    const finalizer = deps.finalizer as unknown as { recLogger: unknown };
    expect(handle.recLogger).toBe(finalizer.recLogger);
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
