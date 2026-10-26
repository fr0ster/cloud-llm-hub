/**
 * Long sessions: a hub session with a server-issued key that holds one ABAP
 * connection between requests. Idle TTL counts from the last activity.
 *
 * This is the in-memory core only. It owns the caps, the per-session FIFO
 * queue and the close protocol; what closing means (ABAP close, state and
 * record delete) is injected through `LongSessionHooks`. It runs no timers:
 * the owner calls `sweep()`.
 */
import { randomUUID } from 'node:crypto';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import type { DumpScope } from './principal';
import { type SessionConfig, sessionConfig } from './session-config';

export type CloseReason = 'explicit' | 'ttl' | 'shutdown';

export interface CredentialBinding {
  kind: 'basic' | 'jwt' | 'none';
  sapLogin?: string;
  sapClient?: string;
  jwtUser?: string;
  jwt?: string;
  /** The destination authenticates with the user JWT: SAP basic headers are ignored. */
  userDependent?: boolean;
}

export interface LongSession {
  readonly userId: string;
  readonly key: string;
  readonly createdAt: number;
  lastActivity: number;
  destination?: string;
  /** True when rebuilt from the store after a restart. */
  revived: boolean;
  connection?: IAbapConnection;
  dumpScope?: DumpScope;
  binding?: CredentialBinding;
}

export type OpenRefusal = { refused: 'SESSION_LIMIT' | 'SESSION_EXISTS' };
export type RunRefusal = { refused: 'SESSION_BUSY' | 'SESSION_CLOSED' };

export interface LongSessionHooks {
  onOpen?(s: LongSession): void;
  /** ABAP close, state delete, record delete. */
  onClose(s: LongSession, reason: CloseReason): Promise<void>;
  /** Record write (throttled by the store). */
  onTouch?(s: LongSession): void;
}

type RegistryConfig = Pick<
  SessionConfig,
  'ttlMs' | 'maxSessions' | 'maxPerUser' | 'queueLength'
>;

interface Entry {
  session: LongSession;
  /** Settles when the last accepted request has finished. */
  tail: Promise<void>;
  /** Requests running or waiting: one running plus up to `queueLength`. */
  active: number;
  holds: number;
  closing?: Promise<void>;
}

export function newSessionKey(): string {
  return `ls-${randomUUID()}`;
}

