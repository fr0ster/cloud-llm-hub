/**
 * Retention: how many sessions may hold state, and the rules for letting one go.
 *
 * Pure. The stores are injected, there is no timer, and the clock is a
 * parameter, so every rule here is tested without the service around it.
 */

export interface RetentionStores {
  /** Whether anything is still held for this session. */
  hasState(userId: string, sessionId: string): boolean;
  /**
   * Remove everything held for this session. Must be synchronous, and should
   * not throw. If it does, retention reports it instead of throwing from lease
   * or release, and the session is closed all the same.
   */
  deleteAll(userId: string, sessionId: string): void;
  /**
   * deleteAll threw. Retention calls this instead of throwing to the caller.
   */
  reportDeleteError?(userId: string, sessionId: string, error: unknown): void;
}

/**
 * `pipeline` — an admitted session's run. Never cancelled: its writes land in
 * SAP, which a deletion here does not remove.
 *
 * `rag` — a RAG operation. Cancelled by a deletion: its writes land only in the
 * state being removed.
 */
export type LeaseKind = 'pipeline' | 'rag';

export interface Lease {
  readonly kind: LeaseKind;
  /** Aborted when a deletion cancels this lease. Never aborted for a pipeline. */
  readonly signal: AbortSignal;
  /** Settle the lease. Idempotent. */
  release(): void;
}

export type LeaseRefusal = { refused: 'closed' | 'retention' };

export function isRefusal(x: Lease | LeaseRefusal): x is LeaseRefusal {
  return 'refused' in x;
}

export interface RetentionSnapshot {
  retained: number;
  cap: number | undefined;
  evictions: number;
  /** Closed to new leases, cleanup not yet run. Normally zero for longer than an upload. */
  closing: number;
  /** Removals that threw, since start; those sessions were closed all the same. */
  cleanupFailed: number;
}

interface Entry {
  userId: string;
  sessionId: string;
  lastUsed: number;
  /**
   * Whether any lease on it was taken for a session the caller presented. A
   * client that keeps no cookie is minted a session per request, none of which
   * anybody will name again; eviction takes those before a session somebody
   * came back to.
   */
  presented: boolean;
  leases: Set<Lease>;
  closing?: {
    settled: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
}

function keyOf(userId: string, sessionId: string): string {
  // A tuple, not a join: no separator keeps ("a", "b c") and ("a b", "c") apart
  // whatever a caller puts in a cookie.
  return JSON.stringify([userId, sessionId]);
}

function pendingClose(): NonNullable<Entry['closing']> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<void>((r, rej) => {
    resolve = r;
    reject = rej;
  });
  // A removal nobody awaits — an eviction, say — must not surface as an
  // unhandled rejection; whoever does await it still sees the failure.
  settled.catch(() => {});
  return { settled, resolve, reject };
}

export class SessionRetention {
  private readonly entries = new Map<string, Entry>();
  private evictions = 0;
  private cleanupFailures = 0;

  constructor(
    private readonly stores: RetentionStores,
    private readonly cap?: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a place could be had for this session now, without taking it. */
  canReserve(
    userId: string,
    sessionId: string,
    opts: { presented?: boolean } = {},
  ): boolean {
    if (opts.presented && this.isGone(userId, sessionId)) return false;
    const e = this.entries.get(keyOf(userId, sessionId));
    if (e) return !e.closing;
    if (this.cap === undefined || this.entries.size < this.cap) return true;
    return this.evictionCandidate() !== undefined;
  }

  /**
   * A place and a lease on it, together.
   *
   * Evicts the least recently used idle session when the cap is full. Refuses
   * when the session is closing, when a session the request presented has been
   * removed since, or when every place is held by something working.
   */
  lease(
    userId: string,
    sessionId: string,
    kind: LeaseKind,
    opts: { presented?: boolean } = {},
  ): Lease | LeaseRefusal {
    const key = keyOf(userId, sessionId);
    let e = this.entries.get(key);
    if (e?.closing || (opts.presented && this.isGone(userId, sessionId))) {
      return { refused: 'closed' };
    }
    if (!e) {
      while (this.cap !== undefined && this.entries.size >= this.cap) {
        const victim = this.evictionCandidate();
        if (!victim) return { refused: 'retention' };
        this.evict(victim);
      }
      e = {
        userId,
        sessionId,
        lastUsed: this.now(),
        presented: false,
        leases: new Set(),
      };
      this.entries.set(key, e);
    }
    e.lastUsed = this.now();
    if (opts.presented) e.presented = true;

    const controller = new AbortController();
    const entry = e;
    let released = false;
    const lease: Lease & { cancel(): void } = {
      kind,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.settle(entry, lease);
      },
      cancel: () => {
        if (kind === 'rag') controller.abort(new Error('session closed'));
      },
    };
    e.leases.add(lease);
    return lease;
  }

