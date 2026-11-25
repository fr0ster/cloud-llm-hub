import {
  LongSessionRegistry,
  longSessions,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { lifecycleHooks } from '../../srv/lib/session-lifecycle';

const mockCreateWorker = jest.fn();
const mockGetToolJournal = jest.fn<JournalEntry[], [string?]>(() => []);
const mockGetProfile = jest.fn();
const mockRunError = jest.fn();
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: (name: string) => ({
        info() {},
        warn() {},
        error: name === 'agent-mcp' ? mockRunError : () => {},
        debug() {},
      }),
      get context() {
        return { user: require('./helpers/channel-harness').harness.user };
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-manager', () => ({
  ...require('./helpers/channel-harness').agentManagerMock(),
  getSmartAgent: async (
    ...args: Parameters<typeof import('../../srv/agent-manager').getSmartAgent>
  ) => {
    const handle = await require('./helpers/channel-harness')
      .agentManagerMock()
      .getSmartAgent(...args);
    return {
      ...handle,
      profileRunner: { createWorker: mockCreateWorker },
      recMcp: { ...handle.recMcp, getToolJournal: mockGetToolJournal },
    };
  },
  createAgentProfileSource: () => ({
    list: async () => ({ ok: true, value: [] }),
    get: mockGetProfile,
    getPrompts: async () => ({ ok: true, value: {} }),
  }),
}));
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  // Records itself into `harness.events`: it's the first thing
  // `buildConnectionForDestination` calls, so its absence is how a test
  // proves a closed destination is refused before a connection is built.
  resolveDestinationSapConfig: async () => {
    require('./helpers/channel-harness').harness.events.push(
      'resolveDestinationSapConfig',
    );
    return {
      proxyType: 'Internet',
      authenticationType: 'OAuth2JWTBearer',
      sapConfig: { authType: 'jwt' },
      destinationName: 'DEST',
    };
  },
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => ({ connect: async () => {} }),
}));
jest.mock('../../srv/lib/request-system-context', () =>
  require('./helpers/channel-harness').requestSystemMock(),
);
jest.mock('../../srv/lib/principal', () => ({
  ...jest.requireActual('../../srv/lib/principal'),
  computeDumpScope: () => undefined,
}));
// The SDK's server, reduced to what the test needs from it: the callback
// `registerTool` was handed, so a test can call it the way the SDK does —
// with the request's `extra`, whose signal the transport aborts on close.
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const tools = new Map<
    string,
    (args: unknown, extra: { signal: AbortSignal }) => unknown
  >();
  return {
    tools,
    McpServer: class {
      registerTool(
        name: string,
        _config: unknown,
        cb: (args: unknown, extra: { signal: AbortSignal }) => unknown,
      ) {
        tools.set(name, cb);
      }
      async connect() {}
    },
  };
});
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async close() {}
  },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import type { Request } from 'express';
import {
  createAgentMcpServerForRequest,
  executeStep,
} from '../../srv/agent-mcp';
import { trackCall } from '../../srv/lib/admission-scope';
import { createCheckerWorker } from '../../srv/lib/checker-verdict';
import type { CheckerClaim } from '../../srv/lib/checker-verdict-schema';
import { getDialogueStoreBackend } from '../../srv/lib/dialogue-store';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  clearGatekeeperMetrics,
  gatekeeperSnapshot,
} from '../../srv/lib/gatekeeper-metrics';
import * as sessionTurns from '../../srv/lib/session-turns';
import {
  destinationClosedText,
  executeStepDoorRefusal,
} from '../../srv/lib/throttle-surfacing';
import type { JournalEntry } from '../../srv/lib/tool-journal';
import { deferred, harness, tick } from './helpers/channel-harness';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
  clearGatekeeperMetrics();
}

const req = { headers: { 'x-sap-destination': 'DEST' } } as unknown as Request;
const caller = { userId: 'alice', exposition: undefined };
function opened() {
  const session = longSessions().open('alice', { destination: 'DEST' });
  if ('refused' in session) throw new Error(session.refused);
  return session.key;
}
const step = () =>
  executeStep(req, caller, { session: opened(), task: 'read class ZCL_X' });

