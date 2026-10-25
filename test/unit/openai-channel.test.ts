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
import type { Request, Response } from 'express';
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
import {
  destinationClosedText,
  openAiDoorRefusal,
} from '../../srv/lib/throttle-surfacing';
import { handleChatCompletions } from '../../srv/openai-handler';
import { clearSession, getSessionHistory } from '../../srv/session-store';
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

const body = (stream = false) => ({
  model: 'm',
  stream,
  messages: [{ role: 'user', content: 'hi' }],
});

function call(b: unknown, res = fakeRes(), sessionId = 's-1') {
  const done = handleChatCompletions(
    fakeReq(b, sessionId) as unknown as Request,
    res as unknown as Response,
  );
  return { res, done };
}

beforeEach(() => harness.reset());
afterEach(() => configure());

describe('/v1/chat/completions at the door', () => {
  it('refuses in the OpenAI envelope, with no Retry-After, after resolving the agent', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();

    const { res, done } = call(body());
    await done;

    const refusal = openAiDoorRefusal('capacity');
    expect(res.statusCode).toBe(refusal.status);
    expect(JSON.parse(res.body)).toEqual(refusal.body);
    expect(res.headers['Retry-After']).toBeUndefined();
    expect(harness.events).toEqual(['getSmartAgent', 'safeStop']);
    // Refused: nothing resolved and no request scope entered.
    expect(harness.requestSystemHeaders).toEqual([]);
    if ('admitted' in hold) hold.admitted.release();
  });

  it('hands the pipeline the admission signal, not the caller', async () => {
    configure(2);
    const gate = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      await gate.promise;
      yield { ok: true, value: { finishReason: 'stop' } };
    };
    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();

    // A caller disconnect aborts `callerLeft`, not the admission — so the
    // pipeline keeps running and its signal stays untouched.
    res.disconnect();
    await tick();
    const signal = harness.seenOptions[0].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    // Only shutdown aborts the admission's signal.
    gatekeeper.theDoor()?.abortAll(new Error('shutdown'));
    expect(signal.aborted).toBe(true);

    gate.resolve();
    await done;
  });

  it('a disconnect ends nothing, a dead socket cannot fail the run, and teardown is in order', async () => {
    configure(1);
    const between = deferred();
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      // A write chain in flight, registered as the embedded handler registers it.
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
    await expect(done).resolves.toBeUndefined();
    expect(harness.events.slice(-3)).toEqual([
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('a dead socket cannot fail the run, and the stream still runs to its end', async () => {
    configure(1);
    const res = fakeRes({ throwOnWriteAfter: 1 });
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'first' } };
      yield { ok: true, value: { content: 'second' } };
      yield { ok: true, value: { content: 'third' } };
      yield { ok: true, value: { finishReason: 'stop' } };
      harness.events.push('stream finished');
    };
    const { done } = call(body(true), res);
    await expect(done).resolves.toBeUndefined();
    expect(harness.events).toEqual([
      'getSmartAgent',
      'resolveRequestSystem',
      'requestSystemScope',
      'pipeline',
      'stream finished',
      'safeStop',
      'dropRequest',
    ]);
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

  it('the slot outlives an aborted tool call', async () => {
    configure(1, 1);
    const tool = deferred();
    harness.process = async () => {
      // The library answered its caller; the ADT write underneath is still out.
      void trackCall(tool.promise);
      return { ok: true, value: { content: 'aborted', stopReason: 'stop' } };
    };
    const { done } = call(body());
    await tick();

    let admitted = false;
    const next = gatekeeper.admitPipeline('bob', 'next').then((r) => {
      admitted = true;
      return r;
    });
    await tick();
    expect(admitted).toBe(false);

    tool.resolve();
    await done;
    const r = await next;
    expect(admitted).toBe(true);
    if ('admitted' in r) r.admitted.release();
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
    res.disconnect();
    await done;
    expect(harness.events).not.toContain('pipeline');
    expect(harness.events).not.toContain('resolveRequestSystem');
    expect(harness.requestSystemHeaders).toEqual([]);
    expect(harness.events).toContain('safeStop');
    if ('admitted' in hold) hold.admitted.release();
    expect(gatekeeper.theDoor()?.snapshot()).toMatchObject({
      live: 0,
      queued: 0,
      left: 1,
    });
  });

  it('absent means no door: nothing refused, and teardown still waits for calls', async () => {
    configure();
    const tool = deferred();
    harness.process = async () => {
      void trackCall(
        tool.promise.then(() => harness.events.push('tool settled')),
      );
      return { ok: true, value: { content: 'x', stopReason: 'stop' } };
    };
    const { res, done } = call(body());
    await tick();
    tool.resolve();
    await done;
    expect(res.statusCode).toBe(200);
    expect(harness.events.indexOf('tool settled')).toBeLessThan(
      harness.events.indexOf('safeStop'),
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
      error: {
        type: 'overloaded_error',
        message: destinationClosedText('DEST'),
      },
    });
    // The whole point: refused before a connection is attempted — which would
    // CSRF-fetch against the dead system and answer 401 — and before
    // getSmartAgent, so no pipeline runs, no slot is taken, nothing to stop.
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
    it(`does not start the pipeline under the old id — ${label}`, async () => {
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
      const done = handleChatCompletions(
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
      expect(JSON.parse(res.body).error.code).toBe('session_closed');
      expect(store.getSessionHistory('s-race', 'alice')).toEqual([]);
      expect(gatekeeper.theRetention().snapshot().retained).toBe(0);
    });
  }
});

describe('a shared corpus build holds no caller slot', () => {
  it('resolves the agent before admitting', () => {
    const src = readFileSync(
      join(__dirname, '../../srv/openai-handler.ts'),
      'utf8',
    );
    expect(src.indexOf('getSmartAgent(')).toBeLessThan(
      src.indexOf('admitPipeline('),
    );
  });
});

describe('an unanswered write, non-streaming', () => {
  it('is named in the response and marked not retried', async () => {
    configure();
    harness.process = async () => ({
      ok: false,
      error: new Error('socket hang up'),
    });
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body());
    await done;

    const text = JSON.parse(res.body).choices[0].message.content;
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

    const text = JSON.parse(res.body).choices[0].message.content;
    expect(text).toBe('Error: socket hang up');
  });
});

describe('an unanswered write, streaming error chunk', () => {
  it('is named in the SSE error chunk and marked not retried', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: false, error: new Error('socket hang up') };
    };
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(res.body).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary error chunk text untouched when nothing is unanswered', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: false, error: new Error('socket hang up') };
    };
    harness.unanswered = [];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('socket hang up');
    expect(res.body).not.toContain('UNVERIFIED_WRITE');
  });
});

