// Bootstrap logging is tested with real CAP in logging-config.test.ts.
jest.mock('../../srv/lib/logging-config', () => ({
  applyLoggingConfig: jest.fn(),
}));

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
jest.mock('../../srv/agent-manager', () =>
  require('./helpers/channel-harness').agentManagerMock(),
);
jest.mock('../../srv/agent-config', () =>
  require('./helpers/channel-harness').agentConfigMock(),
);
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({
  getAvailableModels: async () => [],
}));
jest.mock('../../srv/lib/request-system-context', () =>
  require('./helpers/channel-harness').requestSystemMock(),
);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicApiAdapter } from '@mcp-abap-adt/llm-agent';
import type { Request, Response } from 'express';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  clearGatekeeperMetrics,
  gatekeeperSnapshot,
} from '../../srv/lib/gatekeeper-metrics';
import {
  type LongSession,
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { McpUnavailableError } from '../../srv/lib/mcp-outage';
import {
  anthropicDoorRefusal,
  anthropicSessionClosed,
  destinationClosedText,
} from '../../srv/lib/throttle-surfacing';
import {
  deferred,
  fakeReq,
  fakeRes,
  harness,
  tick,
} from './helpers/channel-harness';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
  clearGatekeeperMetrics();
}

const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const body = (stream = false) => ({
  model: 'm',
  max_tokens: 100,
  stream,
  messages: [{ role: 'user', content: 'hi' }],
});

function call(b: unknown, res = fakeRes()) {
  const done = handleAnthropicMessages(
    fakeReq(b) as unknown as Request,
    res as unknown as Response,
  );
  return { res, done };
}

beforeEach(() => harness.reset());
afterEach(() => configure());

