jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: {},
  },
}));
jest.mock('../../srv/agent-manager', () => ({
  isProvidersReady: () => true,
  getSharedHistoryRag: () => router,
}));

import { InMemoryRagProvider } from '@mcp-abap-adt/llm-agent';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import {
  createHubRagAccess,
  getHubRagAccess,
  initHubRagAccess,
} from '../../srv/lib/rag-access';
import {
  initSessionHistoryRouter,
  SessionHistoryRouter,
} from '../../srv/lib/session-history-collection';
import {
  appendToSession,
  hasSessionHistory,
  sweepSessionHistory,
} from '../../srv/session-store';

let router: SessionHistoryRouter;
afterEach(() => {
  setLongSessionsForTest(undefined);
  jest.restoreAllMocks();
});
test.each([false, true])(
  'window expiry deletes history only for plain sessions (long=%s)',
  async (long) => {
    initHubRagAccess(createHubRagAccess(null, 'in-memory'));
    const caller = {
      userId: 'expiry-user',
      sessionId: `expiry-${long}`,
      isAdmin: false,
    };
    await getHubRagAccess().access.bindings.bind(
      caller.sessionId,
      caller.userId,
    );
    const provider = new InMemoryRagProvider({ name: 'expiry-history' });
    router = new SessionHistoryRouter(provider);
    initSessionHistoryRouter(router);
    if (long) {
      const registry = new LongSessionRegistry(
        { ttlMs: 1e15, maxSessions: 10, maxPerUser: 10, queueLength: 1 },
        { onClose: async () => {} },
      );
      registry.open(caller.userId, { key: caller.sessionId });
      setLongSessionsForTest(registry);
    }
    expect(
      await router.recordTurn({
        caller,
        userText: 'private',
        assistantText: 'saved',
      }),
    ).toBe(true);
    appendToSession(caller.sessionId, caller.userId, {
      role: 'user',
      content: 'private',
    });
    const forget = router.forgetSessionHistory.bind(router);
    let resolveDeleted = () => {};
    const deleted = new Promise<void>((resolve) => {
      resolveDeleted = resolve;
    });
    const spy = jest
      .spyOn(router, 'forgetSessionHistory')
      .mockImplementation(async (sessionId) => {
        await forget(sessionId);
        resolveDeleted();
      });
    sweepSessionHistory(Date.now() + 365 * 86400000);
    expect(hasSessionHistory(caller.sessionId, caller.userId)).toBe(false);
    if (long) {
      expect(spy).not.toHaveBeenCalled();
      expect(await router.listTurns(caller)).toHaveLength(1);
    } else {
      await deleted;
      expect(spy).toHaveBeenCalledWith(caller.sessionId);
      expect(await router.listTurns(caller)).toEqual([]);
      const catalog = await provider.describeCollections();
      expect(catalog.ok && catalog.value.records).toEqual([]);
    }
  },
);
