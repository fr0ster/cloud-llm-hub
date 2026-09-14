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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { openAiDoorRefusal } from '../../srv/lib/throttle-surfacing';
import { handleChatCompletions } from '../../srv/openai-handler';
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
    if ('admitted' in hold) hold.admitted.release();
  });

  it('hands the pipeline the admission signal, not the caller', async () => {
    configure(2);
    const { done } = call(body());
    await done;
    expect(harness.seenOptions[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('a disconnect ends nothing, a dead socket cannot fail the run, and teardown is in order', async () => {
    configure(1);
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      // A write chain in flight, registered as the embedded handler registers it.
      void trackCall(
        tool.promise.then(() => harness.events.push('tool settled')),
      );
      yield { ok: true, value: { content: 'more' } };
      yield { ok: true, value: { finishReason: 'stop' } };
    };

    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();
    res.disconnect();
    await tick();
    expect(harness.events).not.toContain('safeStop');

    tool.resolve();
    await expect(done).resolves.toBeUndefined();
    expect(harness.events).toEqual([
      'getSmartAgent',
      'pipeline',
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

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

  it('a caller that leaves while queued starts no pipeline', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const res = fakeRes();
    const { done } = call(body(), res);
    await tick();
    res.disconnect();
    await done;
    expect(harness.events).not.toContain('pipeline');
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
