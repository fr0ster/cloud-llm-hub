/**
 * Principal identity hashing and system-scope resolution.
 *
 * `principalHash` derives a stable, non-reversible identifier for a caller from
 * a canonical tuple of identity components (never from raw string concatenation,
 * which is vulnerable to boundary collisions). `resolveSystemScope` combines a
 * request-supplied client override with the destination's resolved default.
 * `resolvePrincipal` fails closed: it refuses to mint a hash for an
 * unauthenticated or anonymous caller.
 */

import { createHash } from 'node:crypto';

export interface PrincipalHashInput {
  cdsUserId: string;
  authMode: string;
  resolvedSapIdentity?: string | null;
  jwtSub?: string | null;
}

export interface ResolvedSystemDefault {
  destinationName: string;
  client?: string;
}

export interface SystemScope {
  resolvedDestination: string;
  effectiveClient: string;
}

export interface PrincipalContext {
  cdsUserId: string | undefined;
  authMode: string;
  resolvedSapIdentity?: string | null;
  jwtSub?: string | null;
}

export interface ResolvedPrincipal {
  principalHash: string;
}

/**
 * Hash a caller's identity as a canonical JSON-array tuple. Each component is
 * applied the same way on every path (value-or-`null`), so an omitted field
 * and an explicit `null` produce the same hash.
 */
export function principalHash(input: PrincipalHashInput): string {
  const tuple = [
    input.cdsUserId,
    input.authMode,
    input.resolvedSapIdentity ?? null,
    input.jwtSub ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

/**
 * Resolve the effective destination + client for a request: a header-supplied
 * client override wins when present, otherwise the resolved default is used.
 * Both paths collapse into a single trimmed `effectiveClient` value.
 */
export function resolveSystemScope(
  rawClient: string | undefined,
  resolved: ResolvedSystemDefault,
): SystemScope {
  return {
    resolvedDestination: resolved.destinationName,
    effectiveClient: (rawClient?.trim() || resolved.client || '').trim(),
  };
}

/**
 * Resolve a principal for the current request. Fails closed: returns `null`
 * when there is no authenticated CDS user or the user is the anonymous
 * placeholder, rather than minting a hash for an unidentified caller.
 */
export function resolvePrincipal(
  ctx: PrincipalContext,
): ResolvedPrincipal | null {
  if (!ctx.cdsUserId || ctx.cdsUserId === 'anonymous') {
    return null;
  }
  return {
    principalHash: principalHash({
      cdsUserId: ctx.cdsUserId,
      authMode: ctx.authMode,
      resolvedSapIdentity: ctx.resolvedSapIdentity,
      jwtSub: ctx.jwtSub,
    }),
  };
}

/**
 * The EFFECTIVE SAP identity that actually authenticated the connection — the
 * basis for the buffer-key principal, so it must reflect the real access path,
 * not an unused caller header. The basic-auth override only takes effect when a
 * login AND a password are BOTH supplied (`usedBasicOverride`). A login WITHOUT
 * a password does NOT authenticate as that login — the connection uses the
 * destination's own auth, so the identity is the destination's resolved user
 * (or null under principal propagation), never the stray login header.
 */
export function effectiveSapIdentity(input: {
  usedBasicOverride: boolean;
  sapLogin?: string;
  destinationAuthType: string;
  resolvedUsername?: string | null;
}): { authMode: string; resolvedSapIdentity: string | null } {
  return input.usedBasicOverride
    ? { authMode: 'basic', resolvedSapIdentity: input.sapLogin ?? null }
    : {
        authMode: input.destinationAuthType,
        resolvedSapIdentity: input.resolvedUsername ?? null,
      };
}

/** The principal + system scope carried in the ALS store for GetDumpSection. */
export interface DumpScope {
  principalHash: string;
  resolvedDestination: string;
  effectiveClient: string;
}

/**
 * Full dump-scope for a request — the single source of truth used by BOTH the
 * planner (`execute_step`) and the chat (`/v1/*`) paths, so GetDumpSection has a
 * principal wherever it can be RAG-selected. Returns `undefined` (fail closed)
 * when there is no stable principal (missing/anonymous CDS user).
 */
export function computeDumpScope(input: {
  cdsUserId: string;
  usedBasicOverride: boolean;
  sapLogin?: string;
  destinationAuthType: string;
  resolvedUsername?: string | null;
  destinationName: string;
  rawClient?: string;
  resolvedClient?: string;
  jwtSub?: string | null;
}): DumpScope | undefined {
  const { authMode, resolvedSapIdentity } = effectiveSapIdentity({
    usedBasicOverride: input.usedBasicOverride,
    sapLogin: input.sapLogin,
    destinationAuthType: input.destinationAuthType,
    resolvedUsername: input.resolvedUsername,
  });
  const principal = resolvePrincipal({
    cdsUserId: input.cdsUserId,
    authMode,
    resolvedSapIdentity,
    jwtSub: input.jwtSub ?? null,
  });
  if (!principal) return undefined;
  const scope = resolveSystemScope(input.rawClient, {
    destinationName: input.destinationName,
    client: input.resolvedClient,
  });
  return {
    principalHash: principal.principalHash,
    resolvedDestination: scope.resolvedDestination,
    effectiveClient: scope.effectiveClient,
  };
}