describe('an unanswered write, streaming exception', () => {
  it('is named in the SSE error chunk and marked not retried', async () => {
    configure();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      throw new Error('socket hang up');
    };
    harness.unanswered = [{ call: { name: 'CreateClass' } }];

    const { res, done } = call(body(true));
    await done;

    expect(res.body).toContain('UNVERIFIED_WRITE: CreateClass');
    expect(res.body).toContain('was NOT retried');
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(1);
  });

  it('leaves the ordinary exception text untouched when nothing is unanswered', async () => {
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
    const done = handleChatCompletions(req, res as unknown as Response);
    return { res, done };
  }

  it('a long-session request leaves its connection open after the response — success', async () => {
    configure();
    const { res, done } = callInSession(body());
    await done;
    expect(res.statusCode).toBe(200);
    expect(harness.events).not.toContain('safeStop');
    expect(s.connection).toEqual({ id: 'conn' });
    expect(s.destination).toBe('DEST');

    // The next request of the session is served through the same connection.
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
      expect(res.statusCode).toBe(openAiDoorRefusal('capacity').status);
      expect(harness.events).not.toContain('safeStop');
      expect(s.connection).toEqual({ id: 'conn' });
    } finally {
      if ('admitted' in hold) hold.admitted.release();
    }
  });

  it('a closed session is refused 404 SESSION_NOT_FOUND and connects nothing', async () => {
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
    clearSession('s-status', 'alice');
    const { res, done } = call(body(true), fakeRes(), 's-status');
    await done;
    expect(getSessionHistory('s-status', 'alice')).toEqual([
      expect.objectContaining({ role: 'user', content: 'hi' }),
      expect.objectContaining({ role: 'assistant', content: 'answer' }),
    ]);
    expect(
      JSON.stringify(getSessionHistory('s-status', 'alice')),
    ).not.toContain('stepId');
    expect(res.body).toContain(`: status ${JSON.stringify(status)}\n\n`);
    const data = res.body
      .split('\n')
      .filter((line: string) => line.startsWith('data: '));
    const first = JSON.parse(data[0].slice(6));
    expect(first.choices[0].delta.role).toBe('assistant');
    expect(res.body.indexOf(': status ')).toBeLessThan(
      res.body.indexOf('data: '),
    );
    expect(res.body).toContain('answer');
    expect(res.body).not.toContain('event: status');
  });
});

describe('selected collection retrieval', () => {
  afterEach(() => jest.restoreAllMocks());
  it('reads rag_collections from a raw, unparsed body', async () => {
    const { getCollectionRegistry } = require('../../srv/agent-manager');
    const registry = getCollectionRegistry();
    jest.spyOn(registry, 'getCollection').mockResolvedValue({
      id: 'docs__u_alice',
      owner: 'alice',
      scope: 'user',
    });
    jest
      .spyOn(registry, 'degradedOf')
      .mockResolvedValue({ httpStatus: 409, message: 'collection degraded' });
    const raw = Buffer.from(
      JSON.stringify({ ...body(), rag_collections: ['docs__u_alice'] }),
    );
    const req = {
      ...fakeReq(undefined),
      async *[Symbol.asyncIterator]() {
        yield raw;
      },
    } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.message).toBe('collection degraded');
    expect(harness.events).not.toContain('pipeline');
  });
});
