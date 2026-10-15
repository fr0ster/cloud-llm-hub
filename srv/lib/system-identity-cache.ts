import { getSystemInformation } from '@mcp-abap-adt/adt-clients/core';
import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import type { AuthenticationType } from '@sap-cloud-sdk/connectivity';

export type SystemIdentity = {
  responsible: string;
  masterSystem?: string;
} | null;
interface SessionKey {
  key: string;
  expiresAt: number;
}

/** Process-local LRU; null means the endpoint has no usable identity. */
export class SystemIdentityCache {
  private readonly entries = new Map<
    string,
    { value: SystemIdentity; expiresAt: number }
  >();
  constructor(private readonly maxEntries = 1000) {}
  get(key: string): SystemIdentity | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: SystemIdentity, expiresAt: number): void {
    this.entries.delete(key);
    if (expiresAt <= Date.now()) return;
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export const systemIdentityCache = new SystemIdentityCache();
const sessions = new WeakMap<IAbapConnection, SessionKey>();
const pending = new Map<string, Promise<SystemIdentity>>();

// User exchange flows in the Cloud SDK, plus principal propagation.
const userDependentAuthenticationTypes: ReadonlySet<AuthenticationType> =
  new Set([
    'PrincipalPropagation',
    'SAMLAssertion',
    'OAuth2SAMLBearerAssertion',
    'OAuth2UserTokenExchange',
    'OAuth2JWTBearer',
  ]);

/** Decode only: the platform has already authenticated the token. Never retain it. */
export function systemIdentitySession(input: {
  sapConfig: SapConfig;
  destinationName?: string;
  authenticationType?: string;
  jwt?: string;
}): SessionKey | undefined {
  const { sapConfig, destinationName, authenticationType, jwt } = input;
  const configured = Number(process.env.SYSTEM_IDENTITY_CACHE_TTL_MS);
  let expiresAt =
    Date.now() +
    (configured > 0 && Number.isFinite(configured)
      ? configured
      : 8 * 60 * 60 * 1000);
  let principal: unknown = 'destination-auth';
  if (sapConfig.authType === 'basic') {
    principal = ['basic', sapConfig.username?.trim().toUpperCase()];
  } else if (
    userDependentAuthenticationTypes.has(
      authenticationType as AuthenticationType,
    ) ||
    !destinationName
  ) {
    try {
      const claims = JSON.parse(
        Buffer.from(
          (jwt ?? sapConfig.jwtToken ?? '').split('.')[1],
          'base64url',
        ).toString('utf8'),
      );
      const user = claims.user_uuid || claims.user_name || claims.sub;
      if (typeof user !== 'string' || !user || !Number.isFinite(claims.exp))
        return undefined;
      principal = ['jwt', user, claims.zid ?? '', claims.origin ?? ''];
      expiresAt = claims.exp * 1000;
    } catch {
      return undefined;
    }
  }
  return {
    key: JSON.stringify([
      destinationName || sapConfig.url,
      sapConfig.client ?? '',
      principal,
    ]),
    expiresAt,
  };
}

export function bindSystemIdentity(
  connection: IAbapConnection,
  input: Parameters<typeof systemIdentitySession>[0],
): void {
  const session = systemIdentitySession(input);
  if (session) sessions.set(connection, session);
}

export function cachedSystemIdentity(
  connection: IAbapConnection,
): SystemIdentity | undefined {
  const session = sessions.get(connection);
  return session ? systemIdentityCache.get(session.key) : undefined;
}

/** Uses the already connected session. Transient failures remain retryable. */
export async function resolveSystemIdentity(
  connection: IAbapConnection,
  cloud = false,
): Promise<SystemIdentity> {
  const session = sessions.get(connection);
  const cached = cachedSystemIdentity(connection);
  if (cached !== undefined) return cached;
  const existing = session && pending.get(session.key);
  if (existing) return existing;
  const lookup = async (): Promise<SystemIdentity> => {
    let value: SystemIdentity;
    try {
      const info = await getSystemInformation(connection);
      value = info?.userName
        ? { responsible: info.userName, masterSystem: info.systemID }
        : null;
    } catch (error) {
      if (cloud) throw error;
      const err = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
      };
      const status = err.response?.status ?? err.statusCode ?? err.status;
      if (status !== 404 && status !== 405) return null;
      value = null;
    }
    if (session) systemIdentityCache.set(session.key, value, session.expiresAt);
    return value;
  };
  const result = lookup();
  if (session) pending.set(session.key, result);
  try {
    return await result;
  } finally {
    if (session) pending.delete(session.key);
  }
}

/** Connect-time warmup must never prevent tools from running. */
export async function warmSystemIdentity(
  connection: IAbapConnection,
): Promise<void> {
  try {
    // Propagate every lookup error here so none is cached and all are logged.
    await resolveSystemIdentity(connection, true);
  } catch (error) {
    cds.log('system-identity').warn('System identity lookup failed', {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