describe('/v1/messages at the door', () => {
  it("refuses with Anthropic's overloaded_error under 529, and no Retry-After", async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();
    const { res, done } = call(body());
    await done;
    const refusal = anthropicDoorRefusal('capacity');
    expect(res.statusCode).toBe(refusal.status);
    expect(JSON.parse(res.body)).toEqual(refusal.body);
    expect(res.headers['Retry-After']).toBeUndefined();
    // Refused: nothing resolved and no request scope entered.
    expect(harness.events).not.toContain('resolveRequestSystem');
    expect(harness.requestSystemHeaders).toEqual([]);
    if ('admitted' in hold) hold.admitted.release();
  });

  it('a disconnect ends nothing, and teardown waits for the call in flight', async () => {
    configure(1);
    const between = deferred();
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      void trackCall(
        tool.promise.then(() => harness.events.push('tool settled')),
      );
      // Hold here so the disconnect below lands mid-response, not after `out.end()`.
      await between.promise;
      yield { ok: true, value: { content: 'after-disconnect' } };
      yield { ok: true, value: { finishReason: 'stop' } };
    };
    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();
    // Proves the disconnect below is mid-response, not after the handler finished.
    expect(res.writableEnded).toBe(false);

    res.disconnect();
    await tick();
    expect(harness.events).not.toContain('safeStop');
    expect((harness.seenOptions[0].signal as AbortSignal).aborted).toBe(false);

    // The detached sink drops anything written after the disconnect.
    between.resolve();
    await tick();
    expect(res.body).not.toContain('after-disconnect');

    tool.resolve();
    await done;
    expect(harness.events.slice(-3)).toEqual([
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('releases the slot last even when dropRequest throws', async () => {
    // A slot leaked here closes the door until restart.
    configure(1);
    harness.dropRequestThrows = true;
    const { done } = call(body());
    await expect(done).resolves.toBeUndefined();
    expect(harness.events.slice(-2)).toEqual(['safeStop', 'dropRequest']);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('a caller that leaves while queued starts no pipeline', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const res = fakeRes();
    const { done } = call(body(), res);
    await tick();
    expect(gatekeeper.theDoor()?.snapshot().queued).toBe(1);
    res.disconnect();
    await done;
    if ('admitted' in hold) hold.admitted.release();
    await tick();
    expect(harness.events).not.toContain('pipeline');
    expect(harness.events).not.toContain('resolveRequestSystem');
    expect(harness.requestSystemHeaders).toEqual([]);
    expect(gatekeeper.theDoor()?.snapshot()).toMatchObject({
      live: 0,
      queued: 0,
      left: 1,
    });
  });

  for (const stream of [false, true]) {
    it(`runs the pipeline inside its request-system scope, entered once admitted — stream: ${stream}`, async () => {
      // Entered before the queue wait, the scope would carry this request's
      // values into a wait whose run may never start.
      configure(1, 1);
      const hold = await gatekeeper.admitPipeline('bob', 'busy');
      const { done } = call(body(stream));
      await tick();
      expect(harness.events).not.toContain('resolveRequestSystem');
      expect(harness.events).not.toContain('requestSystemScope');
      if ('admitted' in hold) hold.admitted.release();
      await done;
      const at = harness.events.indexOf('resolveRequestSystem');
      expect(harness.events.slice(at, at + 3)).toEqual([
        'resolveRequestSystem',
        'requestSystemScope',
        'pipeline',
      ]);
      expect(harness.requestSystemHeaders).toEqual([
        expect.objectContaining({ 'x-sap-destination': 'DEST' }),
      ]);
      expect(harness.requestSystemAtPipeline).toEqual([
        { responsible: 'ALICE', masterSystem: 'DEV' },
      ]);
    });
  }

  it('resolves the agent before admitting', () => {
    const src = readFileSync(
      join(__dirname, '../../srv/anthropic-handler.ts'),
      'utf8',
    );
    expect(src.indexOf('getSmartAgent(')).toBeLessThan(
      src.indexOf('admitPipeline('),
    );
  });
});

describe('a closed destination', () => {
  it('refuses before the agent is resolved, with a true Retry-After', async () => {
    // A configured door so the refusal-count assertion below is meaningful
    // (not just the vacuous `{ configured: false }` of no door at all).
    configure(2);
    harness.closedDestination = 'DEST';
    harness.retryAfterSeconds = 42;

    const { res, done } = call(body());
    await done;

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('42');
    expect(JSON.parse(res.body)).toEqual({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: destinationClosedText('DEST'),
      },
    });
    // Refused before a connection is attempted — which would CSRF-fetch
    // against the dead system and answer 401 — and before getSmartAgent: no
    // pipeline, no slot, nothing to stop.
    expect(harness.establishCalls).toEqual([]);
    expect(harness.events).not.toContain('getSmartAgent');
    expect(harness.events).not.toContain('pipeline');
    expect(harness.events).not.toContain('safeStop');
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

  it('omits Retry-After when no probe is scheduled', async () => {
    configure();
    harness.closedDestination = 'DEST';
    harness.retryAfterSeconds = undefined;

    const { res, done } = call(body());
    await done;

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

describe('a request that outlived its session', () => {
  for (const [label, live] of [
    ['with a door', 2],
    ['without a door', undefined],
  ] as const) {
    it(`is answered 410 session_closed and starts nothing — ${label}`, async () => {
      configure(live);
      const store =
        require('../../srv/session-store') as typeof import('../../srv/session-store');
      store.appendToSession('s-race', 'alice', {
        role: 'user',
        content: 'earlier',
      });
      const gate = deferred();
      harness.agentGate = gate.promise;
      const res = fakeRes();
      // The middleware kept the cookie: the session was live when it arrived.
      const done = handleAnthropicMessages(
        fakeReq(body(), 's-race', false) as unknown as Request,
        res as unknown as Response,
      );
      await tick();
      // Agent resolution is still waiting when the logout completes.
      await gatekeeper.deleteSession('alice', 's-race');
      gate.resolve();
      await done;

      expect(harness.events).not.toContain('pipeline');
      expect(res.statusCode).toBe(410);
      expect(JSON.parse(res.body)).toEqual(anthropicSessionClosed().body);
      expect(store.getSessionHistory('s-race', 'alice')).toEqual([]);
      expect(gatekeeper.theRetention().snapshot().retained).toBe(0);
    });
  }
});

describe('an unanswered write, non-streaming', () => {
  it('is named in the error payload and marked not retried', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body());
    await done;

    const text = JSON.parse(res.body).error.message;
    expect(text).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(text).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary failure text untouched when nothing is unanswered', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    harness.unanswered = [];

    const { res, done } = call(body());
    await done;

    const text = JSON.parse(res.body).error.message;
    expect(text).toBe('socket hang up');
  });
});

describe('an unanswered write, streaming (swallowed error chunk)', () => {
  // AnthropicApiAdapter.transformStream turns an error chunk into an ordinary
  // message_delta/message_stop and returns — it never throws — so this path
  // does NOT go through the handler's `catch`.
  it('is named in a trailing SSE error event and marked not retried', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: false, error: new Error('socket hang up') };
    };
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('event: error');
    expect(res.body).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(res.body).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
    // Anthropic clients, the Claude CLI among them, stop reading at
    // message_stop: a notice after it is a notice nobody receives.
    expect(res.body).toContain('event: message_stop');
    expect(res.body.indexOf('event: error')).toBeLessThan(
      res.body.indexOf('event: message_stop'),
    );
    expect(res.body.endsWith(`${MESSAGE_STOP}`)).toBe(true);
  });

  it('leaves the streamed output unchanged when nothing is unanswered', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: false, error: new Error('socket hang up') };
    };
    harness.unanswered = [];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).not.toContain('event: error');
    expect(res.body).not.toContain('UNVERIFIED_WRITE');
  });
});

