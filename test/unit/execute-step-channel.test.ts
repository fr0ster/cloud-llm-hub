jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return { user: require('./helpers/channel-harness').harness.user };
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-manager', () =>
  require('./helpers/channel-harness').agentManagerMock(),
);
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
jest.mock('../../srv/lib/responsible', () =>
  require('./helpers/channel-harness').responsibleMock(),
);
jest.mock('../../srv/lib/principal', () => ({
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
import type { Request } from 'express';
import {
  createAgentMcpServerForRequest,
  executeStep,
} from '../../srv/agent-mcp';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  clearGatekeeperMetrics,
  gatekeeperSnapshot,
} from '../../srv/lib/gatekeeper-metrics';
import {
  destinationClosedText,
  executeStepDoorRefusal,
} from '../../srv/lib/throttle-surfacing';
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
const step = () => executeStep(req, caller, { task: 'read class ZCL_X' });

beforeEach(() => harness.reset());
afterEach(() => configure());

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
    if ('admitted' in hold) hold.admitted.release();
  });

  it('sets the responsible person only once admitted, right before the run', async () => {
    // A process singleton: set before the queue wait, the last step to arrive
    // would name the responsible person for every step queued ahead of it.
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const running = step();
    await tick();
    expect(harness.events).not.toContain('setRequestResponsible');
    if ('admitted' in hold) hold.admitted.release();
    await running;
    const at = harness.events.indexOf('setRequestResponsible');
    expect(at).toBeGreaterThan(-1);
    expect(harness.events[at + 1]).toBe('pipeline');
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
      { task: 'create class ZCL_X' },
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

  it('tears down in order: calls, then safeStop, then the slot', async () => {
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
    expect(harness.events.slice(-3)).toEqual([
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
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
    const body = src.slice(src.indexOf('export async function executeStep'));
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
    expect(result.content[0].text).toContain('UNVERIFIED_WRITE: CreateClass');
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
    expect(result.content[0].text).toContain('UNVERIFIED_WRITE: CreateClass');
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
