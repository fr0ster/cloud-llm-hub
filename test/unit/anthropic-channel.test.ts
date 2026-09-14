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
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { anthropicDoorRefusal } from '../../srv/lib/throttle-surfacing';
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
    if ('admitted' in hold) hold.admitted.release();
  });

  it('a disconnect ends nothing, and teardown waits for the call in flight', async () => {
    configure(1);
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      void trackCall(
        tool.promise.then(() => harness.events.push('tool settled')),
      );
      yield { ok: true, value: { finishReason: 'stop' } };
    };
    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();
    res.disconnect();
    await tick();
    expect(harness.events).not.toContain('safeStop');
    tool.resolve();
    await done;
    expect(harness.events.slice(-3)).toEqual([
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

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