describe('streamed output with no notice to add', () => {
  /** What the adapter itself emits for these chunks, as the handler writes it. */
  async function adapterBytes(
    chunks: Array<
      { ok: true; value: Record<string, unknown> } | { ok: false; error: Error }
    >,
  ) {
    const adapter = new AnthropicApiAdapter();
    const { context } = adapter.normalizeRequest(body(true));
    let out = '';
    const source = (async function* () {
      for (const c of chunks) yield c;
    })();
    for await (const event of adapter.transformStream(
      source as never,
      context,
    )) {
      out += `event: ${event.event}\ndata: ${event.data}\n\n`;
    }
    return out;
  }
  const withoutIds = (s: string) => s.replace(/"id":"[^"]*"/g, '"id":"-"');

  for (const [label, chunks] of [
    [
      'a successful stream',
      [
        { ok: true, value: { content: 'done' } },
        { ok: true, value: { finishReason: 'stop' } },
      ],
    ],
    [
      'an error chunk that leaves no write unanswered',
      [{ ok: false, error: new Error('socket hang up') }],
    ],
  ] as const) {
    it(`is byte-identical to the adapter's own output — ${label}`, async () => {
      configure();
      harness.stream = async function* () {
        for (const c of chunks) yield c as never;
      };
      harness.unanswered = [];

      const { res, done } = call(body(true));
      await done;

      expect(withoutIds(res.body)).toBe(
        withoutIds(await adapterBytes([...chunks] as never)),
      );
    });
  }
});

describe('an outage error chunk, streaming', () => {
  // Ruling 34: an outage closes the destination REGARDLESS of whether a
  // write is left unanswered — the two facts are independent. The trailing
  // `event: error` line stays conditional on `unverifiedWriteFor`; the
  // stream must still close nothing extra when nothing is pending.
  it('closes the destination even with nothing unanswered, and leaves the stream unchanged', async () => {
    configure();
    const outage = new McpUnavailableError(
      'DEST',
      'tunnel down',
      'tunnel_timeout',
    );
    harness.stream = async function* () {
      yield { ok: false, error: outage };
    };
    harness.unanswered = [];

    const { res, done } = call(body(true));
    await done;

    expect(harness.closeDestinationCalls).toEqual([
      { destination: 'DEST', reason: outage.message },
    ]);
    expect(res.body).not.toContain('event: error');
    expect(res.body).not.toContain('UNVERIFIED_WRITE');
  });
});

describe('an unanswered write, streaming exception', () => {
  it('is named in the SSE error event and marked not retried', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      throw new Error('socket hang up');
    };
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('event: error');
    expect(res.body).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(res.body).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary exception payload untouched when nothing is unanswered', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      throw new Error('socket hang up');
    };
    harness.unanswered = [];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('socket hang up');
    expect(res.body).not.toContain('UNVERIFIED_WRITE');
  });
});

describe('an unanswered write together with a throttle', () => {
  it('leads with the write notice, keeps the throttled status and Retry-After', async () => {
    configure();
    const throttled = Object.assign(new Error('SAP AI SDK API error: 429'), {
      throttled: true,
      attempts: 5,
      retryAfterSeconds: 42,
      reason: 'budget',
    });
    harness.process = async () => ({ ok: false, error: throttled });
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body());
    await done;

    expect(res.statusCode).toBe(529);
    expect(res.headers['Retry-After']).toBe('42');
    const payload = JSON.parse(res.body);
    expect(payload.error.type).toBe('overloaded_error');
    expect(payload.error.message).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(payload.error.message).toContain('42 seconds');
  });
});

