import type { IUsageRecorder } from '@mcp-abap-adt/llm-agent';
import {
  type Protocol,
  type SessionCloseReason,
  sessionRecord,
} from './hub-records';
import { usageRuntime } from './runtime';
import { withinUsageShutdownBudget } from './shutdown';
import {
  type StorageSnapshot,
  storageSnapshots,
  type UsageSession,
  unknownStorageSnapshot,
} from './storage-snapshot';

interface LiveSession {
  closed: boolean;
  deliveries: Set<Promise<void>>;
  closing?: Promise<void>;
  session: UsageSession;
  usage: IUsageRecorder;
  startedAt: number;
  turns: number;
  tasks: number;
  messagesDelivered: number;
  openai: number;
  anthropic: number;
  mcpAgent: number;
}
const live = new Map<string, LiveSession>();
const pending = new Map<string, LiveSession>();
const closingSessions = new Set<LiveSession>();
const closingTasks = new Set<Promise<void>>();
export const SESSION_TOMBSTONE_LIMIT = 1024;
const tombstones = new Set<string>();
function rememberClosed(sessionKey: string): void {
  tombstones.delete(sessionKey);
  tombstones.add(sessionKey);
  if (tombstones.size > SESSION_TOMBSTONE_LIMIT) {
    const oldest = tombstones.values().next();
    if (!oldest.done) tombstones.delete(oldest.value);
  }
}
export function usageSessionBookkeepingForTest() {
  return {
    live: live.size,
    pending: pending.size,
    closing: closingTasks.size,
    tombstones: tombstones.size,
  };
}
export function holdSessionDelivery(session: UsageSession): () => void {
  const s = live.get(key(session));
  if (!s) return () => {};
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve: () => void) => {
    settle = resolve;
  });
  s.deliveries.add(done);
  return () => {
    s.deliveries.delete(done);
    settle();
  };
}
let shuttingDown = false;
export function beginUsageShutdown(): void {
  shuttingDown = true;
}
const key = (s: UsageSession): string =>
  JSON.stringify([s.userId, s.sessionId]);
