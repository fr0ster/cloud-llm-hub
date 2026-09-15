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
jest.mock('../../srv/lib/request-system-context', () =>
  require('./helpers/channel-harness').requestSystemMock(),
);
// Any collection id the request names resolves to itself: the registry lookup
// is not what these tests are about.
jest.mock('../../srv/collection-ids', () => ({
  ...jest.requireActual('../../srv/collection-ids'),
  resolveRouteId: (_registry: unknown, id: string) => id,
}));

import type { Message } from '@mcp-abap-adt/llm-agent';
import type { Request, Response } from 'express';
import * as manager from '../../srv/agent-manager';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import type { Lease } from '../../srv/lib/session-retention';
import { handleChatCompletions } from '../../srv/openai-handler';
import { getRequestHistory } from '../../srv/request-session';
import * as sessionStore from '../../srv/session-store';
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

  it('are never installed for a request refused at the door (RAG)', async () => {
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

describe('a destination switch', () => {
  const USER = 'alice';
  const SID = 's-1';

  /** A session the caller presented, with one earlier turn on DEST, now asking for OTHER. */
  function switchingRequest() {
    sessionStore.appendToSession(SID, USER, {
      role: 'user',
      content: 'earlier',
    });
    harness.sessionDestinations.set(JSON.stringify([USER, SID]), 'DEST');
    const req = fakeReq(body(), SID, false) as unknown as Request;
    req.headers['x-sap-destination'] = 'OTHER';
    return req;
  }
  const history = () =>
    sessionStore.getSessionHistory(SID, USER).map((m) => m.content);
  const switchedTo = (destination: string) => [
    { userId: USER, sessionId: SID, destination },
  ];

  // Before as well as after: the RAG tests above answer on the same session id
  // and store their turn under it.
  beforeEach(() => sessionStore.clearSession(SID, USER));
  afterEach(() => sessionStore.clearSession(SID, USER));

  it('wipes and switches nothing for a request refused at the door', async () => {
    configure(1, 1);
    const del = jest.spyOn(
      manager.getCollectionRegistry(),
      'deleteSessionCollections',
    );
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const filler = gatekeeper
      .admitPipeline('carol', 'queued')
      .catch(() => undefined);
    await tick();
    try {
      const res = fakeRes();
      await handleChatCompletions(
        switchingRequest(),
        res as unknown as Response,
      );

      expect(res.statusCode).toBe(503);
      expect(history()).toEqual(['earlier']);
      expect(del).not.toHaveBeenCalled();
      expect(harness.destinationSets).toEqual([]);
    } finally {
      if ('admitted' in hold) hold.admitted.release();
      const queued = await filler;
      if (queued && 'admitted' in queued) queued.admitted.release();
    }
  });

  it('wipes and switches nothing for a request that leaves while queued', async () => {
    configure(1, 1);
    const del = jest.spyOn(
      manager.getCollectionRegistry(),
      'deleteSessionCollections',
    );
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    try {
      const res = fakeRes();
      const done = handleChatCompletions(
        switchingRequest(),
        res as unknown as Response,
      );
      await tick();
      res.disconnect();
      await done;

      expect(harness.events).not.toContain('pipeline');
      expect(history()).toEqual(['earlier']);
      expect(del).not.toHaveBeenCalled();
      expect(harness.destinationSets).toEqual([]);
    } finally {
      if ('admitted' in hold) hold.admitted.release();
    }
  });

  it('does not re-create destination tracking for a session removed while it waited', async () => {
    configure(2);
    const gate = deferred();
    harness.agentGate = gate.promise;
    const res = fakeRes();
    const done = handleChatCompletions(
      switchingRequest(),
      res as unknown as Response,
    );
    await tick();
    await gatekeeper.deleteSession(USER, SID);
    gate.resolve();
    await done;

    expect(res.statusCode).toBe(410);
    expect(harness.destinationSets).toEqual([]);
  });

  it('keeps the session collections while a RAG operation holds the session', async () => {
    configure(2);
    const del = jest.spyOn(
      manager.getCollectionRegistry(),
      'deleteSessionCollections',
    );
    const req = switchingRequest();
    // An upload into this session's collection is still writing: removing the
    // registry entry and directory under it is the leak three-step deletion
    // closes.
    const upload = gatekeeper.leaseSession(USER, SID, 'rag') as Lease;
    try {
      const res = fakeRes();
      await handleChatCompletions(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(del).not.toHaveBeenCalled();
      // The history is still cleared: the admission's pipeline lease already
      // excludes this session's other pipelines.
      expect(history()).not.toContain('earlier');
      expect(harness.destinationSets).toEqual(switchedTo('OTHER'));
    } finally {
      upload.release();
    }
  });

  it('clears the history, removes the collections and switches, once admitted', async () => {
    configure(2);
    const del = jest.spyOn(
      manager.getCollectionRegistry(),
      'deleteSessionCollections',
    );
    let priorTurns: Message[] = [];
    let messages: unknown;
    harness.process = async (m) => {
      messages = m;
      priorTurns = getRequestHistory();
      return { ok: true, value: { content: 'done', stopReason: 'stop' } };
    };
    const res = fakeRes();
    await handleChatCompletions(switchingRequest(), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(del).toHaveBeenCalledWith(USER, SID);
    expect(history()).not.toContain('earlier');
    expect(harness.destinationSets).toEqual(switchedTo('OTHER'));
    // The run itself starts clean: neither its messages nor the prior turns
    // bound for the executor carry the history the switch cleared.
    expect(JSON.stringify(messages)).not.toContain('earlier');
    expect(JSON.stringify(priorTurns)).not.toContain('earlier');
  });
});

describe('the user a request is keyed by', () => {
  it('keys an empty user id as itself, as the other channels and the middleware do', async () => {
    configure();
    const before = harness.user.id;
    harness.user.id = '';
    try {
      const done = handleChatCompletions(
        fakeReq(body()) as unknown as Request,
        fakeRes() as unknown as Response,
      );
      await done;
      expect(sessionStore.getSessionHistory('s-1', '')).toHaveLength(2);
      expect(sessionStore.getSessionHistory('s-1', 'anonymous')).toEqual([]);
    } finally {
      harness.user.id = before;
      sessionStore.clearSession('s-1', '');
      sessionStore.clearSession('s-1', 'anonymous');
    }
  });
});
