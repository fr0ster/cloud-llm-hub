/**
 * Task 7 — `buildExecutorWorker`: a coordinator-less tool-loop SmartAgent,
 * built the SAME way as `buildAgentForDestination` MINUS any coordinator,
 * wrapped as an `ISubAgent` via the library's own `SmartAgentSubAgent`, and
 * built WITH the shared `RecordingRequestLogger` injected (Verified fact 9 —
 * `SmartAgentSubAgent.run` does not forward a requestLogger to the wrapped
 * agent, so the worker must be BUILT with it).
 *
 * A full live SmartAgent build needs AI Core creds this environment does not
 * have, so `SmartAgentBuilder` and `makeLlm` are mocked to capture what the
 * build path DOES (which methods are called, with what), without doing any
 * network/model work. This still genuinely asserts the three contract
 * points: recLogger injected via `withRequestLogger`, the wrapped result is
 * an `ISubAgent` named 'executor', and no coordinator method is ever called.
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
    makeLlm: jest.fn(async () => ({ chat: jest.fn(), streamChat: jest.fn() })),
  };
});

import type { AgentConfig } from '../../srv/agent-config';
import { buildExecutorWorker } from '../../srv/agent-manager';

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

describe('buildExecutorWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildMock.mockResolvedValue({ agent: fakeAgent, ragStores: {} });
  });

  it('injects the SAME recLogger instance via withRequestLogger', async () => {
    const recLogger = { id: 'the-recording-logger' } as never;
    const mcpAdapter = {} as never;
    const toolsRag = {} as never;

    await buildExecutorWorker(mcpAdapter, toolsRag, config, recLogger);

    expect(withRequestLogger).toHaveBeenCalledTimes(1);
    expect(withRequestLogger).toHaveBeenCalledWith(recLogger);
  });

  it('returns an ISubAgent named "executor" wrapping the built SmartAgent', async () => {
    const recLogger = {} as never;
    const worker = await buildExecutorWorker(
      {} as never,
      {} as never,
      config,
      recLogger,
    );

    expect(worker.name).toBe('executor');
    // SmartAgentSubAgent stores the built agent privately; behavior-check via
    // capabilities, which SmartAgentSubAgent always sets to this fixed shape.
    expect(worker.capabilities).toEqual({ contextPolicy: 'optional' });
  });

  it('never enables a coordinator — plain tool-loop, no self-recursion', async () => {
    const recLogger = {} as never;
    await buildExecutorWorker({} as never, {} as never, config, recLogger);

    expect(withCoordinator).not.toHaveBeenCalled();
    expect(withDagCoordinator).not.toHaveBeenCalled();
  });
});
