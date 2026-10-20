/**
 * What opening, closing and reviving a long session do to the rest of the
 * hub: the record, the session's state, the history window.
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

const deleteSession = jest.fn(async (_u: string, _s: string) => {});
jest.mock('../../srv/lib/gatekeeper', () => ({
  deleteSession: (u: string, s: string) => deleteSession(u, s),
}));

const dropSessionConnection = jest.fn(async (_s: unknown) => {});
jest.mock('../../srv/lib/session-connection', () => ({
  dropSessionConnection: (s: unknown) => dropSessionConnection(s),
}));

type Turn = {
  id: string;
  userText: string;
  assistantText: string;
  createdAt: string;
};
const listTurns = jest.fn(async (_owner: string): Promise<Turn[]> => []);
const forgetOwner = jest.fn(async () => true);
const setSessionDestination = jest.fn();
let providersReady = true;
jest.mock('../../srv/agent-manager', () => ({
  getCollectionRegistry: () => ({ deleteSessionCollections: async () => {} }),
  isProvidersReady: () => providersReady,
  getSharedHistoryRag: () => ({ listTurns, forgetOwner }),
  setSessionDestination: (u: string, s: string, d: string) =>
    setSessionDestination(u, s, d),
}));

import {
  LongSessionRegistry,
  longSessions,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import { turnOwner } from '../../srv/lib/session-history-rag';
import {
  discardSession,
  lifecycleHooks,
  openSession,
  PROVIDERS_RETRY_AFTER_SECONDS,
  resolveSession,
  sweepSessions,
  takeRevivalNotice,
} from '../../srv/lib/session-lifecycle';
import type {
  SessionRecord,
  SessionRecordStore,
} from '../../srv/lib/session-record-store';
import {
  appendToSession,
  clearSession,
  getSessionHistory,
} from '../../srv/session-store';

const TTL = 60_000;
let now = 1_000_000;

function fakeRecords() {
  const rows = new Map<string, SessionRecord>();
  const id = (u: string, k: string) => JSON.stringify([u, k]);
  const store = {
    put: jest.fn(async (r: SessionRecord) => {
      rows.set(id(r.userId, r.key), { ...r });
    }),
    touch: jest.fn(async (r: SessionRecord) => {
      rows.set(id(r.userId, r.key), { ...r });
    }),
    get: jest.fn(async (u: string, k: string) => rows.get(id(u, k))),
    delete: jest.fn(async (u: string, k: string) => {
      rows.delete(id(u, k));
    }),
    list: jest.fn(async () => [...rows.values()]),
  } satisfies SessionRecordStore;
  return { rows, store, id };
}

let records: ReturnType<typeof fakeRecords>;

function setup(withRecords = true) {
  records = fakeRecords();
  setLongSessionsForTest(
    new LongSessionRegistry(
      { ttlMs: TTL, maxSessions: 10, maxPerUser: 2, queueLength: 1 },
      lifecycleHooks(withRecords ? records.store : undefined),
      () => now,
    ),
  );
}

/** Opened, or the test fails. */
async function open(userId: string, destination?: string) {
  const s = await openSession(userId, destination);
  if ('refused' in s) throw new Error(`refused: ${s.refused}`);
  return s;
}

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  forgetOwner.mockReset().mockResolvedValue(true);
  deleteSession.mockClear();
  dropSessionConnection.mockClear();
  listTurns.mockReset().mockResolvedValue([]);
  setSessionDestination.mockClear();
  providersReady = true;
  setup();
});

afterEach(() => {
  jest.restoreAllMocks();
  setLongSessionsForTest(undefined);
});

