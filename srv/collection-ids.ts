// srv/collection-ids.ts
import { createHash } from 'node:crypto';

/** Deterministic, PII-free, URL/FS-safe key for a BTP user id. */
export function sanitizeUserKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/**
 * Normalize a logical id: lowercase, trim, strip to ^[a-z0-9][a-z0-9_-]*$.
 * Create-time (default): a reserved `__` is a hard error.
 * Legacy migration (allowLegacyFallback=true): a `__`-containing or empty/invalid
 * id falls back to `legacy-<shortHash(fallbackSeed ?? raw)>` instead of throwing.
 */
export function normalizeLogicalId(
  raw: string,
  fallbackSeed?: string,
  allowLegacyFallback = false,
): string {
  const lowered = (raw ?? '').toLowerCase().trim();
  if (lowered.includes('__')) {
    if (!allowLegacyFallback) {
      throw new Error(`logical id must not contain "__": ${raw}`);
    }
    return `legacy-${shortHash(fallbackSeed ?? raw ?? '')}`;
  }
  let id = lowered.replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    id = `legacy-${shortHash(fallbackSeed ?? raw ?? '')}`;
  }
  return id;
}

export function userCollectionId(logicalId: string, userId: string): string {
  return `${logicalId}__u_${sanitizeUserKey(userId)}`;
}

// Session key is scoped by BOTH user and session, so a non-globally-unique x-session-id
// from a different user can never collide on the same registry key.
export function sessionCollectionId(
  logicalId: string,
  userId: string,
  sessionId: string,
): string {
  return `${logicalId}__s_${sanitizeUserKey(`${userId}\u0000${sessionId}`)}`;
}

/** A physical id contains the reserved `__`; a bare logical name does not. */
export function isPhysicalId(id: string): boolean {
  return id.includes('__');
}

/** Minimal shape the resolvers need from the registry. */
export interface CollectionLookup {
  getCollection(id: string): {
    id: string;
    owner?: string;
    scope?: 'user' | 'session';
    sessionId?: string;
  } | null;
}

/**
 * Resolve a bare LOGICAL name to the caller's own physical id.
 * - read (forWrite=false): the caller's private if it exists, else undefined.
 * - write (forWrite=true): the caller's private (create-if-absent).
 * Never returns another user's collection. Rejects names containing `__`.
 */
export function resolveByName(
  reg: CollectionLookup,
  name: string,
  userId: string,
  sessionId: string | undefined,
  forWrite: boolean,
): string | undefined {
  // No anonymous-owned collections (spec non-goal): an unauthenticated caller has
  // no private namespace, so they can neither create nor reach one by name.
  if (!userId || userId === 'anonymous') return undefined;
  const logical = normalizeLogicalId(name); // throws on `__`
  // session shadows user: check the session collection first.
  const sp = sessionId
    ? sessionCollectionId(logical, userId, sessionId)
    : undefined;
  if (sp && reg.getCollection(sp)) return sp;
  const up = userCollectionId(logical, userId);
  if (reg.getCollection(up)) return up;
  if (forWrite) return sp ?? up; // default write: session if in a session, else user
  return undefined;
}

/**
 * Resolve a :id route param OR a chat rag_collections entry.
 * A physical id (contains `__`) is looked up exactly AND ownership-checked here
 * (`owner === userId`) — so the chat path, which has no canAccess, cannot reach
 * another user's store. A bare logical id goes through resolveByName.
 * Returns the physical id the caller may use, or undefined.
 */
export function resolveRouteId(
  reg: CollectionLookup,
  id: string,
  userId: string,
  sessionId: string | undefined,
  forWrite: boolean,
): string | undefined {
  if (isPhysicalId(id)) {
    const c = reg.getCollection(id);
    if (!c || c.owner !== userId) return undefined; // own-only; cross-user → undefined
    if (c.scope === 'session' && c.sessionId !== sessionId) return undefined; // other-session → undefined
    return id;
  }
  return resolveByName(reg, id, userId, sessionId, forWrite);
}
