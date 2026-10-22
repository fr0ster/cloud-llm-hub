import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import type { Request } from 'express';
import { resolveDestinationSapConfig } from '../connections/destinationResolver';
import {
  buildConnectionForDestination,
  dumpScopeForConnection,
  usesBackgroundBasicOverride,
} from './background-connection';
import {
  type ExpositionLevel,
  type RoleBearer,
  resolveExpositionForUser,
} from './exposition';
import type { CredentialBinding } from './long-session';
import type { DumpScope } from './principal';
import { bearerToken } from './principal';
import { readRequestCredential, safeStop } from './request-connection';
import {
  type RequestSystem,
  resolveRequestSystem,
} from './request-system-context';
import { compare } from './session-connection';
import { cachedSystemIdentity } from './system-identity-cache';

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
  #principal?: CredentialBinding;
  #environment = new Map<
    string,
    { systemType?: string; sapClient?: string; login?: string }
  >();
  #identity?: { responsible?: string; masterSystem?: string };
  #authenticationTypes = new Map<string, string | undefined>();
  async assertPrincipal(
    headers: Record<string, string | string[] | undefined>,
    destination = this.#snapshot?.destination,
  ): Promise<CredentialBinding> {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    // Like a held session binding, retain the resolved authentication mode.
    // Keep it per destination so a different destination resolves independently.
    let authenticationType = destination
      ? this.#authenticationTypes.get(destination)
      : undefined;
    if (destination && !this.#authenticationTypes.has(destination)) {
      const resolved = await resolveDestinationSapConfig(
        destination,
        bearerToken(normalized.authorization),
      );
      authenticationType = resolved.authenticationType;
      this.#environment.set(destination, {
        systemType: resolved.systemType,
        sapClient: resolved.sapConfig?.client,
        login: resolved.username,
      });
      this.#authenticationTypes.set(destination, authenticationType);
    }
    const principal = readRequestCredential(
      { headers: normalized } as Request,
      {
        userDependent: !usesBackgroundBasicOverride(
          authenticationType,
          normalized,
        ),
      },
    );
    if (
      principal.kind !== 'none' &&
      this.#principal &&
      ['missing', 'mismatch'].includes(compare(this.#principal, principal))
    )
      throw Object.assign(
        new Error(
          'The dialogue principal is fixed for the lifetime of the session',
        ),
        { code: 'DIALOGUE_PRINCIPAL_FIXED', statusCode: 409 },
      );
    return principal;
  }
  #snapshot?: ConnectionSnapshot;
  #fingerprint?: string;
  version = 0;
  private listeners = new Set<() => void>();
  onBindingChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private bind(fingerprint: string | undefined): void {
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    this.version++;
    for (const fn of this.listeners) fn();
  }
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
  async refresh(
    req: {
      headers: Record<string, string | string[] | undefined>;
      user?: RoleBearer;
    },
    destination: string,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of allowedHeaders) {
      const raw = req.headers[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value !== undefined) headers[name] = value;
    }
    const principal = await this.assertPrincipal(headers, destination);
    if (principal.kind === 'none') {
      this.forget();
      return;
    }
    this.#principal ??= principal;
    this.#exposition = resolveExpositionForUser(req.user ?? cds.context?.user);
    this.#snapshot = {
      headers,
      userId: this.#userId,
      destination,
      exposition: [...this.#exposition],
    };
    this.bind(
      createHash('sha256')
        .update(JSON.stringify([destination, headers]))
        .digest('hex'),
    );
  }
  get exposition(): ExpositionLevel[] {
    return [...this.#exposition];
  }
  /** Explicit allow-list: connection credentials must never reach the planner. */
  environment(destination: string): string[] {
    const headers = this.#snapshot?.headers ?? {};
    const known = this.#environment.get(destination);
    return [
      `System type: ${headers['x-sap-system-type'] || known?.systemType || 'onprem'}`,
      `SAP login: ${this.#identity?.responsible || this.#principal?.sapLogin || known?.login || 'unknown'}`,
      ...(headers['x-sap-client'] || known?.sapClient
        ? [`SAP client: ${headers['x-sap-client'] || known?.sapClient}`]
        : []),
      ...(headers['x-sap-master-system']
        ? [`SAP system id: ${headers['x-sap-master-system']}`]
        : []),
      ...(this.#identity?.masterSystem
        ? [`SAP system id: ${this.#identity.masterSystem}`]
        : []),
    ];
  }
  hasCredentials(): boolean {
    return this.#snapshot !== undefined;
  }
  async open(): Promise<BackgroundConnection> {
    if (!this.#snapshot) throw new NoCredentialsError();
    try {
      const built = await this.#builder({
        ...this.#snapshot,
        headers: { ...this.#snapshot.headers },
        exposition: [...(this.#snapshot.exposition ?? [])],
      });
      this.#identity = cachedSystemIdentity(built.connection) ?? undefined;
      return built;
    } catch (error) {
      if (error instanceof NoCredentialsError) throw error;
      const e = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        message?: unknown;
        response?: { status?: unknown };
      };
      const status = e?.status ?? e?.statusCode ?? e?.response?.status;
      const auth =
        status === 401 ||
        status === 403 ||
        /auth|unauthorized|forbidden|credential|logon/i.test(
          `${String(e?.code ?? '')} ${String(e?.message ?? '')}`,
        );
      // Allow-list diagnostic categories: connector-controlled strings can contain credentials.
      cds.log('background-connection').warn('SAP connection opening failed', {
        errorClass: error instanceof Error ? 'Error' : 'Unknown',
        status: typeof status === 'number' ? status : undefined,
        code: auth ? 'AUTH_REJECTED' : 'CONNECTION_FAILED',
      });
      throw new Error(
        auth
          ? 'SAP connection failed: authentication rejected'
          : 'SAP connection failed',
      );
    }
  }
  forget(): void {
    this.#snapshot = undefined;
    this.#identity = undefined;
    this.bind(undefined);
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
  version: number;
  release(healthy: boolean): Promise<void>;
}
interface Entry {
  value: BackgroundConnection;
  busy: boolean;
  version: number;
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
    factory.onBindingChange(() => this.retire());
  }
  retire(): void {
    for (const entry of this.#entries) {
      if (!entry.busy) {
        this.#entries.delete(entry);
        void safeStop(entry.value.connection);
      }
    }
    this.#pump();
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
      version: entry.version,
      release: async (healthy) => {
        if (released) return;
        released = true;
        if (this.#closed) return;
        if (!healthy || entry.version !== this.factory.version) {
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
      const version = this.factory.version;
      const pending = this.factory
        .open()
        .then(
          async (value) => {
            if (this.#closed || version !== this.factory.version) {
              await safeStop(value.connection);
              return;
            }
            this.#entries.add({ value, busy: false, version });
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