describe('open', () => {
  it('open writes a record', async () => {
    const s = await open('alice', 'DEV');
    expect(s.key).toMatch(/^ls-/);
    expect(records.store.put).toHaveBeenCalledWith({
      userId: 'alice',
      key: s.key,
      createdAt: now,
      lastActivity: now,
      ttlMs: TTL,
      destination: 'DEV',
    });
    expect(setSessionDestination).toHaveBeenCalledWith('alice', s.key, 'DEV');
  });

  it('beyond the per-user cap: SESSION_LIMIT, no record', async () => {
    await open('alice');
    await open('alice');
    records.store.put.mockClear();
    expect(await openSession('alice')).toEqual({ refused: 'SESSION_LIMIT' });
    expect(records.store.put).not.toHaveBeenCalled();
  });

  it('a failing record write does not fail the open', async () => {
    records.store.put.mockRejectedValueOnce(new Error('store down'));
    const s = await open('alice');
    expect(longSessions().get('alice', s.key)).toBe(s);
  });

  it('activity moves the record', async () => {
    const s = await open('alice');
    now += 5_000;
    await longSessions().run(s, async () => undefined);
    expect(records.store.touch).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: s.key, lastActivity: now }),
    );
  });
});

describe('close', () => {
  it('explicit close deletes history, collections, destination and the record', async () => {
    const s = await open('alice', 'DEV');
    await longSessions().close('alice', s.key, 'explicit');
    expect(dropSessionConnection).toHaveBeenCalledWith(s);
    // deleteSession is retention's close: history (memory and store),
    // destination and session collections.
    expect(deleteSession).toHaveBeenCalledWith('alice', s.key);
    expect(records.store.delete).toHaveBeenCalledWith('alice', s.key);
    expect(records.rows.size).toBe(0);
  });

  it('history delete failure keeps the closed record', async () => {
    const s = await open('alice');
    forgetOwner.mockResolvedValueOnce(false);
    await expect(
      longSessions().close('alice', s.key, 'explicit'),
    ).rejects.toThrow();
    expect(records.store.delete).not.toHaveBeenCalled();
    expect(records.rows.get(records.id('alice', s.key))).toMatchObject({
      closedAt: now,
    });
  });

  it('failed record deletion cannot revive after restart and sweep retries', async () => {
    const s = await open('alice');
    records.store.delete.mockRejectedValueOnce(new Error('down'));
    await expect(
      longSessions().close('alice', s.key, 'explicit'),
    ).rejects.toThrow('down');
    expect(records.rows.get(records.id('alice', s.key))).toMatchObject({
      closedAt: now,
    });
    setLongSessionsForTest(
      new LongSessionRegistry(
        { ttlMs: TTL, maxSessions: 10, maxPerUser: 2, queueLength: 1 },
        lifecycleHooks(records.store),
        () => now,
      ),
    );
    providersReady = false;
    expect(await resolveSession('alice', s.key)).toBeUndefined();
    providersReady = true;
    await sweepSessions();
    expect(records.rows.size).toBe(0);
  });

  it('ttl close does the same', async () => {
    const s = await open('alice');
    now += TTL + 1;
    expect(await longSessions().sweep()).toBe(1);
    expect(dropSessionConnection).toHaveBeenCalledWith(s);
    expect(deleteSession).toHaveBeenCalledWith('alice', s.key);
    expect(records.store.delete).toHaveBeenCalledWith('alice', s.key);
  });

  it('shutdown keeps the record and the history', async () => {
    const s = await open('alice');
    appendToSession(s.key, 'alice', { role: 'user', content: 'hi' });
    await longSessions().closeAll('shutdown');
    expect(dropSessionConnection).toHaveBeenCalledWith(s);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(records.store.delete).not.toHaveBeenCalled();
    expect(records.rows.size).toBe(1);
    expect(getSessionHistory(s.key, 'alice')).toHaveLength(1);
    clearSession(s.key, 'alice');
  });

  it('a failing state delete keeps the closed record and rejects the close', async () => {
    const s = await open('alice');
    deleteSession.mockRejectedValueOnce(new Error('collections down'));
    await expect(
      longSessions().close('alice', s.key, 'explicit'),
    ).rejects.toThrow('collections down');
    expect(records.store.delete).not.toHaveBeenCalled();
    expect(records.rows.get(records.id('alice', s.key))).toMatchObject({
      closedAt: now,
    });
    expect(longSessions().has('alice', s.key)).toBe(false);
  });
});