describe('a long session', () => {
  let registry: LongSessionRegistry;
  let s: LongSession;
  beforeEach(() => {
    registry = new LongSessionRegistry(
      { ttlMs: 60_000, maxSessions: 10, maxPerUser: 5, queueLength: 2 },
      { onClose: async () => {} },
    );
    setLongSessionsForTest(registry);
    s = registry.open('alice', {}) as LongSession;
  });
  afterEach(() => setLongSessionsForTest(undefined));

  function callInSession(b: unknown, res = fakeRes()) {
    const req = fakeReq(b) as unknown as Request & {
      longSession?: LongSession;
    };
    req.longSession = s;
    const done = handleAnthropicMessages(req, res as unknown as Response);
    return { res, done };
  }

  it('keeps destination B after a header switches away from A', async () => {
    configure();
    s.destination = 'A';
    const send = async (destination?: string) => {
      const req = fakeReq(body()) as unknown as Request & {
        longSession?: LongSession;
      };
      req.longSession = s;
      if (destination) req.headers['x-sap-destination'] = destination;
      else delete req.headers['x-sap-destination'];
      await handleAnthropicMessages(req, fakeRes() as unknown as Response);
    };
    await send('A');
    await send('B');
    await send();
    expect(harness.establishCalls).toEqual(['A', 'B']);
    expect(s.destination).toBe('B');
    expect(harness.destinationSets).toContainEqual({
      userId: 'alice',
      sessionId: s.key,
      destination: 'B',
    });
  });

  it('a long-session request leaves its connection open after the response — success', async () => {
    configure();
    const { res, done } = callInSession(body());
    await done;
    expect(res.statusCode).toBe(200);
    expect(harness.events).not.toContain('safeStop');
    expect(s.connection).toEqual({ id: 'conn' });

    const held = s.connection;
    await callInSession(body()).done;
    expect(harness.establishCalls).toEqual(['DEST']);
    expect(s.connection).toBe(held);
  });

  it('a long-session request leaves its connection open after the response — model error', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    const { done } = callInSession(body());
    await done;
    expect(harness.events).toContain('pipeline');
    expect(harness.events).not.toContain('safeStop');
    expect(s.connection).toEqual({ id: 'conn' });
  });

  it('a long-session request leaves its connection open after the response — admission refusal', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();
    try {
      const { res, done } = callInSession(body());
      await done;
      expect(res.statusCode).toBe(anthropicDoorRefusal('capacity').status);
      expect(harness.events).not.toContain('safeStop');
      expect(s.connection).toEqual({ id: 'conn' });
    } finally {
      if ('admitted' in hold) hold.admitted.release();
    }
  });

  it('a closed session is refused 404 and connects nothing', async () => {
    configure();
    await registry.close('alice', s.key, 'explicit');
    const { res, done } = callInSession(body());
    await done;
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('SESSION_NOT_FOUND');
    expect(harness.establishCalls).toEqual([]);
  });

  it('a request without a long session still stops its connection', async () => {
    configure();
    await call(body()).done;
    expect(harness.events).toContain('safeStop');
  });
});

describe('adaptive status SSE', () => {
  it('emits single-line comments and preserves the first data event and answer', async () => {
    const status = {
      stepId: 'create',
      kind: 'execute',
      state: 'started',
      goal: 'line one\nline two',
    };
    harness.stream = async function* () {
      yield { ok: true, value: { content: '', status } };
      yield { ok: true, value: { content: 'answer' } };
      yield { ok: true, value: { finishReason: 'stop' } };
    };
    const response = fakeRes();
    const write = response.write.bind(response);
    response.write = (text: string) => {
      expect(response.headersSent).toBe(true);
      return write(text);
    };
    const { res, done } = call(body(true), response);
    await done;
    expect(res.body).toContain(`: status ${JSON.stringify(status)}\n\n`);
    const data = res.body
      .split('\n')
      .filter((line: string) => line.startsWith('data: '));
    const first = JSON.parse(data[0].slice(6));
    expect(first.type).toBe('message_start');
    expect(res.body).toContain('answer');
    expect(res.body).not.toContain('event: status');
  });
});

it.each([false, true])(
  'passes the trusted session to the Anthropic agent (stream=%s)',
  async (stream) => {
    configure();
    await call(body(stream)).done;
    expect(harness.seenOptions.at(-1)?.sessionId).toBe('s-1');
  },
);