export class LongSessionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly cfg: RegistryConfig,
    private readonly hooks: LongSessionHooks,
    private readonly now: () => number = Date.now,
  ) {}

  /** Idle time after which a session is closed. */
  get ttlMs(): number {
    return this.cfg.ttlMs;
  }

  open(
    userId: string,
    init: {
      destination?: string;
      key?: string;
      createdAt?: number;
      revived?: boolean;
    },
  ): LongSession | OpenRefusal {
    // Live or still closing: never replace an entry.
    if (init.key !== undefined && this.entries.has(slot(userId, init.key))) {
      return { refused: 'SESSION_EXISTS' };
    }
    if (
      this.entries.size >= this.cfg.maxSessions ||
      this.size(userId) >= this.cfg.maxPerUser
    ) {
      return { refused: 'SESSION_LIMIT' };
    }
    const now = this.now();
    const session: LongSession = {
      userId,
      key: init.key ?? newSessionKey(),
      createdAt: init.createdAt ?? now,
      lastActivity: now,
      destination: init.destination,
      revived: init.revived ?? false,
    };
    this.entries.set(slot(userId, session.key), {
      session,
      tail: Promise.resolve(),
      active: 0,
      holds: 0,
    });
    this.hooks.onOpen?.(session);
    this.hooks.onTouch?.(session);
    return session;
  }

  /** Give this user's in-flight cleanup up to 15 seconds before admission. */
  async awaitUserCloses(userId: string): Promise<void> {
    const pending = [...this.entries.values()].flatMap((entry) =>
      entry.session.userId === userId && entry.closing ? [entry.closing] : [],
    );
    if (!pending.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** No touch. Undefined once `close` has started. */
  get(userId: string, key: string): LongSession | undefined {
    const entry = this.entries.get(slot(userId, key));
    return entry && !entry.closing ? entry.session : undefined;
  }

  has(userId: string, key: string): boolean {
    return this.get(userId, key) !== undefined;
  }

  /** FIFO per session; touches before and after. */
  async run<T>(
    s: LongSession,
    fn: () => Promise<T>,
    onQueued?: () => void,
  ): Promise<T | RunRefusal> {
    const entry = this.entries.get(slot(s.userId, s.key));
    if (!entry || entry.session !== s || entry.closing) {
      return { refused: 'SESSION_CLOSED' };
    }
    if (entry.active >= 1 + this.cfg.queueLength) {
      return { refused: 'SESSION_BUSY' };
    }
    if (entry.active > 0) onQueued?.();
    entry.active += 1;
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (entry.closing) return { refused: 'SESSION_CLOSED' };
      this.touch(s.userId, s.key);
      try {
        return await fn();
      } finally {
        this.touch(s.userId, s.key);
      }
    } finally {
      entry.active -= 1;
      release();
    }
  }

  /** Keep live background work from expiring; release starts a fresh idle TTL. */
  hold(s: LongSession): () => void {
    const entry = this.entries.get(slot(s.userId, s.key));
    if (!entry || entry.session !== s || entry.closing) return () => {};
    entry.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holds -= 1;
      // A stale release must never touch a replacement session with the same key.
      if (this.entries.get(slot(s.userId, s.key)) === entry)
        this.touch(s.userId, s.key);
    };
  }

  /** Waits for the running request. Idempotent. */
  close(userId: string, key: string, reason: CloseReason): Promise<void> {
    const id = slot(userId, key);
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.closing ??= this.finish(id, entry, reason);
    return entry.closing;
  }

  /** Closes sessions idle longer than the TTL. Returns how many. */
  async sweep(): Promise<number> {
    const now = this.now();
    const idle = [...this.entries.values()].filter(
      (e) =>
        !e.closing &&
        e.active === 0 &&
        e.holds === 0 &&
        now - e.session.lastActivity > this.cfg.ttlMs,
    );
    await this.closeEach(idle, 'ttl');
    return idle.length;
  }

  async closeAll(reason: CloseReason): Promise<void> {
    await this.closeEach([...this.entries.values()], reason);
  }

  /** Waits for every close; a failing one is logged, not thrown. */
  private async closeEach(
    entries: Entry[],
    reason: CloseReason,
  ): Promise<void> {
    const results = await Promise.allSettled(
      entries.map((e) => this.close(e.session.userId, e.session.key, reason)),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        cds
          .log('long-session')
          .warn(
            `closing session ${entries[i].session.key} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          );
      }
    });
  }

  /** Sessions held, closing ones included; of one user when given. */
  size(userId?: string): number {
    if (userId === undefined) return this.entries.size;
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.session.userId === userId) n += 1;
    }
    return n;
  }

  touch(userId: string, key: string): void {
    const s = this.get(userId, key);
    if (!s) return;
    s.lastActivity = this.now();
    this.hooks.onTouch?.(s);
  }

  private async finish(
    id: string,
    entry: Entry,
    reason: CloseReason,
  ): Promise<void> {
    try {
      await entry.tail;
      await this.hooks.onClose(entry.session, reason);
    } finally {
      this.entries.delete(id);
    }
  }
}

function slot(userId: string, key: string): string {
  return `${userId}\u0000${key}`;
}

let singleton: LongSessionRegistry | undefined;

/** Builds the process singleton from `sessionConfig()` and the given hooks. */
export function initLongSessions(hooks: LongSessionHooks): LongSessionRegistry {
  singleton = new LongSessionRegistry(sessionConfig(), hooks);
  return singleton;
}

export function longSessions(): LongSessionRegistry {
  if (!singleton) {
    throw new Error(
      'Long sessions are not initialised: call initLongSessions(hooks) first',
    );
  }
  return singleton;
}

/**
 * The registry, or undefined before `initLongSessions`: for callers that run
 * whether or not the server built one (retention, shutdown).
 */
export function longSessionsIfReady(): LongSessionRegistry | undefined {
  return singleton;
}

/** Test seam. */
export function setLongSessionsForTest(
  r: LongSessionRegistry | undefined,
): void {
  singleton = r;
}
