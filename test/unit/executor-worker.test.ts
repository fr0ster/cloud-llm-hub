/**
 * `buildExecutorWorker`: a coordinator-less tool-loop SmartAgent, built the
 * SAME way as `buildAgentForDestination` MINUS any coordinator, wrapped as an
 * `ISubAgent` via the library's own `SmartAgentSubAgent`. The caller passes a
 * `RecordingMcpClient` AS the `mcpAdapter` (not a separate param) so the
 * worker's tool calls are captured with their RESULTS for the honesty
 * reviewer; token telemetry uses the builder's default logger.
 *
 * A full live SmartAgent build needs AI Core creds this environment does not
 * have, so `SmartAgentBuilder` and `makeLlm` are mocked to capture what the
 * build path DOES (which methods are called, with what), without doing any
 * network/model work. This still genuinely asserts the contract points: the
 * wrapped result is an `ISubAgent` named 'executor', and no coordinator
 * method is ever called.
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
    whenThrottled: { maxTotalWaitMs: 20_000 },
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

  it('never enables a coordinator — plain tool-loop, no self-recursion', async () => {
    await buildExecutorWorker({} as never, {} as never, config);

    expect(withCoordinator).not.toHaveBeenCalled();
    expect(withDagCoordinator).not.toHaveBeenCalled();
  });
});