beforeEach(() => {
  harness.reset();
  mockCreateWorker.mockReset();
  mockGetToolJournal.mockReset().mockReturnValue([]);
  mockGetProfile.mockReset();
  mockRunError.mockClear();
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: 3600000, maxSessions: 10, maxPerUser: 10, queueLength: 3 },
      lifecycleHooks(),
    ),
  );
});
afterEach(async () => {
  await longSessions().closeAll('shutdown');
  setLongSessionsForTest(undefined);
  configure();
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'logs typed throttling and keeps the retry text (write=%s, throws=%s)',
  async (write, throws) => {
    const error = Object.assign(
      new LlmError('Provider returned HTTP 429', 'LLM_ERROR'),
      {
        throttled: true,
        retryAfterSeconds: 41.5,
        component: 'executor',
        stepId: 'first',
      },
    );
    harness.process = async () => {
      if (throws) throw error;
      return { ok: false, error };
    };
    if (write) harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const result = await step();

    const retry =
      'The AI service is rate-limited right now. Please try again in about 42 seconds.';
    const detail = write
      ? `CreateClass was sent and no answer came back (Provider returned HTTP 429). It was NOT retried. ${retry}`
      : retry;
    const message = `ERROR on destination "DEST": ${detail}`;
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: {
        result: message,
        error: { code: 'LLM_ERROR', status: 500, message },
      },
    });
    expect(mockRunError.mock.calls).toEqual([
      [
        'Agent run failed',
        {
          code: 'LLM_ERROR',
          status: 500,
          traceId: expect.stringMatching(/./),
          component: 'executor',
          stepId: 'first',
        },
      ],
    ]);
  },
);

test.each([undefined, 'executor'])(
  'executor %s retains HEAD result metadata with a profile runner',
  async (worker) => {
    harness.process = async () => ({
      ok: true,
      value: {
        content: '',
        iterations: 3,
        toolCallCount: 2,
        stopReason: 'stop',
      },
    });
    const result = await executeStep(req, caller, {
      session: opened(),
      task: 'read',
      worker,
    });
    expect(result.content[0].text).toContain(
      'iterations=3 toolCallCount=2 stopReason=stop',
    );
    expect(mockCreateWorker).not.toHaveBeenCalled();
  },
);

test('a direct verdict can cite SAP and RAG writes from prior calls in the same session', async () => {
  const session = opened();
  const entries: JournalEntry[] = [
    {
      call: {
        id: 'sap-write',
        name: 'CreateClass',
        arguments: { class_name: 'ZCLASS' },
      },
      result: { content: 'SUCCESS' },
      answered: true,
      write: true,
      system: 'sap',
    },
    {
      call: {
        id: 'rag-write',
        name: 'record_add',
        arguments: { record: 'note' },
      },
      result: {
        content: { collection: 'session/notes', record: 'note', created: true },
      },
      answered: true,
      write: true,
      system: 'rag',
    },
  ];
  const traces = new Map<string, JournalEntry[]>();
  mockGetToolJournal.mockImplementation((traceId) =>
    traceId ? (traces.get(traceId) ?? []) : [],
  );
  harness.process = async (_messages, options) => {
    const trace = options.trace?.traceId;
    const entry = entries.shift();
    if (!trace || !entry) throw new Error('Expected a traced write');
    traces.set(trace, [entry]);
    return { ok: true, value: { content: 'Write attempted' } };
  };
  const first = await executeStep(req, caller, {
    session,
    task: 'Create a class',
  });
  expect(first.content[0].text).toContain('"callId":"sap-write"');
  const second = await executeStep(req, caller, {
    session,
    task: 'Add a record',
  });
  expect(second.content[0].text).toContain('"callId":"rag-write"');
  const recorded = [...traces.values()].flat();
  traces.clear();
  const claims = [
    {
      claim: 'Created the class.',
      system: 'sap',
      target: { type: 'class', name: 'ZCLASS' },
      evidence: { callId: 'sap-write' },
    },
    {
      claim: 'Added the record.',
      system: 'rag',
      target: { scope: 'session', collection: 'notes', record: 'note' },
      evidence: { callId: 'rag-write' },
    },
  ] satisfies CheckerClaim[];
  const chat = jest.fn<ReturnType<ILlm['chat']>, Parameters<ILlm['chat']>>(
    async (messages) => {
      const missing = messages[1].content?.includes(
        'absent from the current journal',
      );
      return {
        ok: true,
        value: {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'verdict',
              name: 'submit_verdict',
              arguments: {
                verdict: missing ? 'fail' : 'pass',
                findings: claims.map(({ claim, evidence }) => ({
                  claim,
                  evidence,
                  status: missing ? 'unsupported' : 'confirmed',
                  reason: 'Checked the cited call.',
                })),
              },
            },
          ],
        },
      };
    },
  );
  mockGetProfile.mockResolvedValue({
    ok: true,
    value: { name: 'checker', result: 'verdict' },
  });
  mockCreateWorker.mockResolvedValue({
    ok: true,
    value: createCheckerWorker(
      'checker',
      '',
      '',
      {
        chat,
        async *streamChat() {},
      },
      async () => undefined,
      () => undefined,
    ),
  });
  const check = { worker: 'checker', task: JSON.stringify(claims) };
  const verified = await executeStep(req, caller, { ...check, session });
  expect(JSON.parse(verified.content[0].text)).toMatchObject({
    verdict: 'pass',
  });
  const dialogueSession = opened();
  const isolated = await executeStep(req, caller, {
    ...check,
    session: dialogueSession,
  });
  expect(JSON.parse(isolated.content[0].text)).toMatchObject({
    verdict: 'fail',
    findings: [{ status: 'unsupported' }, { status: 'unsupported' }],
  });
  const request = {
    id: 'dialogue-request',
    openedAt: Date.now(),
    text: 'Make the writes',
  };
  await getDialogueStoreBackend().save(caller.userId, dialogueSession, {
    conversation: [],
    tasks: [],
    pending: [],
    savedAt: Date.now(),
    requests: [request],
    toolJournal: { requestId: request.id, entries: recorded },
  });
  const restored = await executeStep(req, caller, {
    ...check,
    session: dialogueSession,
  });
  expect(JSON.parse(restored.content[0].text)).toMatchObject({
    verdict: 'pass',
  });
});

