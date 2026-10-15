import { createHash } from 'node:crypto';
import { getSystemInformation } from '@mcp-abap-adt/adt-clients/core';
import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import { userDependentAuthenticationTypes } from './destination-authentication';
import type { SystemType } from './system-type';

/** Endpoint fields are independent; request login fallbacks never enter the cache. */
export type SystemIdentity = {
  responsible?: string;
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
const sessions = new WeakMap<
  IAbapConnection,
  { session?: SessionKey; systemType: SystemType }
>();
const pending = new Map<string, Promise<SystemIdentity>>();

/** Hash credentials; decode JWT payloads only for expiry. Never retain tokens. */
export function systemIdentitySession(input: {
  sapConfig: SapConfig;
  destinationName?: string;
  authenticationType?: string;
  jwt?: string;
}): SessionKey | undefined {
  const { sapConfig, destinationName, authenticationType, jwt } = input;
  let systemUrl: string;
  try {
    const url = new URL(sapConfig.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // Preserve the base path: the SDK appends requests to it, so it can route
    // to a distinct system. Never retain URL credentials, query, or fragment.
    systemUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
  const configured = Number(process.env.SYSTEM_IDENTITY_CACHE_TTL_MS);
  let expiresAt =
    Date.now() +
    (configured > 0 && Number.isFinite(configured)
      ? configured
      : 8 * 60 * 60 * 1000);
  // Key by normalized URL, SAP client, destination route, and SAP credential:
  // JWT hash, uppercase basic login, or technical destination name; ambiguous -> no cache.
  let principal: string | undefined;
  let userToken: string | undefined;
  const login = sapConfig.username?.trim().toUpperCase();
  if (!destinationName) {
    if (sapConfig.authType === 'basic' && login) {
      principal = `basic:${login}`;
    } else if (sapConfig.authType === 'jwt') {
      userToken = sapConfig.jwtToken;
    } else {
      return undefined;
    }
  } else if (sapConfig.username || sapConfig.password) {
    // CloudSdkAbapConnection sends Basic only when BOTH credentials exist.
    if (sapConfig.authType !== 'basic' || !login || !sapConfig.password)
      return undefined;
    principal = `basic:${login}`;
  } else if (
    sapConfig.authType === 'jwt' &&
    userDependentAuthenticationTypes.has(authenticationType ?? '')
  ) {
    userToken = sapConfig.jwtToken;
    // The forwarded token must be the one supplied to the SDK destination fetch.
    if (jwt && jwt !== userToken) return undefined;
  } else if (
    (authenticationType === 'OAuth2ClientCredentials' &&
      sapConfig.authType === 'jwt') ||
    (authenticationType === 'BasicAuthentication' &&
      sapConfig.authType === 'basic')
  ) {
    principal = `dest:${destinationName}`;
  } else {
    return undefined;
  }
  if (principal === undefined) {
    if (!userToken) return undefined;
    principal = `jwt:${createHash('sha256').update(userToken).digest('hex')}`;
    try {
      const payload = JSON.parse(
        Buffer.from(userToken.split('.')[1], 'base64url').toString('utf8'),
      );
      if (
        typeof payload?.exp === 'number' &&
        Number.isFinite(payload.exp * 1000)
      )
        expiresAt = payload.exp * 1000;
    } catch {
      // Opaque or undecodable tokens use the configured TTL.
    }
  }
  return {
    key: JSON.stringify([
      systemUrl,
      sapConfig.client ?? '',
      destinationName ?? '',
      principal,
    ]),
    expiresAt,
  };
}

export function bindSystemIdentity(
  connection: IAbapConnection,
  input: Parameters<typeof systemIdentitySession>[0] & {
    systemType?: SystemType;
  },
): void {
  const session = systemIdentitySession(input);
  const systemType = input.systemType ?? 'onprem';
  // Keep differently declared kinds out of each other's cache and pending lookup.
  if (session) session.key = JSON.stringify([systemType, session.key]);
  sessions.set(connection, { session, systemType });
}

export function cachedSystemIdentity(
  connection: IAbapConnection,
): SystemIdentity | undefined {
  const session = sessions.get(connection)?.session;
  return session ? systemIdentityCache.get(session.key) : undefined;
}

export function isCloudSystemIdentity(connection: IAbapConnection): boolean {
  return sessions.get(connection)?.systemType === 'cloud';
}

/** Uses the already connected session. Transient failures remain retryable. */
export async function resolveSystemIdentity(
  connection: IAbapConnection,
  cloud = isCloudSystemIdentity(connection),
): Promise<SystemIdentity> {
  const session = sessions.get(connection)?.session;
  const cached = cachedSystemIdentity(connection);
  if (cached !== undefined) return cached;
  const existing = session && pending.get(session.key);
  if (existing) return existing;
  const lookup = async (): Promise<SystemIdentity> => {
    let value: SystemIdentity;
    try {
      const info = await getSystemInformation(connection);
      value =
        info?.userName || info?.systemID
          ? {
              ...(info.userName ? { responsible: info.userName } : {}),
              ...(info.systemID ? { masterSystem: info.systemID } : {}),
            }
          : cloud
            ? {}
            : null;
    } catch (error) {
      if (cloud) throw error;
      const err = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
      };
      const status = err.response?.status ?? err.statusCode ?? err.status;
      if (status !== 404 && status !== 405) {
        warnSystemIdentityFailure(error);
        return null;
      }
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

function warnSystemIdentityFailure(error: unknown): void {
  cds.log('system-identity').warn('System identity lookup failed', {
    error: error instanceof Error ? error.name : typeof error,
  });
}

/** Connect-time warmup must never prevent tools from running. */
export async function warmSystemIdentity(
  connection: IAbapConnection,
  systemType: SystemType,
): Promise<void> {
  try {
    await resolveSystemIdentity(connection, systemType === 'cloud');
  } catch (error) {
    warnSystemIdentityFailure(error);
  }
}
