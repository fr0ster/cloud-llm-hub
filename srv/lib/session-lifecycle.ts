/**
 * What opening, closing and reviving a long session mean for the rest of the
 * hub. The registry (`long-session.ts`) owns the caps, the queue and the close
 * protocol; this module is the hooks it calls and the two ways in.
 *
 * - Open: a registry entry and a record.
 * - Close for good (explicit, TTL): the held ABAP connection, then everything
 *   kept under the key (history in memory and in the recall store, session
 *   collections, destination — retention's close) and the record.
 * - Shutdown: the ABAP connection only. The state and the record stay, so a
 *   client presenting its key after the restart gets its hub session back.
 * - Revival: a key the registry does not hold, whose record is still within
 *   its TTL, is opened again under the same key, with its destination and the
 *   latest turns of its history. Its ABAP side starts afresh (spec §6: the old
 *   ABAP session is left to SAP's timeout until the library can close it).
 *
 * The record store `lifecycleHooks` was given is the one `openSession`,
 * `resolveSession` and the sweep use: there is one registry per process.
 */
import cds from '@sap/cds';
import {
  getSharedHistoryRag,
  isProvidersReady,
  setSessionDestination,
} from '../agent-manager';
import type { CollectionRegistry } from '../rag-collections';
import {
  appendToSession,
  hasSessionHistory,
  SESSION_MAX_MESSAGES,
} from '../session-store';
import { closeDialogue, touchDialogue } from './dialogue-sessions';
import { deleteDialogueState, sweepDialogueStates } from './dialogue-store';
import { deleteSession, maySweepSession } from './gatekeeper';
import { guardedTask } from './guarded-task';
import {
  type LongSession,
  type LongSessionHooks,
  longSessions,
  longSessionsIfReady,
  type OpenRefusal,
} from './long-session';
import { getRunRecordStore, sweepRunRecords } from './run-record-store';
import { dropSessionConnection } from './session-connection';
import { type StoredTurn, turnOwner } from './session-history-rag';
import type { SessionRecord, SessionRecordStore } from './session-record-store';

const log = () => cds.log('long-session');

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let records: SessionRecordStore | undefined;

/**
 * Keys closed for good, until their TTL would have run out anyway. A record
 * whose delete failed must not bring a closed session back (spec §6: a closed
 * key is refused, never revived); past the TTL the record is expired and
 * refused on its own.
 */
const closed = new Map<string, number>();

/** Revivals in flight: two requests presenting one key read the store once. */
const reviving = new Map<string, Promise<LongSession | undefined>>();

/** Revived sessions whose first response has not told the client yet. */
const revivalNotices = new WeakSet<LongSession>();

function slot(userId: string, key: string): string {
  return JSON.stringify([userId, key]);
}

function recordOf(s: LongSession): SessionRecord {
  return {
    userId: s.userId,
    key: s.key,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    ttlMs: longSessions().ttlMs,
    ...(s.destination !== undefined ? { destination: s.destination } : {}),
  };
}

/** A revival refused because the user, or the hub, holds all the sessions it may. */
export class SessionLimitError extends Error {
  readonly refused = 'SESSION_LIMIT';
  constructor() {
    super('session limit reached');
    this.name = 'SessionLimitError';
  }
}

/** Retry-After of a revival refused before the providers are built. */
export const PROVIDERS_RETRY_AFTER_SECONDS = 5;

/**
 * A revival refused because the providers are not built yet: the history
 * window cannot be read, and a session revived without it would never get it
 * back. The client retries; the record waits. Same as the readiness gate on
 * the chat routes, which refuses rather than waits.
 */
export class SessionNotReadyError extends Error {
  readonly refused = 'SESSION_STORE_UNAVAILABLE';
  readonly retryAfterSeconds = PROVIDERS_RETRY_AFTER_SECONDS;
  constructor() {
    super('the hub is starting: the session cannot be revived yet');
    this.name = 'SessionNotReadyError';
  }
}