export function sessionOpened(
  session: UsageSession,
  event: 'open' | 'revive' = 'open',
  startedAt: number = Date.now(),
): void {
  const runtime = usageRuntime();
  if (
    !runtime ||
    (!runtime.enabled('session') && !runtime.enabled('storage')) ||
    live.has(key(session))
  )
    return;
  if (runtime.enabled('storage')) storageSnapshots().retain?.(session);
  tombstones.delete(key(session));
  const usage = runtime.forSession(session);
  live.set(key(session), {
    closed: false,
    deliveries: new Set(),
    session,
    usage,
    startedAt,
    turns: 0,
    tasks: 0,
    messagesDelivered: 0,
    openai: 0,
    anthropic: 0,
    mcpAgent: 0,
  });
  sessionRecord(usage, { event });
}
function emitClose(
  s: LiveSession,
  reason: SessionCloseReason,
  snapshot?: StorageSnapshot,
  endKnown: boolean = true,
): void {
  if (!snapshot && usageRuntime()?.enabled('storage'))
    snapshot = unknownStorageSnapshot();
  if (snapshot && usageRuntime()?.enabled('storage'))
    s.usage.record({
      context: {},
      kind: 'x.hub.storage',
      outcome: 'ok',
      values: { ...snapshot },
    });
  sessionRecord(
    s.usage,
    {
      event: 'close',
      reason:
        shuttingDown && reason !== 'expired-offline' ? 'shutdown' : reason,
      endKnown,
      turns: s.turns,
      tasks: s.tasks,
      messagesDelivered: s.messagesDelivered,
      openai: s.openai,
      anthropic: s.anthropic,
      mcpAgent: s.mcpAgent,
      ...(endKnown ? { durationMs: Date.now() - s.startedAt } : {}),
    },
    snapshot ? { ...snapshot } : {},
  );
}
function cachedSnapshot(session: UsageSession): StorageSnapshot | undefined {
  if (!usageRuntime()?.enabled('storage')) return undefined;
  try {
    return storageSnapshots().cached(session);
  } catch {
    return undefined;
  }
}
/** Synchronous retention removals use only the cached snapshot. */
export function sessionReleased(
  session: UsageSession,
  reason: SessionCloseReason,
): void {
  const sessionKey = key(session);
  const s = live.get(sessionKey) ?? pending.get(sessionKey);
  if (!s || s.closed) return;
  s.closed = true;
  if (live.get(sessionKey) === s) live.delete(sessionKey);
  if (pending.get(sessionKey) === s) pending.delete(sessionKey);
  rememberClosed(sessionKey);
  emitClose(s, reason, cachedSnapshot(session));
  storageSnapshots().release?.(s.session);
}
/** Wait for delivery boundaries before the final snapshot; deduplicate each generation. */
export function sessionClosed(
  session: UsageSession,
  reason: SessionCloseReason,
  endKnown: boolean = true,
): Promise<void> {
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('session') && !runtime.enabled('storage')))
    return Promise.resolve();
  const sessionKey = key(session);
  const existing = pending.get(sessionKey);
  const current = live.get(sessionKey);
  if (existing && (!current || current === existing))
    return existing.closing ?? Promise.resolve();
  if (!current && tombstones.has(sessionKey)) return Promise.resolve();
  const s: LiveSession | undefined =
    current ??
    (reason === 'expired-offline'
      ? {
          closed: false,
          deliveries: new Set(),
          session,
          usage: runtime.forSession(session),
          startedAt: Date.now(),
          turns: 0,
          tasks: 0,
          messagesDelivered: 0,
          openai: 0,
          anthropic: 0,
          mcpAgent: 0,
        }
      : undefined);
  if (!s) return Promise.resolve();
  const closing = (async () => {
    await Promise.all([...s.deliveries]);
    if (s.closed) return;
    if (live.get(sessionKey) === s) live.delete(sessionKey);
    let snapshot: StorageSnapshot | undefined;
    try {
      if (runtime.enabled('storage'))
        snapshot = await storageSnapshots().measure(s.session);
    } catch {
      snapshot = cachedSnapshot(session);
    }
    if (s.closed) return;
    s.closed = true;
    if (!live.has(sessionKey) && pending.get(sessionKey) === s)
      rememberClosed(sessionKey);
    emitClose(s, reason, snapshot, endKnown);
    storageSnapshots().release?.(s.session);
  })().finally(() => {
    if (pending.get(sessionKey) === s) pending.delete(sessionKey);
    closingTasks.delete(closing);
    closingSessions.delete(s);
  });
  s.closing = closing;
  pending.set(sessionKey, s);
  closingSessions.add(s);
  closingTasks.add(closing);
  return closing;
}
export function sessionRequestAdmitted(
  session: UsageSession,
  protocol: Protocol,
): void {
  const s = live.get(key(session));
  if (!s) return;
  s.turns++;
  if (protocol === 'mcp-agent') {
    s.mcpAgent++;
    s.tasks++;
  } else s[protocol]++;
}
export function sessionMessageDelivered(session: UsageSession): void {
  const s = live.get(key(session));
  if (s) s.messagesDelivered++;
}
export function sessionDialogueCounts(
  session: UsageSession,
  turns: number,
  tasks: number,
): void {
  const s = live.get(key(session));
  if (s) {
    s.turns = turns;
    s.tasks = tasks;
  }
}
export async function closeUsageSessions(timeoutMs?: number): Promise<void> {
  if (!live.size && !closingTasks.size) return;
  const closing = Promise.all([
    ...closingTasks,
    ...[...live.values()].map((s: LiveSession) =>
      sessionClosed(s.session, 'shutdown'),
    ),
  ]).then(() => {});
  if (timeoutMs === undefined) await closing;
  else if (!(await withinUsageShutdownBudget(closing, timeoutMs))) {
    for (const s of new Set([...live.values(), ...closingSessions])) {
      if (s.closed) continue;
      s.closed = true;
      if (live.get(key(s.session)) === s) live.delete(key(s.session));
      if (pending.get(key(s.session)) === s) pending.delete(key(s.session));
      rememberClosed(key(s.session));
      emitClose(s, 'shutdown', cachedSnapshot(s.session));
      storageSnapshots().release?.(s.session);
    }
  }
}
export function resetUsageSessionsForTest(): void {
  live.clear();
  pending.clear();
  tombstones.clear();
  closingTasks.clear();
  closingSessions.clear();
  shuttingDown = false;
}