  /**
   * Delete a session: close it to new leases now, cancel its RAG leases, wait
   * for every lease to settle, then remove it once.
   *
   * Resolves when the removal has run. A caller answering a user does not wait
   * for it — the user is answered at the mark.
   */
  close(userId: string, sessionId: string): Promise<void> {
    const key = keyOf(userId, sessionId);
    const e = this.entries.get(key);
    if (!e) {
      try {
        this.stores.deleteAll(userId, sessionId);
      } catch (error) {
        this.cleanupFailures++;
        this.stores.reportDeleteError?.(userId, sessionId, error);
        return Promise.reject(error);
      }
      return Promise.resolve();
    }
    if (e.closing) return e.closing.settled;
    return this.startClose(e);
  }

  private startClose(e: Entry): Promise<void> {
    e.closing = pendingClose();
    const settled = e.closing.settled;
    for (const l of e.leases) (l as Lease & { cancel(): void }).cancel();
    if (e.leases.size === 0) this.finishClose(e);
    return settled;
  }

  /** Known, and not closing. */
  isKnown(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    return !!e && !e.closing;
  }

  isClosing(userId: string, sessionId: string): boolean {
    return !!this.entries.get(keyOf(userId, sessionId))?.closing;
  }

  /** Whether a lease of this kind is live on the session. */
  hasLease(userId: string, sessionId: string, kind: LeaseKind): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    if (!e) return false;
    for (const l of e.leases) if (l.kind === kind) return true;
    return false;
  }

  /**
   * Whether a session a request presented has been closed or removed since.
   *
   * Presented means the middleware kept the caller's cookie because the session
   * was live then. If retention no longer knows it and no store holds anything
   * for it, it was deleted in between — and creating it again would bring back,
   * under the same id, what the caller asked us to destroy. The mark alone does
   * not cover this: it lives only until the removal has run. A session minted
   * for this request is never asked; it holds nothing yet by definition.
   */
  isGone(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    if (e) return !!e.closing;
    return !this.stores.hasState(userId, sessionId);
  }

  /**
   * Whether the TTL sweep may remove this session's expired collections.
   *
   * The sweep asks and removes in the same synchronous pass, so no lease can be
   * taken between the answer and the removal — which is what the closing mark
   * guarantees on every other path.
   */
  maySweep(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    return !e || (e.leases.size === 0 && !e.closing);
  }

  /** Drop entries with no lease and nothing held. Returns how many went. */
  forgetEmpty(): number {
    let n = 0;
    for (const [key, e] of [...this.entries]) {
      if (
        e.leases.size === 0 &&
        !e.closing &&
        !this.stores.hasState(e.userId, e.sessionId)
      ) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  snapshot(): RetentionSnapshot {
    let closing = 0;
    for (const e of this.entries.values()) if (e.closing) closing++;
    return {
      retained: this.entries.size,
      cap: this.cap,
      evictions: this.evictions,
      closing,
      cleanupFailed: this.cleanupFailures,
    };
  }

  /**
   * An idle session nobody ever presented, least recently used first; only
   * when there is none, the least recently used idle one somebody did.
   */
  private evictionCandidate(): Entry | undefined {
    let neverPresented: Entry | undefined;
    let presented: Entry | undefined;
    for (const e of this.entries.values()) {
      if (e.leases.size > 0 || e.closing) continue;
      if (e.presented) {
        if (!presented || e.lastUsed < presented.lastUsed) presented = e;
      } else if (!neverPresented || e.lastUsed < neverPresented.lastUsed) {
        neverPresented = e;
      }
    }
    return neverPresented ?? presented;
  }

  /** An idle session has no lease, so closing it removes it in this same turn. */
  private evict(e: Entry): void {
    this.evictions++;
    // A failure is reported through reportDeleteError and must not fail the
    // lease or become unhandled.
    this.startClose(e).catch(() => {});
  }

  private settle(e: Entry, lease: Lease): void {
    e.leases.delete(lease);
    e.lastUsed = this.now();
    if (e.leases.size > 0) return;
    if (e.closing) {
      this.finishClose(e);
      return;
    }
    if (!this.stores.hasState(e.userId, e.sessionId)) {
      this.entries.delete(keyOf(e.userId, e.sessionId));
    }
  }

  private finishClose(e: Entry): void {
    const current = e.closing;
    try {
      this.stores.deleteAll(e.userId, e.sessionId);
    } catch (error) {
      // Reported and counted; the session is closed all the same — nothing is
      // kept or retried (issue #234).
      this.cleanupFailures++;
      this.stores.reportDeleteError?.(e.userId, e.sessionId, error);
      this.entries.delete(keyOf(e.userId, e.sessionId));
      current?.reject(error);
      return;
    }
    this.entries.delete(keyOf(e.userId, e.sessionId));
    current?.resolve();
  }
}
