import { dialogueId } from '../dialogue-store';
import type { UsageRuntime } from './runtime';
import { usageRuntime } from './runtime-state';
import { measureSession, measureUser } from './storage-meter';
import {
  type StorageSnapshot,
  type StorageSnapshots,
  setStorageSnapshots,
  storageSnapshots,
  type UsageSession,
  unknownStorageSnapshot,
} from './storage-snapshot';

interface Entry {
  session: UsageSession;
  revision: number;
  snapshot?: StorageSnapshot;
}
const sessionKey = (session: UsageSession): string =>
  JSON.stringify([session.userId, session.sessionId]);

/** Measurement deadlines release the lock and discard late results. */
export class StorageMeter implements StorageSnapshots {
  private readonly entries = new Map<string, Entry>();
  private running = false;
  private readonly waiters = new Set<() => void>();
  private unlock(): void {
    this.running = false;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  private async acquire(deadline: number): Promise<boolean> {
    while (this.running && !this.stopped) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve: () => void): void => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout((): void => {
          this.waiters.delete(wake);
          resolve();
        }, remaining);
        this.waiters.add(wake);
      });
    }
    if (this.stopped || Date.now() >= deadline) return false;
    this.running = true;
    return true;
  }
  private readonly users = new Set<string>();
  private cursor = 0;
  private controller?: AbortController;
  invalidateDialogue(id: string): void {
    if (!usageRuntime()?.enabled('storage')) return;
    for (const entry of this.entries.values()) {
      if (dialogueId(entry.session.userId, entry.session.sessionId) === id)
        this.update(entry.session, { stateBytes: 0, outboxBytes: 0 });
    }
  }
  trackUser(userId: string, eligible: boolean): void {
    if (!usageRuntime()?.enabled('storage') || this.stopped) return;
    this.users.delete(userId);
    if (eligible) this.users.add(userId);
    while (this.users.size > 1000) {
      const oldest = this.users.values().next();
      if (!oldest.done) this.users.delete(oldest.value);
    }
  }
  private ticking = false;
  private stopped = false;
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.unlock();
    this.entries.clear();
    this.users.clear();
  }
  constructor(private readonly timeoutMs: number = 10000) {}

  retain(session: UsageSession): void {
    this.entries.set(sessionKey(session), {
      session,
      revision: 0,
      snapshot: unknownStorageSnapshot(),
    });
  }
  release(session: UsageSession): void {
    if (this.entries.get(sessionKey(session))?.session === session)
      this.entries.delete(sessionKey(session));
  }
  update(
    session: UsageSession,
    values: Record<string, number | boolean>,
  ): void {
    const entry = this.entries.get(sessionKey(session));
    if (!entry) return;
    const snapshot = entry.snapshot ?? unknownStorageSnapshot();
    for (const [name, value] of Object.entries(values)) {
      snapshot[name] = value;
      if (name.endsWith('Unknown')) {
        if (value === true) delete snapshot[name.slice(0, -'Unknown'.length)];
      } else delete snapshot[`${name}Unknown`];
    }
    snapshot.storageSnapshotAt = Date.now();
    entry.snapshot = snapshot;
    entry.revision++;
  }
  cached(session: UsageSession): StorageSnapshot | undefined {
    return this.entries.get(sessionKey(session))?.snapshot;
  }
  async measure(session: UsageSession): Promise<StorageSnapshot | undefined> {
    return this.capture(session, true);
  }
  private fallback(session: UsageSession): StorageSnapshot {
    const cached = this.cached(session);
    if (cached) return cached;
    const snapshot = unknownStorageSnapshot();
    const entry = this.entries.get(sessionKey(session));
    if (entry && !this.stopped) entry.snapshot = snapshot;
    return snapshot;
  }
  private async capture(
    session: UsageSession,
    includeUser: boolean,
    budgetMs: number = this.timeoutMs,
  ): Promise<StorageSnapshot | undefined> {
    if (this.stopped || !usageRuntime()?.enabled('storage')) return undefined;
    const entry = this.entries.get(sessionKey(session));
    const revision = entry?.revision;
    const deadline = Date.now() + budgetMs;
    if (!(await this.acquire(deadline)))
      return this.stopped ? undefined : this.fallback(session);
    if (this.stopped || !usageRuntime()?.enabled('storage')) {
      this.unlock();
      return undefined;
    }
    budgetMs = Math.max(0, deadline - Date.now());
    const runtime = usageRuntime();
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    let userValues: Record<string, number | boolean> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async (): Promise<StorageSnapshot> => {
      const values = await measureSession(
        session.sessionId,
        session.userId,
        controller.signal,
      );
      if (
        includeUser &&
        !controller.signal.aborted &&
        !this.stopped &&
        usageRuntime() === runtime &&
        Date.now() - startedAt < budgetMs
      )
        userValues = await measureUser(session.userId, controller.signal);
      return { storageSnapshotAt: startedAt, ...values };
    })();
    try {
      const snapshot = await Promise.race([
        work,
        new Promise<undefined>((resolve: (value: undefined) => void): void => {
          timer = setTimeout((): void => {
            controller.abort();
            resolve(undefined);
          }, budgetMs);
          timer.unref();
        }),
      ]);
      if (
        snapshot &&
        !controller.signal.aborted &&
        !this.stopped &&
        usageRuntime() === runtime
      ) {
        if (
          entry &&
          entry.revision === revision &&
          this.entries.get(sessionKey(session)) === entry
        )
          entry.snapshot = snapshot;
        if (userValues)
          runtime
            ?.forSession({ userId: session.userId, sessionId: '' })
            .with({ sessionId: undefined })
            .record({
              context: {},
              kind: 'x.hub.storage.user',
              outcome: 'ok',
              values: userValues,
            });
      }
      return snapshot ?? this.fallback(session);
    } catch {
      return unknownStorageSnapshot();
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      this.controller = undefined;
      this.unlock();
    }
  }

  async tick(runtime: UsageRuntime): Promise<void> {
    if (
      this.stopped ||
      this.running ||
      this.ticking ||
      !runtime.enabled('storage')
    )
      return;
    this.ticking = true;
    try {
      await this.runTick(runtime);
    } finally {
      this.ticking = false;
    }
  }
  private async runTick(runtime: UsageRuntime): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const work: (Entry | string)[] = [];
    const sessions = [...this.entries.values()];
    const users = [...this.users];
    for (let i = 0; i < Math.max(sessions.length, users.length); i++) {
      const entry = sessions[i];
      const user = users[i];
      if (entry) work.push(entry);
      if (user !== undefined) work.push(user);
    }
    if (!work.length) return;
    this.cursor %= work.length;
    for (let count = 0; count < work.length; count++) {
      if (this.stopped || Date.now() >= deadline) return;
      const task = work[this.cursor];
      this.cursor = (this.cursor + 1) % work.length;
      const budget = Math.max(1, deadline - Date.now());
      if (typeof task !== 'string') {
        if (!task) continue;
        const snapshot = await this.capture(task.session, false, budget);
        if (snapshot && this.entries.get(sessionKey(task.session)) === task)
          runtime.forSession(task.session).record({
            context: {},
            kind: 'x.hub.storage',
            outcome: 'ok',
            values: { ...snapshot },
          });
        continue;
      }
      if (!(await this.acquire(deadline))) return;
      const controller = new AbortController();
      this.controller = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const values = await Promise.race([
          measureUser(task, controller.signal),
          new Promise<undefined>(
            (resolve: (value: undefined) => void): void => {
              timer = setTimeout(
                (): void => {
                  controller.abort();
                  resolve(undefined);
                },
                Math.max(0, deadline - Date.now()),
              );
              timer.unref();
            },
          ),
        ]);
        if (
          values &&
          !this.stopped &&
          usageRuntime() === runtime &&
          this.users.has(task)
        )
          runtime
            .forSession({ userId: task, sessionId: '' })
            .with({ sessionId: undefined })
            .record({
              context: {},
              kind: 'x.hub.storage.user',
              outcome: 'ok',
              values,
            });
      } catch {
        // Measurements must never break session work.
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
        this.controller = undefined;
        this.unlock();
      }
    }
  }
}

let meterRuntime: UsageRuntime | undefined;
let activeMeter: StorageMeter | undefined;
export function stopStorageMeter(runtime: UsageRuntime): void {
  if (meterRuntime !== runtime) return;
  activeMeter?.stop();
  if (storageSnapshots() === activeMeter) setStorageSnapshots();
  activeMeter = undefined;
  meterRuntime = undefined;
}

export function startStorageMeter(
  runtime: UsageRuntime,
  intervalMs: number,
): void {
  if (!runtime.enabled('storage')) return;
  if (meterRuntime === runtime) return;
  if (meterRuntime) stopStorageMeter(meterRuntime);
  const meter = new StorageMeter();
  meterRuntime = runtime;
  activeMeter = meter;
  setStorageSnapshots(meter);
  runtime.schedule(
    'storage',
    (): void => {
      void meter.tick(runtime).catch((): void => {});
    },
    intervalMs,
  );
}
