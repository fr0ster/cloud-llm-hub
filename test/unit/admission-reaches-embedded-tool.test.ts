/**
 * The admission's register reaches the real tool dispatch.
 *
 * Teardown waits for the register to empty before `safeStop` closes the ADT
 * session. The channel tests prove that order with a pipeline that calls
 * `trackCall` itself; what they cannot prove is that a real pipeline's tool
 * call registers at all. That depends on AsyncLocalStorage surviving every hop
 * from `admitPipeline(...).run` through the SmartAgent, the DAG coordinator,
 * the executor worker and the MCP adapter into `invokeEmbeddedTool`. If any hop
 * ran the worker from a context captured outside the scope, `drain()` would
 * resolve at once and `safeStop` would close the ADT session under a live
 * write — the recorded cause of the orphaned locks.
 *
 * So this builds the destination agent the way production does, through
 * `getSmartAgent`, with only the edges faked: the LLM (answering by what it is
 * offered), the destination lookup, and the embedded tool handlers, each of
 * which holds its promise open until the test lets it go.
 */

const mockTool = {
  calls: [] as string[],
  release: (() => {}) as () => void,
  gate: Promise.resolve() as Promise<void>,
  hold() {
    mockTool.gate = new Promise<void>((r) => {
      mockTool.release = r;
    });
  },
};

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: { user: { id: 'alice', is: () => true } },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    proxyType: 'Internet',
    authenticationType: 'BasicAuthentication',
    sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
    destinationName: 'DEST',
  }),
}));
jest.mock('../../srv/lib/btp-destinations', () => ({
  getAvailableDestinations: async () => [],
}));
// The real exporter, so the real tool names and exposition groups; only the
// handlers are replaced, each by one that holds its promise open.
jest.mock('@mcp-abap-adt/lib/handlers', () => {
  const actual = jest.requireActual('@mcp-abap-adt/lib/handlers');
  class HandlerExporter extends actual.HandlerExporter {
    getHandlerEntries() {
      return super
        .getHandlerEntries()
        .map((e: { toolDefinition: { name: string } }) => ({
          ...e,
          handler: async (_context: unknown, _args: unknown) => {
            mockTool.calls.push(e.toolDefinition.name);
            await mockTool.gate;
            return { content: [{ type: 'text', text: 'written' }] };
          },
        }));
    }
  }
  return { ...actual, HandlerExporter };
});
// One LLM for every role, answering by what it is offered: a call to the first
// offered tool until a tool result is in the conversation, plain text otherwise.
jest.mock('@mcp-abap-adt/llm-agent-libs', () => {
  const actual = jest.requireActual('@mcp-abap-adt/llm-agent-libs');
  const answer = (
    messages: Array<{ role: string }>,
    tools?: Array<{ name: string }>,
  ) => {
    const offered = (tools ?? []).filter((t) => t.name !== 'GetDumpSection');
    if (offered.length > 0 && !messages.some((m) => m.role === 'tool')) {
      return {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ id: 'call-1', name: offered[0].name, arguments: {} }],
          finishReason: 'tool_calls',
        },
      };
    }
    return { ok: true, value: { content: 'done', finishReason: 'stop' } };
  };
  const llm = {
    model: 'fake',
    async chat(
      messages: Array<{ role: string }>,
      tools?: Array<{ name: string }>,
    ) {
      return answer(messages, tools);
    },
    // The tool loop streams first (FallbackLlmCallStrategy): this is the call
    // that is offered the selected tools.
    async *streamChat(
      messages: Array<{ role: string }>,
      tools?: Array<{ name: string }>,
    ) {
      yield answer(messages, tools);
    },
  };
  return { ...actual, makeLlm: async () => llm };
});

process.env.LLM_AGENT_PROVIDER = 'openai';
process.env.LLM_AGENT_API_KEY = 'test';
process.env.LLM_AGENT_BASE_URL = 'http://llm.invalid';
process.env.LLM_AGENT_RAG_TYPE = 'in-memory';
process.env.LLM_AGENT_MCP_DESTINATION = '';
process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '1';

const manager =
  require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
const gatekeeper =
  require('../../srv/lib/gatekeeper') as typeof import('../../srv/lib/gatekeeper');
const { HANDLER_GROUPS } =
  require('../../srv/lib/tool-exposition-map') as typeof import('../../srv/lib/tool-exposition-map');

const tick = () => new Promise((r) => setImmediate(r));

async function until(condition: () => boolean, turns = 2000) {
  for (let i = 0; i < turns && !condition(); i++) await tick();
  return condition();
}

afterAll(async () => {
  mockTool.release();
  await manager.closeSmartAgent();
  manager.clearDestinationStatesForTest();
  gatekeeper.resetGatekeeperForTest();
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
});

describe('an admitted pipeline built by getSmartAgent', () => {
  it('registers its embedded tool call, and drain waits for it', async () => {
    // `getSmartAgent` races the destination's initialisation against a bounded
    // wait whose timer it never clears. Unref'd for this call only, so the
    // timer cannot keep Jest running for the rest of that wait.
    const realSetTimeout = global.setTimeout;
    const unrefTimers = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((...args: Parameters<typeof setTimeout>) =>
        realSetTimeout(...args).unref()) as typeof setTimeout);
    const handle = await manager
      .getSmartAgent(undefined, 'DEST')
      .finally(() => unrefTimers.mockRestore());

    const admission = await gatekeeper.admitPipeline('alice', 's-1');
    if (!('admitted' in admission)) throw new Error('not admitted');
    const session = admission.admitted;

    // Every group, so authorization is not what decides this test.
    const exposition = [...HANDLER_GROUPS];
    const connection = { closeSession: async () => {}, reset: () => {} };
    mockTool.hold();

    const running = session.run(() =>
      manager.runWithRequestConnection(
        connection as never,
        () =>
          handle.agent.process(
            [{ role: 'user', content: 'Read the source of class ZCL_FAKE' }],
            {
              sessionId: 's-1',
              trace: { traceId: 'trace-1' },
              ragFilter: { exposition },
              signal: session.signal,
            } as never,
          ),
        undefined,
        exposition,
      ),
    );

    // The real chain — coordinator, executor worker, MCP adapter,
    // invokeEmbeddedTool — reached the embedded handler.
    expect(await until(() => mockTool.calls.length > 0)).toBe(true);

    let drained = false;
    const drain = session.drain().then(() => {
      drained = true;
    });
    await tick();
    await tick();
    // Registered: the write is still out, so teardown must not go on to safeStop.
    expect(drained).toBe(false);

    mockTool.release();
    const result = await running;
    await drain;
    expect(drained).toBe(true);
    expect(result.ok).toBe(true);
    session.release();
  }, 60_000);
});
