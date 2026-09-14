/**
 * Server-side session history.
 *
 * Moved out of `srv/openai-handler.ts`: the gatekeeper (Task 6) imports
 * `session-state`, and the chat handler (Task 11) imports the gatekeeper. With
 * the store inside `openai-handler`, `session-state` would import the handler
 * that imports it back. The store has nothing to do with HTTP, so it lives
 * here; the handler re-exports the three functions it still calls directly so
 * existing importers keep working.
 */

import type { Message } from '@mcp-abap-adt/llm-agent';
import { getSharedHistoryRag } from './agent-manager';
import { turnOwner } from './lib/session-history-rag';

/** Max messages kept in server session (before SmartAgent's own summarization) */
const SESSION_MAX_MESSAGES = 20;

/** Session TTL: 30 minutes of inactivity */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval: every 5 minutes */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
  messages: Message[];
  lastAccess: number;
}

/**
 * Session store keyed by `${userId}\u0000${sessionId}`.
 *
 * Deliberately NOT keyed by sessionId alone: two BTP users that happen to
 * share or collide on the same session id (header spoofing, cookie theft,
 * UUID collision) must never share chat history. Scoping by userId makes
 * cross-user reads impossible by construction.
 */
const sessionStore = new Map<string, SessionEntry>();

/** Composite key that isolates sessions by user identity. */
function sessionStoreKey(sessionId: string, userId: string): string {
  return `${userId}\u0000${sessionId}`;
}

/** Periodic cleanup of expired sessions. `.unref()` so the timer doesn't keep the
 *  Node process (or Jest workers) alive after everything else exits. */
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionStore) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

/** Get session history for a specific user. Returns empty array if none. */
export function getSessionHistory(
  sessionId: string,
  userId: string,
): Message[] {
  const entry = sessionStore.get(sessionStoreKey(sessionId, userId));
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.messages;
  }
  return [];
}

/** Append messages to session history for a specific user, trimming to max size */
export function appendToSession(
  sessionId: string,
  userId: string,
  ...msgs: Message[]
): void {
  const key = sessionStoreKey(sessionId, userId);
  let entry = sessionStore.get(key);
  if (!entry) {
    entry = { messages: [], lastAccess: Date.now() };
    sessionStore.set(key, entry);
  }
  entry.lastAccess = Date.now();
  entry.messages.push(...msgs);

  // Keep only last N messages
  if (entry.messages.length > SESSION_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SESSION_MAX_MESSAGES);
  }
}

/** Clear session history for a specific user */
export function clearSession(sessionId: string, userId: string): void {
  sessionStore.delete(sessionStoreKey(sessionId, userId));
  // The recall store holds the same conversation in another shape. Clearing one
  // and leaving the other would let a cleared session keep answering from turns
  // the user believes they deleted.
  void getSharedHistoryRag()
    ?.forgetOwner(turnOwner(userId, sessionId))
    .catch(() => {});
}

/**
 * Whether this user's session still holds any turns.
 *
 * Unlike `getSessionHistory` this does not refresh `lastAccess`: asking whether
 * a session is idle must not make it look busy.
 */
export function hasSessionHistory(sessionId: string, userId: string): boolean {
  return sessionStore.has(sessionStoreKey(sessionId, userId));
}