it('plain Anthropic release preserves the run for the next request until TTL', async () => {
  const { getRunRecordStore, initializeRunRecordStore } = await import(
    '../../srv/lib/run-record-store'
  );
  const { loadSessionConfig } = await import('../../srv/lib/session-config');
  const { runWithSessionId } = await import('../../srv/request-session');
  initializeRunRecordStore({ ...loadSessionConfig({}), ttlMs: 100 });
  configure();
  const store = getRunRecordStore();
  const previousRuns: unknown[] = [];
  const record = {
    runId: 'anthropic-run',
    request: 'hi',
    plan: { steps: [], createdAt: 1 },
    steps: [],
    outcome: 'answered' as const,
    finishedAt: 2,
  };
  harness.process = async (_messages, opts) => {
    const sid = opts.sessionId as string;
    previousRuns.push(await store.load(sid));
    await store.save(sid, record);
    return { ok: true, value: { content: 'done', stopReason: 'stop' } };
  };
  const now = jest.spyOn(Date, 'now');
  const start = Date.now();
  now.mockReturnValue(start);
  try {
    await call(body()).done;
    expect(gatekeeper.sessionIsLive('alice', 's-1')).toBe(true);
    await handleAnthropicMessages(
      fakeReq(body(), 's-1', false) as unknown as Request,
      fakeRes() as unknown as Response,
    );
    expect(previousRuns).toEqual([undefined, record]);
    now.mockReturnValue(start + 101);
    gatekeeper.forgetEmptySessions();
    expect(gatekeeper.sessionIsLive('alice', 's-1')).toBe(false);
    expect(
      await runWithSessionId('s-1', () => store.load('s-1'), [], 'alice'),
    ).toBeUndefined();
  } finally {
    now.mockRestore();
  }
});

describe('selected collection retrieval', () => {
  afterEach(() => jest.restoreAllMocks());
  function collections(status?: number) {
    const { getCollectionRegistry } = require('../../srv/agent-manager');
    const registry = getCollectionRegistry();
    jest.spyOn(registry, 'getCollection').mockResolvedValue({
      id: 'docs__u_alice',
      owner: 'alice',
      scope: 'user',
    });
    jest
      .spyOn(registry, 'degradedOf')
      .mockResolvedValue(
        status
          ? { httpStatus: status, message: 'collection unavailable' }
          : undefined,
      );
    jest.spyOn(registry, 'getRagStores').mockResolvedValue({});
    jest.spyOn(registry, 'getRagStore').mockResolvedValue({
      query: async () => ({
        ok: true,
        value: [{ text: 'retrieved answer', score: 1 }],
      }),
    });
  }
  it('passes context with original user provenance to the agent', async () => {
    collections();
    const {
      userTextOf,
      RAG_CONTEXT_MARKER,
    } = require('../../srv/lib/rag-context-marker');
    harness.process = async (messages) => {
      const last = (messages as Array<{ content: string }>).at(-1);
      if (!last) throw new Error('missing user message');
      expect(last.content).toBe(`hi${RAG_CONTEXT_MARKER}retrieved answer`);
      expect(userTextOf(last)).toBe('hi');
      return { ok: true, value: { content: 'answer', stopReason: 'stop' } };
    };
    const req = fakeReq(body()) as unknown as Request;
    req.headers['x-rag-collections'] = 'docs__u_alice';
    const res = fakeRes();
    await handleAnthropicMessages(req, res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(harness.events).toContain('pipeline');
  });
  it.each([409, 503])(
    'refuses degraded collections before streaming (%s)',
    async (status) => {
      collections(status);
      const req = fakeReq(body(true)) as unknown as Request;
      req.headers['x-rag-collections'] = 'docs__u_alice';
      const res = fakeRes();
      await handleAnthropicMessages(req, res as unknown as Response);
      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.body)).toEqual({
        type: 'error',
        error: {
          type: status === 409 ? 'conflict' : 'api_error',
          message: 'collection unavailable',
        },
      });
      expect(harness.events).not.toContain('pipeline');
    },
  );
});

test.each([false, true])(
  'passes hub arrival time through delayed admission (stream=%s)',
  async (stream) => {
    configure(2);
    const gate = deferred();
    harness.agentGate = gate.promise;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1793275200000);
    try {
      const { done } = call({ ...body(stream), requestStartedAt: 1 });
      clock.mockReturnValue(1793275260000);
      gate.resolve();
      await done;
      expect(harness.seenOptions.length).toBeGreaterThan(0);
      for (const options of harness.seenOptions) {
        expect(options.requestStartedAt).toBe(1793275200000);
      }
    } finally {
      gate.resolve();
      clock.mockRestore();
    }
  },
);