describe('revival', () => {
  function stored(over: Partial<SessionRecord> = {}): SessionRecord {
    const r: SessionRecord = {
      userId: 'alice',
      key: 'ls-old',
      createdAt: now - 30_000,
      lastActivity: now - 10_000,
      ttlMs: TTL,
      destination: 'DEV',
      ...over,
    };
    records.rows.set(records.id(r.userId, r.key), r);
    return r;
  }

  const turn = (n: number): Turn => ({
    id: `t${n}`,
    userText: `question ${n}`,
    assistantText: `answer ${n}`,
    createdAt: new Date(n * 1000).toISOString(),
  });

  afterEach(() => clearSession('ls-old', 'alice'));

  it('revival restores destination and the history window', async () => {
    const r = stored();
    listTurns.mockResolvedValue([turn(1), turn(2), turn(3)]);
    const s = await resolveSession('alice', 'ls-old');
    expect(s).toMatchObject({
      userId: 'alice',
      key: 'ls-old',
      createdAt: r.createdAt,
      destination: 'DEV',
      revived: true,
    });
    expect(listTurns).toHaveBeenCalledWith(turnOwner('alice', 'ls-old'));
    expect(setSessionDestination).toHaveBeenCalledWith(
      'alice',
      'ls-old',
      'DEV',
    );
    const h = getSessionHistory('ls-old', 'alice');
    expect(h).toHaveLength(6);
    expect(h[0]).toEqual({ role: 'user', content: 'question 1' });
    expect(h[5]).toEqual({ role: 'assistant', content: 'answer 3' });
    // The notice: once.
    if (!s) throw new Error('not revived');
    expect(takeRevivalNotice(s)).toBe(true);
    expect(takeRevivalNotice(s)).toBe(false);
  });

  it('the window is the latest turns only', async () => {
    stored();
    listTurns.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => turn(i + 1)),
    );
    await resolveSession('alice', 'ls-old');
    const h = getSessionHistory('ls-old', 'alice');
    expect(h).toHaveLength(20);
    expect(h[0]).toEqual({ role: 'user', content: 'question 6' });
  });

  it('a live session is returned as it is, nothing read', async () => {
    const s = await open('alice');
    records.store.get.mockClear();
    expect(await resolveSession('alice', s.key)).toBe(s);
    expect(records.store.get).not.toHaveBeenCalled();
    expect(takeRevivalNotice(s)).toBe(false);
  });

  it('expired record is dropped, not revived', async () => {
    stored({ lastActivity: now - TTL - 1 });
    expect(await resolveSession('alice', 'ls-old')).toBeUndefined();
    expect(records.store.delete).toHaveBeenCalledWith('alice', 'ls-old');
    // Its state goes with it: history, collections, destination.
    expect(deleteSession).toHaveBeenCalledWith('alice', 'ls-old');
    expect(longSessions().has('alice', 'ls-old')).toBe(false);
  });

  it('concurrent resolve awaits the restore and sees the history', async () => {
    stored();
    let release!: (t: Turn[]) => void;
    listTurns.mockReturnValue(
      new Promise<Turn[]>((r) => {
        release = r;
      }),
    );
    const first = resolveSession('alice', 'ls-old');
    await new Promise((r) => setImmediate(r));
    // Not visible while it is being restored.
    expect(longSessions().get('alice', 'ls-old')).toBeUndefined();
    const second = resolveSession('alice', 'ls-old');
    release([turn(1), turn(2)]);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(getSessionHistory('ls-old', 'alice')).toHaveLength(4);
  });

  it('discarded during the scan: no history written, key not revived', async () => {
    stored();
    let release!: (t: Turn[]) => void;
    listTurns.mockReturnValue(
      new Promise<Turn[]>((r) => {
        release = r;
      }),
    );
    const pending = resolveSession('alice', 'ls-old');
    await new Promise((r) => setImmediate(r));
    await discardSession('alice', 'ls-old');
    release([turn(1)]);
    expect(await pending).toBeUndefined();
    expect(longSessions().has('alice', 'ls-old')).toBe(false);
    expect(getSessionHistory('ls-old', 'alice')).toHaveLength(0);
    expect(await resolveSession('alice', 'ls-old')).toBeUndefined();
  });

  it('closed key is not revived', async () => {
    const s = await open('alice');
    expect(records.rows.size).toBe(1);
    await longSessions().close('alice', s.key, 'explicit');
    expect(await resolveSession('alice', s.key)).toBeUndefined();
  });

  it('closed key is not revived even when its record could not be deleted', async () => {
    const s = await open('alice');
    records.store.delete.mockRejectedValueOnce(new Error('store down'));
    await expect(
      longSessions().close('alice', s.key, 'explicit'),
    ).rejects.toThrow('store down');
    expect(records.rows.size).toBe(1);
    expect(await resolveSession('alice', s.key)).toBeUndefined();
  });

  it('another user presenting the key reaches nothing', async () => {
    stored();
    expect(await resolveSession('mallory', 'ls-old')).toBeUndefined();
    expect(longSessions().size()).toBe(0);
  });

  it('two requests reviving one key at once read the store once and get one session', async () => {
    stored();
    const [a, b] = await Promise.all([
      resolveSession('alice', 'ls-old'),
      resolveSession('alice', 'ls-old'),
    ]);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(records.store.get).toHaveBeenCalledTimes(1);
    expect(getSessionHistory('ls-old', 'alice')).toHaveLength(0);
  });

  it('no record store: nothing to revive', async () => {
    setup(false);
    expect(await resolveSession('alice', 'ls-old')).toBeUndefined();
  });

  it('a history store that fails: revived with an empty window', async () => {
    stored();
    listTurns.mockRejectedValue(new Error('scan failed'));
    const s = await resolveSession('alice', 'ls-old');
    expect(s?.revived).toBe(true);
    expect(getSessionHistory('ls-old', 'alice')).toHaveLength(0);
  });

  it('before the providers are built: refused 503 with Retry-After, not revived empty', async () => {
    stored();
    listTurns.mockResolvedValue([turn(1)]);
    providersReady = false;
    await expect(resolveSession('alice', 'ls-old')).rejects.toMatchObject({
      refused: 'SESSION_STORE_UNAVAILABLE',
      retryAfterSeconds: PROVIDERS_RETRY_AFTER_SECONDS,
    });
    expect(longSessions().get('alice', 'ls-old')).toBeUndefined();
    expect(listTurns).not.toHaveBeenCalled();
    expect(records.rows.has(records.id('alice', 'ls-old'))).toBe(true);
    // Once they are: the retry gets the session with its history.
    providersReady = true;
    const s = await resolveSession('alice', 'ls-old');
    expect(s?.revived).toBe(true);
    expect(getSessionHistory('ls-old', 'alice')).toHaveLength(2);
    if (!s) throw new Error('not revived');
    expect(takeRevivalNotice(s)).toBe(true);
  });

  it('the user at the cap: refused with SESSION_LIMIT, the record kept', async () => {
    stored();
    await open('alice');
    await open('alice');
    await expect(resolveSession('alice', 'ls-old')).rejects.toMatchObject({
      refused: 'SESSION_LIMIT',
    });
    expect(records.rows.has(records.id('alice', 'ls-old'))).toBe(true);
  });
});

