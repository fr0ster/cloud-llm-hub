/**
 * What `/v1/chat/completions` changes about shared state, and when.
 *
 * Everything a request mutates beyond its own response — the destination
 * agent's RAG stores, the session's history, collections and destination — is
 * changed only once the request is admitted. A request refused at the door,
 * answered `410`, or gone while queued has started nothing, so it may have
 * changed nothing either; and one still queued must not leak its session's
 * collections into the pipelines that run ahead of it.
 */

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
jest.mock('../../srv/lib/responsible', () =>
  require('./helpers/channel-harness').responsibleMock(),
);
// Any collection id the request names resolves to itself: the registry lookup
// is not what these tests are about.
jest.mock('../../srv/collection-ids', () => ({
  ...jest.requireActual('../../srv/collection-ids'),
  resolveRouteId: (_registry: unknown, id: string) => id,
}));

import type { Request, Response } from 'express';
import * as manager from '../../srv/agent-manager';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { handleChatCompletions } from '../../srv/openai-handler';
import { fakeReq, fakeRes, harness, tick } from './helpers/channel-harness';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

const body = () => ({
  model: 'm',
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
});

beforeEach(() => harness.reset());
afterEach(() => {
  jest.restoreAllMocks();
  configure();
});

describe('the RAG stores a request names', () => {
  it('reach the shared agent only once admitted, and are restored after', async () => {
    configure(1, 1);
    const registry = manager.getCollectionRegistry();
    const store = { name: 'col-1' };
    jest
      .spyOn(registry, 'getRagStores')
      .mockReturnValue({ 'col-1': store } as never);
    jest.spyOn(registry, 'getRagStore').mockReturnValue(null);
    const handle = (await manager.getSmartAgent()) as unknown as {
      agent: { deps: { ragStores: Record<string, unknown> } };
    };
    const deps = handle.agent.deps;
    let duringRun: string[] = [];
    harness.process = async () => {
      duringRun = Object.keys(deps.ragStores);
      return { ok: true, value: { content: 'done', stopReason: 'stop' } };
    };

    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const req = fakeReq(body()) as unknown as Request;
    req.headers['x-rag-collections'] = 'col-1';
    const done = handleChatCompletions(req, fakeRes() as unknown as Response);
    await tick();

    try {
      // Queued: every pipeline admitted ahead of it runs on this same agent,
      // and must not see this caller's session collections.
      expect(gatekeeper.theDoor()?.snapshot().queued).toBe(1);
      expect(Object.keys(deps.ragStores)).not.toContain('col-1');
    } finally {
      if ('admitted' in hold) hold.admitted.release();
      await done;
    }
    expect(duringRun).toContain('col-1');
    expect(Object.keys(deps.ragStores)).not.toContain('col-1');
  });

  it('are never installed for a request refused at the door', async () => {
    configure(1, 1);
    const registry = manager.getCollectionRegistry();
    const getRagStores = jest
      .spyOn(registry, 'getRagStores')
      .mockReturnValue({ 'col-1': {} } as never);
    jest.spyOn(registry, 'getRagStore').mockReturnValue(null);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    // Fills the queue. Rejected if the gatekeeper is reset while it still waits.
    const filler = gatekeeper
      .admitPipeline('carol', 'queued')
      .catch(() => undefined);
    await tick();

    try {
      const req = fakeReq(body()) as unknown as Request;
      req.headers['x-rag-collections'] = 'col-1';
      const res = fakeRes();
      await handleChatCompletions(req, res as unknown as Response);

      expect(res.statusCode).toBe(503);
      expect(getRagStores).not.toHaveBeenCalled();
    } finally {
      if ('admitted' in hold) hold.admitted.release();
      const queued = await filler;
      if (queued && 'admitted' in queued) queued.admitted.release();
    }
  });
});
