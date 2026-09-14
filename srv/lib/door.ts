/**
 * The door: how many sessions may be live at once, and the one queue in front.
 *
 * Pure. Retention is injected; there is no timer and no clock, because nothing
 * here waits for a duration — only for a slot, a session or a place.
 */

import { isRefusal, type Lease, type LeaseRefusal } from './session-retention';
import type { DoorRefusalReason } from './throttle-surfacing';

export interface DoorRetention {
  canReserve(userId: string, sessionId: string): boolean;
  lease(
    userId: string,
    sessionId: string,
    kind: 'pipeline',
  ): Lease | LeaseRefusal;
  /** A presented session closed or removed since the middleware accepted it. */
  isGone(userId: string, sessionId: string): boolean;
}

export interface Admission {
  readonly userId: string;
  readonly sessionId: string;
  /** Aborted by shutdown, and by nothing else. */
  readonly signal: AbortSignal;
  readonly outstanding: number;
  /** Register a dispatched call before awaiting it. */
  track<T>(p: Promise<T>): Promise<T>;
  /** Resolves when every tracked call has settled. */
  drain(): Promise<void>;
  /** Give back the retention lease and the slot. Last in teardown. Idempotent. */
  release(): void;
}

/**
 * `closed` is not a fourth refusal reason: a session removed under a request says
 * nothing about how full the service is, and is not counted as a refusal.
 */
export type AdmitResult =
  | { admitted: Admission }
  | { refused: DoorRefusalReason }
  | { closed: true };

export interface DoorSnapshot {
  live: number;
  capacity: number;
  queued: number;
  queueLength: number;
  highWater: number;
  refusals: Record<DoorRefusalReason, number>;
  left: number;
}

interface Waiter {
  userId: string;
  sessionId: string;
  presented: boolean;
  key: string;
  resolve: (r: AdmitResult) => void;
  reject: (e: unknown) => void;
  detach: () => void;
}

function keyOf(userId: string, sessionId: string): string {
  // A tuple, not a join: no separator keeps ("a", "b c") and ("a b", "c") apart
  // whatever a caller puts in a cookie.
  return JSON.stringify([userId, sessionId]);
}

export class Door {
  private readonly live = new Map<
    string,
    Admission & { abort(reason: unknown): void }
  >();
  private readonly waiters: Waiter[] = [];
  private readonly refusals: Record<DoorRefusalReason, number> = {
    session_busy: 0,
    capacity: 0,
    retention: 0,
  };
  private highWater = 0;
  private left = 0;
  private readonly capacity: number;
  private readonly queueLength: number;
  private readonly retention: DoorRetention;
  private readonly onPressure?: (depth: number, queueLength: number) => void;

  constructor(opts: {
    capacity: number;
    queueLength: number;
    retention: DoorRetention;
    onPressure?: (depth: number, queueLength: number) => void;
  }) {
    this.capacity = opts.capacity;
    this.queueLength = opts.queueLength;
    this.retention = opts.retention;
    this.onPressure = opts.onPressure;
  }

  admit(
    userId: string,
    sessionId: string,
    signal?: AbortSignal,
    opts: { presented?: boolean } = {},
  ): Promise<AdmitResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (opts.presented && this.retention.isGone(userId, sessionId)) {
      return Promise.resolve({ closed: true });
    }
    if (this.eligible(userId, sessionId)) {
      const admission = this.take(userId, sessionId);
      if (admission) return Promise.resolve({ admitted: admission });
    }
    if (this.waiters.length >= this.queueLength) {
      const reason = this.reasonFor(userId, sessionId);
      this.refusals[reason]++;
      return Promise.resolve({ refused: reason });
    }
    return new Promise<AdmitResult>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        this.left++;
        reject(signal?.reason);
        this.dispatch();
      };
      const waiter: Waiter = {
        userId,
        sessionId,
        presented: !!opts.presented,
        key: keyOf(userId, sessionId),
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const before = this.waiters.length;
      this.waiters.push(waiter);
      this.noteDepth(before);
    });
  }

  poke(): void {
    this.dispatch();
  }

  abortAll(reason: unknown = new Error('shutdown')): void {
    for (const w of this.waiters.splice(0)) {
      w.detach();
      w.reject(reason);
    }
    for (const a of this.live.values()) a.abort(reason);
  }

  snapshot(): DoorSnapshot {
    return {
      live: this.live.size,
      capacity: this.capacity,
      queued: this.waiters.length,
      queueLength: this.queueLength,
      highWater: this.highWater,
      refusals: { ...this.refusals },
      left: this.left,
    };
  }

  private eligible(userId: string, sessionId: string): boolean {
    return (
      !this.live.has(keyOf(userId, sessionId)) &&
      this.live.size < this.capacity &&
      this.retention.canReserve(userId, sessionId)
    );
  }

  /** In the order admission checks, so the caller hears what it can act on first. */
  private reasonFor(userId: string, sessionId: string): DoorRefusalReason {
    if (this.live.has(keyOf(userId, sessionId))) return 'session_busy';
    if (this.live.size >= this.capacity) return 'capacity';
    return 'retention';
  }

  private noteDepth(before: number): void {
    const depth = this.waiters.length;
    if (depth > this.highWater) this.highWater = depth;
    const mark = (this.queueLength * 3) / 4;
    if (before < mark && depth >= mark)
      this.onPressure?.(depth, this.queueLength);
  }

  /** Slot and place together, in this synchronous step, or neither. */
  private take(userId: string, sessionId: string): Admission | undefined {
    const lease = this.retention.lease(userId, sessionId, 'pipeline');
    if (isRefusal(lease)) return undefined;
    const key = keyOf(userId, sessionId);
    const controller = new AbortController();
    const register = new Set<Promise<unknown>>();
    let drainers: Array<() => void> = [];
    let released = false;
    const settleOne = (p: Promise<unknown>) => {
      register.delete(p);
      if (register.size === 0) {
        const waiting = drainers;
        drainers = [];
        for (const d of waiting) d();
      }
    };
    const admission = {
      userId,
      sessionId,
      signal: controller.signal,
      get outstanding() {
        return register.size;
      },
      track: <T>(p: Promise<T>): Promise<T> => {
        register.add(p);
        p.then(
          () => settleOne(p),
          () => settleOne(p),
        );
        return p;
      },
      drain: () =>
        register.size === 0
          ? Promise.resolve()
          : new Promise<void>((r) => {
              drainers.push(r);
            }),
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        this.live.delete(key);
        this.dispatch();
      },
      abort: (reason: unknown) => controller.abort(reason),
    };
    this.live.set(key, admission);
    return admission;
  }

  /** Admit the oldest eligible waiter, repeatedly, until none is eligible. */
  private dispatch(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      if (w.presented && this.retention.isGone(w.userId, w.sessionId)) {
        // Closed while it waited: answered, never admitted under a removed id.
        this.waiters.splice(i, 1);
        w.detach();
        w.resolve({ closed: true });
        continue;
      }
      if (!this.eligible(w.userId, w.sessionId)) {
        i++;
        continue;
      }
      const admission = this.take(w.userId, w.sessionId);
      if (!admission) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      w.detach();
      w.resolve({ admitted: admission });
      i = 0;
    }
  }
}