/** The registry's hooks; `store` is where records go (none: no revival). */
export function lifecycleHooks(store?: SessionRecordStore): LongSessionHooks {
  records = store;
  closed.clear();
  reviving.clear();
  return {
    async onClose(s, reason) {
      try {
        await closeDialogue(s.userId, s.key, reason, false);
      } catch {
        log().warn('Dialogue shutdown failed');
      }
      await dropSessionConnection(s);
      if (reason === 'shutdown') return;
      closed.set(slot(s.userId, s.key), s.lastActivity + longSessions().ttlMs);
      await markClosed(recordOf(s));
      await cleanupSession(s.userId, s.key);
      await records?.delete(s.userId, s.key);
    },
    onTouch(s) {
      void touchDialogue(s.userId, s.key).catch(() =>
        log().warn('Dialogue touch failed'),
      );
      void records?.touch(recordOf(s)).catch((err) =>
        log().warn('session record write failed', {
          key: s.key,
          error: errorText(err),
        }),
      );
    },
  };
}

/**
 * A new long session and its record. A failed record write is logged, not
 * refused: the session works; only its revival after a crash is at stake, and
 * the next activity writes the record again.
 */
export async function openSession(
  userId: string,
  destination?: string,
): Promise<LongSession | OpenRefusal> {
  const s = longSessions().open(userId, { destination });
  if ('refused' in s) return s;
  if (destination !== undefined)
    setSessionDestination(userId, s.key, destination);
  try {
    await records?.put(recordOf(s));
  } catch (err) {
    log().warn('session record write failed', {
      key: s.key,
      error: errorText(err),
    });
  }
  return s;
}

/**
 * The live session under this key, or one revived from its record; undefined
 * when there is neither (never opened, closed, expired, another user's).
 * Rejects with `SessionLimitError` when a revival finds no room, with
 * `SessionNotReadyError` when a record exists but the providers are not built,
 * and with the store's error when the record cannot be read.
 */
export function resolveSession(
  userId: string,
  key: string,
): Promise<LongSession | undefined> {
  const id = slot(userId, key);
  // A revival in flight first: until it is complete, nothing is served.
  const pending = reviving.get(id);
  if (pending) return pending;
  const live = longSessions().get(userId, key);
  if (live) return Promise.resolve(live);
  if (!records || isClosed(userId, key)) return Promise.resolve(undefined);
  const started = revive(records, userId, key).finally(() =>
    reviving.delete(id),
  );
  reviving.set(id, started);
  return started;
}

/** Whether the client still has to be told this session was revived; once. */
export function takeRevivalNotice(s: LongSession): boolean {
  return revivalNotices.delete(s);
}

function isClosed(userId: string, key: string): boolean {
  const until = closed.get(slot(userId, key));
  return until !== undefined && until >= Date.now();
}

/**
 * Everything kept under a session the registry does not hold, deleted: history
 * (memory and the recall store), session collections, destination — through
 * retention's close, as for a live session — and the record. For a session
 * that expired while the hub was down. The key is tombstoned first, so a
 * revival reading the record meanwhile writes nothing back. Logged, not thrown.
 */
export async function discardSession(
  userId: string,
  key: string,
): Promise<void> {
  closed.set(slot(userId, key), Date.now() + longSessions().ttlMs);
  try {
    const record = await records?.get(userId, key);
    if (record) await markClosed(record);
    await cleanupSession(userId, key);
    await records?.delete(userId, key);
  } catch (err) {
    log().warn('expired session cleanup failed', {
      key,
      error: errorText(err),
    });
    return;
  }
  log().info('expired session deleted', { key });
}

async function markClosed(record: SessionRecord): Promise<void> {
  try {
    await records?.put({ ...record, closedAt: record.closedAt ?? Date.now() });
  } catch (err) {
    log().warn('session close marker write failed', {
      key: record.key,
      error: errorText(err),
    });
  }
}

/**
 * The session's state, then its history. `deleteSession` goes through
 * retention, which cancels the session's RAG leases and waits for them before
 * removing its collections; only then is the history forgotten, with the
 * outcome checked, so a failed delete keeps the closed record for a retry.
 */
async function cleanupSession(userId: string, key: string): Promise<void> {
  await getRunRecordStore().delete(userId, key);
  await deleteSession(userId, key);
  try {
    await deleteDialogueState(userId, key);
  } catch {
    log().warn('Dialogue state deletion failed; TTL sweep will retry');
  }
  if (!isProvidersReady()) return;
  const forgotten = await getSharedHistoryRag()?.forgetOwner(
    turnOwner(userId, key),
  );
  if (forgotten === false) throw new Error('Session history forget failed');
}