describe('the sweep', () => {
  it('closes idle sessions and deletes expired records nobody holds', async () => {
    const s = await open('alice');
    records.rows.set(records.id('bob', 'ls-orphan'), {
      userId: 'bob',
      key: 'ls-orphan',
      createdAt: now,
      lastActivity: now,
      ttlMs: TTL,
    });
    now += TTL + 1;
    await sweepSessions();
    expect(longSessions().has('alice', s.key)).toBe(false);
    expect(records.rows.size).toBe(0);
    expect(records.store.delete).toHaveBeenCalledWith('bob', 'ls-orphan');
    expect(deleteSession).toHaveBeenCalledWith('bob', 'ls-orphan');
  });

  it('leaves a live session and its record', async () => {
    const s = await open('alice');
    now += TTL / 2;
    await sweepSessions();
    expect(longSessions().has('alice', s.key)).toBe(true);
    expect(records.rows.size).toBe(1);
  });
});

it('R20 direct activity touch extends TTL and updates record without a queued run', async () => {
  const s = await open('alice');
  now += TTL - 1;
  longSessions().touch(s.userId, s.key);
  expect(records.store.touch).toHaveBeenLastCalledWith(
    expect.objectContaining({ lastActivity: now }),
  );
  now += TTL - 1;
  expect(await longSessions().sweep()).toBe(0);
});