describe('execute_step at the door', () => {
  it('refuses with the prefixed line, after resolving the agent', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();
    const result = await step();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(executeStepDoorRefusal('capacity'));
    // Refused before a connection is built: nothing was CSRF-fetched for a
    // step that never ran.
    expect(harness.events).toEqual(['getSmartAgent', 'safeStop']);
    // Refused: nothing resolved and no request scope entered.
    expect(harness.requestSystemHeaders).toEqual([]);
    if ('admitted' in hold) hold.admitted.release();
  });

  it('releases the slot last even when dropRequest throws', async () => {
    // A slot leaked here closes the door until restart.
    configure(1);
    harness.dropRequestThrows = true;
    await expect(step()).resolves.toMatchObject({
      content: [{ text: 'done' }],
    });
    expect(harness.events.at(-1)).toBe('dropRequest');
    expect(harness.events).not.toContain('safeStop');
    await longSessions().closeAll('explicit');
    expect(harness.events.at(-1)).toBe('safeStop');
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('runs the step inside its request-system scope, entered once admitted', async () => {
    // Entered before the queue wait, the scope would carry this request's
    // values into a wait whose step may never run.
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const running = step();
    await tick();
    expect(harness.events).not.toContain('resolveRequestSystem');
    expect(harness.events).not.toContain('requestSystemScope');
    if ('admitted' in hold) hold.admitted.release();
    await running;
    const at = harness.events.indexOf('resolveRequestSystem');
    expect(at).toBeGreaterThan(
      harness.events.indexOf('resolveDestinationSapConfig'),
    );
    expect(harness.events.slice(at, at + 3)).toEqual([
      'resolveRequestSystem',
      'requestSystemScope',
      'pipeline',
    ]);
    // The step's own request headers, not another request's.
    expect(harness.requestSystemHeaders).toEqual([req.headers]);
    expect(harness.requestSystemAtPipeline).toEqual([
      { responsible: 'ALICE', masterSystem: 'DEV' },
    ]);
  });

  it('a step that leaves while queued takes no slot and runs nothing', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    await createAgentMcpServerForRequest(req);
    const { tools } = jest.requireMock(
      '@modelcontextprotocol/sdk/server/mcp.js',
    ) as {
      tools: Map<
        string,
        (args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>
      >;
    };
    const tool = tools.get('execute_step');
    if (!tool) throw new Error('execute_step was not registered');

    // The SDK aborts this signal when the transport closes: the planner's own
    // timeout fired and it went away.
    const transportClosed = new AbortController();
    const running = tool(
      { session: opened(), task: 'create class ZCL_X' },
      { signal: transportClosed.signal },
    );
    await tick();
    expect(gatekeeper.theDoor()?.snapshot().queued).toBe(1);

    transportClosed.abort(new Error('Connection closed'));
    await tick();
    if ('admitted' in hold) hold.admitted.release();
    await running;
    await tick();

    // Handed no slot later, so the write is not run a second time for nobody.
    expect(harness.events).not.toContain('pipeline');
    expect(harness.events).not.toContain('resolveDestinationSapConfig');
    expect(harness.requestSystemHeaders).toEqual([]);
    expect(gatekeeper.theDoor()?.snapshot()).toMatchObject({
      live: 0,
      queued: 0,
      left: 1,
    });
  });

  it('counts against the one door, not a second cap', async () => {
    configure(3);
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    harness.process = async () => {
      await gates[n++].promise;
      return { ok: true, value: { content: 'x' } };
    };
    const running = [step(), step(), step()];
    await tick();
    // Three at once: the semaphore of two is off while the door is on.
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(3);
    for (const g of gates) g.resolve();
    await Promise.all(running);
  });

  it('drains calls and releases the slot, retaining the connection until session close', async () => {
    configure(1);
    const tool = deferred();
    harness.process = async () => {
      void trackCall(
        tool.promise.then(() => harness.events.push('tool settled')),
      );
      return { ok: true, value: { content: 'done' } };
    };
    const running = step();
    await tick();
    expect(harness.events).not.toContain('safeStop');
    tool.resolve();
    await running;
    expect(harness.events.slice(-2)).toEqual(['tool settled', 'dropRequest']);
    expect(harness.events).not.toContain('safeStop');
    await longSessions().closeAll('explicit');
    expect(harness.events.at(-1)).toBe('safeStop');
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });
});

describe('absent means today', () => {
  it('keeps the semaphore of two', async () => {
    configure();
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    harness.process = async () => {
      await gates[n++].promise;
      return { ok: true, value: { content: 'x' } };
    };
    const running = [step(), step(), step()];
    await tick();
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(2);
    for (const g of gates) g.resolve();
    await Promise.all(running);
  });

  it('still resolves the agent before admitting', () => {
    const src = readFileSync(join(__dirname, '../../srv/agent-mcp.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function executeStep'));
    expect(body.indexOf('getSmartAgent(')).toBeLessThan(
      body.indexOf('admitPipeline('),
    );
  });
});

describe('a closed destination', () => {
  it('refuses before the agent is resolved, with the interval in the text', async () => {
    // A configured door so the refusal-count assertion below is meaningful
    // (not just the vacuous `{ configured: false }` of no door at all).
    configure(2);
    harness.closedDestination = 'DEST';
    harness.retryAfterSeconds = 42;

    const result = await step();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `${destinationClosedText('DEST')} Try again in about 42 seconds.`,
    );
    // Refused before a connection is built or the agent is resolved.
    expect(harness.events).not.toContain('resolveDestinationSapConfig');
    expect(harness.events).not.toContain('getSmartAgent');
    expect(harness.events).not.toContain('pipeline');
    // Counted in its own scope, not the door's: an unreachable SAP system is
    // not the same question as a full container.
    const snap = gatekeeperSnapshot();
    expect(snap.destinations).toContainEqual(
      expect.objectContaining({ name: 'DEST', refusals: 1 }),
    );
    expect(snap.door).toMatchObject({
      refusals: { session_busy: 0, capacity: 0, retention: 0 },
    });
  });

  it('omits the interval sentence when no probe is scheduled', async () => {
    configure();
    harness.closedDestination = 'DEST';
    harness.retryAfterSeconds = undefined;

    const result = await step();

    expect(result.content[0].text).toBe(destinationClosedText('DEST'));
  });
});

