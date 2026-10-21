import { getRunRecordStore } from '../../srv/lib/run-record-store';
import { scopedStore } from './helpers/scoped-run-store';

const mockWarn = jest.fn();
const mockCdsContext: {
  user?: { id: string; is?: (role: string) => boolean };
} = {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn: mockWarn, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCollectionRegistry,
  getCurrentDestination,
  setSessionDestination,
} from '../../srv/agent-manager';
import { sessionCollectionId } from '../../srv/collection-ids';
import {
  deleteSessionState,
  hasSessionState,
} from '../../srv/lib/session-state';
import { appendToSession, getSessionHistory } from '../../srv/session-store';
import { initInMemoryProviders } from './helpers/providers';

initInMemoryProviders();

const SID = 'shared-id';

function seed(user: string, destination: string) {
  appendToSession(SID, user, { role: 'user', content: `hi from ${user}` });
  setSessionDestination(user, SID, destination);
  getCollectionRegistry().createCollection({
    id: sessionCollectionId('notes', user, SID),
    logicalId: 'notes',
    displayName: 'notes',
    description: '',
    scope: 'session',
    owner: user,
    sessionId: SID,
    expiresAt: Date.now() + 60_000,
  });
}

afterEach(() => {
  deleteSessionState('alice', SID);
  deleteSessionState('bob', SID);
});

describe('one session, every store', () => {
  it('does not collide when the parts could be read two ways', () => {
    // ("a", "b c") and ("a b", "c") must stay two keys, whatever separator a
    // join would use.
    setSessionDestination('a', 'b c', 'S4HANA_DEV');
    setSessionDestination('a b', 'c', 'S4HANA_QAS');
    expect(getCurrentDestination('a', 'b c')).toBe('S4HANA_DEV');
    expect(getCurrentDestination('a b', 'c')).toBe('S4HANA_QAS');
  });

  it('does not share a destination between two users with the same session id', () => {
    seed('alice', 'S4HANA_DEV');
    seed('bob', 'S4HANA_QAS');
    expect(getCurrentDestination('alice', SID)).toBe('S4HANA_DEV');
    expect(getCurrentDestination('bob', SID)).toBe('S4HANA_QAS');
  });

  it("deletes one user's session and leaves the other's turns, collections and destination", async () => {
    seed('alice', 'S4HANA_DEV');
    seed('bob', 'S4HANA_QAS');

    deleteSessionState('alice', SID);

    expect(getSessionHistory(SID, 'alice')).toEqual([]);
    expect(
      await getCollectionRegistry().getCollection(
        sessionCollectionId('notes', 'alice', SID),
      ),
    ).toBeNull();
    expect(getCurrentDestination('alice', SID)).not.toBe('S4HANA_DEV');

    expect(getSessionHistory(SID, 'bob')).toHaveLength(1);
    expect(
      await getCollectionRegistry().getCollection(
        sessionCollectionId('notes', 'bob', SID),
      ),
    ).not.toBeNull();
    expect(getCurrentDestination('bob', SID)).toBe('S4HANA_QAS');
  });

  it('reports what is still held', () => {
    seed('alice', 'S4HANA_DEV');
    expect(hasSessionState('alice', SID)).toBe(true);
    deleteSessionState('alice', SID);
    expect(hasSessionState('alice', SID)).toBe(false);
  });
});

describe('no per-session map is keyed by the session alone', () => {
  it('holds in agent-manager', () => {
    const src = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/sessionTopicMap/);
    expect(src).not.toMatch(
      /lastDestinationBySession\.(get|set|delete)\(\s*sessionId\s*[,)]/,
    );
  });
});

it('deleteSessionState deletes the run record and isolates a new session', async () => {
  const store = scopedStore(getRunRecordStore());
  await store.save(SID, {
    runId: 'r',
    request: 'hi',
    plan: { steps: [], createdAt: 1 },
    steps: [],
    outcome: 'answered',
    finishedAt: 2,
  });
  deleteSessionState('alice', SID);
  await Promise.resolve();
  expect(await store.load(SID)).toBeUndefined();
  expect(await store.load('new-session')).toBeUndefined();
});
it('deleteSessionState logs a rejected run-record delete', async () => {
  const spy = jest
    .spyOn(getRunRecordStore(), 'delete')
    .mockRejectedValueOnce(new Error('offline'));
  expect(() => deleteSessionState('alice', 'failed-delete')).not.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockWarn).toHaveBeenCalledWith('Run record delete failed', {
    error: 'offline',
  });
  spy.mockRestore();
});

it('retains a run-only session until its run record TTL expires', async () => {
  jest.useFakeTimers();
  try {
    const { initializeRunRecordStore } = await import(
      '../../srv/lib/run-record-store'
    );
    const { loadSessionConfig } = await import('../../srv/lib/session-config');
    initializeRunRecordStore({ ...loadSessionConfig({}), ttlMs: 100 });
    const store = scopedStore(getRunRecordStore());
    await store.save(SID, {
      runId: 'run',
      request: 'hi',
      plan: { steps: [], createdAt: 1 },
      steps: [],
      outcome: 'answered',
      finishedAt: 2,
    });
    expect(hasSessionState('alice', SID)).toBe(true);
    expect(hasSessionState('bob', SID)).toBe(false);
    jest.advanceTimersByTime(101);
    expect(hasSessionState('alice', SID)).toBe(false);
    expect(await store.load(SID)).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});
