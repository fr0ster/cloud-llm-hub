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

export type OpenRefusal = { refused: 'SESSION_LIMIT' };
export type RunRefusal = { refused: 'SESSION_BUSY' | 'SESSION_CLOSED' };

export interface LongSessionHooks {
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

  open(
    userId: string,
    init: {
      destination?: string;
      key?: string;
      createdAt?: number;
      revived?: boolean;
    },
  ): LongSession | OpenRefusal {
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
    });
    this.hooks.onTouch?.(session);
    return session;
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
  async run<T>(s: LongSession, fn: () => Promise<T>): Promise<T | RunRefusal> {
    const entry = this.entries.get(slot(s.userId, s.key));
    if (!entry || entry.session !== s || entry.closing) {
      return { refused: 'SESSION_CLOSED' };
    }
    if (entry.active >= 1 + this.cfg.queueLength) {
      return { refused: 'SESSION_BUSY' };
    }
    entry.active += 1;
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (entry.closing) return { refused: 'SESSION_CLOSED' };
      this.touch(s);
      try {
        return await fn();
      } finally {
        this.touch(s);
      }
    } finally {
      entry.active -= 1;
      release();
    }
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
        now - e.session.lastActivity > this.cfg.ttlMs,
    );
    await Promise.all(
      idle.map((e) => this.close(e.session.userId, e.session.key, 'ttl')),
    );
    return idle.length;
  }

  async closeAll(reason: CloseReason): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((e) =>
        this.close(e.session.userId, e.session.key, reason),
      ),
    );
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

  private touch(s: LongSession): void {
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
    } catch (err) {
      cds
        .log('long-session')
        .warn(
          `closing session ${entry.session.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

/** Test seam. */
export function setLongSessionsForTest(
  r: LongSessionRegistry | undefined,
): void {
  singleton = r;
}
