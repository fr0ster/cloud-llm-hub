import { inspect } from 'node:util';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import {
  buildConnectionForDestination,
  dumpScopeForConnection,
} from './background-connection';
import {
  type ExpositionLevel,
  type RoleBearer,
  resolveExpositionForUser,
} from './exposition';
import type { DumpScope } from './principal';
import { safeStop } from './request-connection';
import {
  type RequestSystem,
  resolveRequestSystem,
} from './request-system-context';

export interface ConnectionSnapshot {
  headers: Record<string, string>;
  userId: string;
  destination: string;
  exposition?: ExpositionLevel[];
}
export interface BackgroundConnection {
  connection: IAbapConnection;
  dumpScope: DumpScope | undefined;
  system: RequestSystem;
}
type Builder = (snapshot: ConnectionSnapshot) => Promise<BackgroundConnection>;
const allowedHeaders = [
  'authorization',
  'x-sap-login',
  'x-sap-password',
  'x-sap-client',
  'x-sap-destination',
  'x-sap-system-type',
  'x-sap-responsible',
  'x-sap-master-system',
] as const;
async function build(
  snapshot: ConnectionSnapshot,
): Promise<BackgroundConnection> {
  const req = { headers: snapshot.headers };
  const built = await buildConnectionForDestination(req, snapshot.destination);
  return {
    connection: built.connection,
    dumpScope: dumpScopeForConnection(built, snapshot.userId),
    system: resolveRequestSystem(req.headers),
  };
}
export class NoCredentialsError extends Error {
  constructor() {
    super("no SAP credentials yet; they arrive with the user's next message");
    this.name = 'NoCredentialsError';
  }
}
export class SessionConnectionFactory {
  #snapshot?: ConnectionSnapshot;
  #builder: Builder;
  #userId: string;
  #exposition: ExpositionLevel[] = [];
  constructor(
    userId: string,
    _key: string,
    options: { builder?: Builder } = {},
  ) {
    this.#userId = userId;
    this.#builder = options.builder ?? build;
  }
  refresh(
    req: {
      headers: Record<string, string | string[] | undefined>;
      user?: RoleBearer;
    },
    destination: string,
  ): void {
    const headers: Record<string, string> = {};
    for (const name of allowedHeaders) {
      const raw = req.headers[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value !== undefined) headers[name] = value;
    }
    this.#exposition = resolveExpositionForUser(req.user ?? cds.context?.user);
    this.#snapshot = {
      headers,
      userId: this.#userId,
      destination,
      exposition: [...this.#exposition],
    };
  }
  get exposition(): ExpositionLevel[] {
    return [...this.#exposition];
  }
  hasCredentials(): boolean {
    return this.#snapshot !== undefined;
  }
  async open(): Promise<BackgroundConnection> {
    if (!this.#snapshot) throw new NoCredentialsError();
    return this.#builder({
      ...this.#snapshot,
      headers: { ...this.#snapshot.headers },
      exposition: [...(this.#snapshot.exposition ?? [])],
    });
  }
  forget(): void {
    this.#snapshot = undefined;
    this.#exposition = [];
  }
  toJSON() {
    return { type: 'SessionConnectionFactory', redacted: true };
  }
  [inspect.custom]() {
    return this.toJSON();
  }
}
export interface ConnectionLease extends BackgroundConnection {
  release(healthy: boolean): Promise<void>;
}
interface Entry {
  value: BackgroundConnection;
  busy: boolean;
}
interface Waiter {
  resolve: (lease: ConnectionLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}
export class SessionConnectionPool {
  #entries = new Set<Entry>();
  #opening = new Set<Promise<void>>();
  #waiters: Waiter[] = [];
  #closed = false;
  #closing?: Promise<void>;
  constructor(
    private readonly factory: SessionConnectionFactory,
    private readonly max: number,
  ) {
    if (!Number.isInteger(max) || max < 1)
      throw new Error('max must be a positive integer');
  }
  acquire(signal?: AbortSignal): Promise<ConnectionLease> {
    if (this.#closed)
      return Promise.reject(new Error('Connection pool closed'));
    if (signal?.aborted)
      return Promise.reject(new Error('Connection acquisition aborted'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) {
            this.#waiters.splice(i, 1);
            reject(new Error('Connection acquisition aborted'));
          }
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.#waiters.push(waiter);
      this.#pump();
    });
  }
  #take(): Waiter | undefined {
    const w = this.#waiters.shift();
    if (w) w.signal?.removeEventListener('abort', w.abort);
    return w;
  }
  #lease(entry: Entry): ConnectionLease {
    entry.busy = true;
    let released = false;
    return {
      ...entry.value,
      release: async (healthy) => {
        if (released) return;
        released = true;
        if (this.#closed) return;
        if (!healthy) {
          await safeStop(entry.value.connection);
          this.#entries.delete(entry);
        } else entry.busy = false;
        this.#pump();
      },
    };
  }
  #pump(): void {
    if (this.#closed) return;
    while (this.#waiters.length) {
      const idle = [...this.#entries].find((e) => !e.busy);
      if (idle) {
        this.#take()?.resolve(this.#lease(idle));
        continue;
      }
      if (
        this.#entries.size + this.#opening.size >= this.max ||
        this.#opening.size >= this.#waiters.length
      )
        return;
      // Keep the waiter queued (including its abort listener) while opening.
      const pending = this.factory
        .open()
        .then(
          async (value) => {
            if (this.#closed) {
              await safeStop(value.connection);
              return;
            }
            this.#entries.add({ value, busy: false });
          },
          (error) => {
            this.#take()?.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          },
        )
        .finally(() => {
          this.#opening.delete(pending);
          this.#pump();
        });
      this.#opening.add(pending);
    }
  }
  closeAll(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.factory.forget();
    while (this.#waiters.length)
      this.#take()?.reject(new Error('Connection pool closed'));
    this.#closing = (async () => {
      await Promise.all(
        [...this.#entries].map((e) => safeStop(e.value.connection)),
      );
      await Promise.all([...this.#opening]);
      this.#entries.clear();
    })();
    return this.#closing;
  }
}
