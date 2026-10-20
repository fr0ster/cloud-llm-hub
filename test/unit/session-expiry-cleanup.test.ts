/**
 * A session that expired while the hub was down: whichever path finds its
 * record (a client presenting the key, or the sweep), everything kept under
 * the key goes through the real retention close — recall turns, session
 * collections, destination — and the record with it.
 */
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: {},
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/lib/session-connection', () => ({
  dropSessionConnection: async () => {},
}));

const forgetOwner = jest.fn(async (_owner: string) => {});
const deleteSessionCollections = jest.fn();
const forgetSessionDestination = jest.fn();
let providersReady = true;
jest.mock('../../srv/agent-manager', () => ({
  isProvidersReady: () => providersReady,
  getSharedHistoryRag: () => ({ forgetOwner, listTurns: async () => [] }),
  getCollectionRegistry: () => ({
    deleteSessionCollections,
    hasSessionCollections: () => false,
  }),
  forgetSessionDestination: (u: string, s: string) =>
    forgetSessionDestination(u, s),
  setSessionDestination: () => {},
}));

import { resetGatekeeperForTest } from '../../srv/lib/gatekeeper';
import {
  LongSessionRegistry,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { turnOwner } from '../../srv/lib/session-history-rag';
import {
  lifecycleHooks,
  resolveSession,
  sweepSessions,
} from '../../srv/lib/session-lifecycle';
import type {
  SessionRecord,
  SessionRecordStore,
} from '../../srv/lib/session-record-store';

const TTL = 60_000;
const NOW = 10_000_000;

function store(rec: SessionRecord) {
  const rows = new Map([[rec.key, rec]]);
  return {
    rows,
    s: {
      put: async () => {},
      touch: async () => {},
      get: async (u: string, k: string) =>
        rows.get(k)?.userId === u ? rows.get(k) : undefined,
      delete: jest.fn(async (_u: string, k: string) => {
        rows.delete(k);
      }),
      list: async () => [...rows.values()],
    } satisfies SessionRecordStore,
  };
}

const expired: SessionRecord = {
  userId: 'alice',
  key: 'ls-expired',
  createdAt: NOW - 3 * TTL,
  lastActivity: NOW - 2 * TTL,
  ttlMs: TTL,
  destination: 'DEV',
};

let records: ReturnType<typeof store>;

beforeEach(() => {
  providersReady = true;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  forgetOwner.mockClear();
  deleteSessionCollections.mockClear();
  forgetSessionDestination.mockClear();
  resetGatekeeperForTest();
  records = store({ ...expired });
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: TTL, maxSessions: 10, maxPerUser: 5, queueLength: 1 },
      lifecycleHooks(records.s),
      () => NOW,
    ),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  setLongSessionsForTest(undefined);
});

function expectCleanedUp() {
  expect(forgetOwner).toHaveBeenCalledWith(turnOwner('alice', 'ls-expired'));
  expect(deleteSessionCollections).toHaveBeenCalledWith('alice', 'ls-expired');
  expect(forgetSessionDestination).toHaveBeenCalledWith('alice', 'ls-expired');
  expect(records.s.delete).toHaveBeenCalledWith('alice', 'ls-expired');
  expect(records.rows.size).toBe(0);
}

it('expired record found by resolve: state and record deleted, not revived', async () => {
  expect(await resolveSession('alice', 'ls-expired')).toBeUndefined();
  expectCleanedUp();
});

it('expired record found by the sweep: state and record deleted', async () => {
  await sweepSessions();
  expectCleanedUp();
});

it('before the providers are built: left for a later pass, record kept', async () => {
  providersReady = false;
  await sweepSessions();
  expect(await resolveSession('alice', 'ls-expired')).toBeUndefined();
  expect(records.rows.size).toBe(1);
  expect(deleteSessionCollections).not.toHaveBeenCalled();
});