/**
 * Before the providers are built there is no recall store or collection
 * registry to delete from: an expired session then stays as it is, record
 * included, for a later pass.
 */
function mayDiscard(): boolean {
  return isProvidersReady();
}

/**
 * A revival is complete before anything sees it: the window is read first,
 * and the registry entry, destination and window are set in one synchronous
 * step after it, unless the key was closed or discarded meanwhile.
 */
async function revive(
  store: SessionRecordStore,
  userId: string,
  key: string,
): Promise<LongSession | undefined> {
  const rec = await store.get(userId, key);
  if (!rec) return undefined;
  if (rec.closedAt !== undefined || rec.lastActivity + rec.ttlMs < Date.now()) {
    if (mayDiscard()) await discardSession(userId, key);
    return undefined;
  }
  if (!isProvidersReady()) throw new SessionNotReadyError();
  const turns = await readWindow(userId, key);
  // Closed or discarded while the record and the history were read.
  if (isClosed(userId, key)) return undefined;
  const opened = longSessions().open(userId, {
    key,
    createdAt: rec.createdAt,
    destination: rec.destination,
    revived: true,
  });
  if ('refused' in opened) {
    // Opened meanwhile by another path: that session is the one.
    if (opened.refused === 'SESSION_EXISTS')
      return longSessions().get(userId, key);
    throw new SessionLimitError();
  }
  if (rec.destination !== undefined)
    setSessionDestination(userId, key, rec.destination);
  if (!hasSessionHistory(key, userId)) {
    for (const t of turns) {
      appendToSession(
        key,
        userId,
        { role: 'user', content: t.userText },
        { role: 'assistant', content: t.assistantText },
      );
    }
  }
  revivalNotices.add(opened);
  log().info('long session revived', { key });
  return opened;
}

/**
 * The latest turns of the recall store, for the in-memory window. Without a
 * recall store, or when it fails, the session comes back without its window;
 * the turns stay in the store, still reachable by recall.
 */
async function readWindow(userId: string, key: string): Promise<StoredTurn[]> {
  if (hasSessionHistory(key, userId)) return [];
  const rag = getSharedHistoryRag();
  if (!rag) return [];
  try {
    const turns = await rag.listTurns(turnOwner(userId, key));
    return turns.slice(-SESSION_MAX_MESSAGES / 2);
  } catch (err) {
    log().warn('revived session history could not be read', {
      key,
      error: errorText(err),
    });
    return [];
  }
}

/**
 * One sweep pass: idle sessions are closed (TTL), and sessions whose record
 * ran past its TTL with no live session — nobody came back after a restart —
 * are discarded, state and record.
 */
export async function sweepSessions(): Promise<void> {
  const registry = longSessionsIfReady();
  if (!registry) return;
  await registry.sweep();
  const now = Date.now();
  for (const [id, until] of closed) if (until < now) closed.delete(id);
  if (!records || !mayDiscard()) return;
  for (const r of await records.list()) {
    if (
      (r.closedAt === undefined && r.lastActivity + r.ttlMs >= now) ||
      registry.has(r.userId, r.key)
    )
      continue;
    await discardSession(r.userId, r.key);
  }
}

/** Runs `sweepSessions` every `intervalMs`; a pass still running skips a tick. Returns the stop. */
export function startSessionSweep(intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(
    guardedTask('Long-session sweep', log(), async () => {
      guardedTask('Dialogue-state expiry sweep', log(), () =>
        sweepDialogueStates(),
      )();
      guardedTask('Run-record expiry sweep', log(), () => sweepRunRecords())();
      if (running) return;
      running = true;
      try {
        await sweepSessions();
      } finally {
        running = false;
      }
    }),
    intervalMs,
  );
  timer.unref();
  return () => clearInterval(timer);
}

/** Session collections with a durable record belong to lifecycle cleanup. */
export async function sweepSessionCollections(
  collections: Pick<CollectionRegistry, 'sweepExpiredSessions'>,
): Promise<unknown> {
  const stored = new Set(
    ((await records?.list()) ?? []).map((r) => slot(r.userId, r.key)),
  );
  return collections.sweepExpiredSessions(
    (userId, key) =>
      !stored.has(slot(userId, key)) && maySweepSession(userId, key),
  );
}
