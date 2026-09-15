import {
  forgetSessionDestination,
  getCollectionRegistry,
} from '../agent-manager';
import { clearSession, hasSessionHistory } from '../session-store';

/**
 * Every store keyed by one session, in one place.
 *
 * Logout, clear-chat and eviction each used to remember their own list, and
 * each remembered a different one: the history and the collections were
 * cleared, the destination never was, and a map nothing wrote was cleared on
 * every path. A bound that dropped only the history would be theatre — the
 * documents are where most of the memory is.
 *
 * Synchronous on purpose. Retention calls it inside the same turn of the event
 * loop in which it decided the session could go (Task 5), so nothing can take a
 * lease between the decision and the deletion.
 */
export function deleteSessionState(userId: string, sessionId: string): void {
  clearSession(sessionId, userId);
  forgetSessionDestination(userId, sessionId);
  getCollectionRegistry().deleteSessionCollections(userId, sessionId);
}

/**
 * Whether this session still holds memory worth bounding: turns, or session
 * collections. The destination name is deliberately not counted — a few bytes
 * that would keep a session retained after everything else had gone.
 */
export function hasSessionState(userId: string, sessionId: string): boolean {
  return (
    hasSessionHistory(sessionId, userId) ||
    getCollectionRegistry().hasSessionCollections(userId, sessionId)
  );
}

/**
 * The sessions whose collections are on disk, as the registry loaded them: what
 * retention must count after a restart before anything is admitted.
 */
export function persistedSessions(): Array<{
  userId: string;
  sessionId: string;
  lastUsed: number;
}> {
  return getCollectionRegistry().sessionOwners();
}

/**
 * Why this session's state cannot be removed right now, or undefined when it
 * can. History and the destination live in memory and always can; the session
 * collections need writable directories.
 */
export function sessionStateRemovable(
  userId: string,
  sessionId: string,
): string | undefined {
  return getCollectionRegistry().sessionCollectionsRemovable(userId, sessionId);
}