describe('an unanswered write', () => {
  it('is named in the returned text and marked not retried', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const result = await step();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CreateClass');
    expect(result.content[0].text).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary failure text untouched when nothing is unanswered', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    harness.unanswered = [];

    const result = await step();

    expect(result.content[0].text).toBe(
      'ERROR on destination "DEST": socket hang up',
    );
  });
});

describe('an unanswered write, thrown from the pipeline', () => {
  it('is named in the returned text and marked not retried', async () => {
    configure();
    harness.process = async () => {
      throw new Error('socket hang up');
    };
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const result = await step();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CreateClass');
    expect(result.content[0].text).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary failure text untouched when nothing is unanswered', async () => {
    configure();
    harness.process = async () => {
      throw new Error('socket hang up');
    };
    harness.unanswered = [];

    const result = await step();

    expect(result.content[0].text).toBe('ERROR: socket hang up');
  });
});

test.each(['success', 'error', 'exception', 'abort'] as const)(
  'execute_step records only completed calls: %s',
  async (outcome) => {
    const recorded = jest
      .spyOn(sessionTurns, 'recordTurn')
      .mockImplementation(() => {});
    const controller = new AbortController();
    harness.process = async () => {
      if (outcome === 'exception') throw new Error('step failed');
      if (outcome === 'error')
        return { ok: false, error: new Error('step failed') };
      if (outcome === 'abort') controller.abort();
      return { ok: true, value: { content: 'answer', stopReason: 'stop' } };
    };
    try {
      await executeStep(
        req,
        caller,
        { session: opened(), task: 'read' },
        controller.signal,
      );
      expect(recorded).toHaveBeenCalledTimes(
        outcome === 'success' || outcome === 'abort' ? 1 : 0,
      );
    } finally {
      recorded.mockRestore();
    }
  },
);
