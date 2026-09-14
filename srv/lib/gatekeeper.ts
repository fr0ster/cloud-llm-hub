/**
 * The gatekeeper as the service sees it: one door and one retention per process,
 * built from the configuration and the real stores.
 *
 * The only module the channels, the RAG routes, the server and the health
 * function call. Everything with rules in it lives in the pure units beside it.
 */

import cds from '@sap/cds';
import { gatekeeperConfig } from './gatekeeper-config';
import {
  type Lease,
  type LeaseKind,
  type LeaseRefusal,
  SessionRetention,
} from './session-retention';
import { deleteSessionState, hasSessionState } from './session-state';

let retention: SessionRetention | undefined;

export function theRetention(): SessionRetention {
  if (!retention) {
    retention = new SessionRetention(
      {
        hasState: hasSessionState,
        deleteAll: deleteSessionState,
        reportDeleteError: (userId, sessionId, error) =>
          cds.log('gatekeeper').warn('session removal failed', {
            userId,
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
      gatekeeperConfig().maxRetainedSessions,
    );
  }
  return retention;
}

/**
 * Whether a presented cookie still names a session.
 *
 * Closing means no, from the mark: the session is unreachable from that moment.
 * Otherwise yes when retention knows it or any store still holds it — the
 * second covers collections loaded from disk after a restart, which retention
 * has never seen.
 */
export function sessionIsLive(userId: string, sessionId: string): boolean {
  const r = theRetention();
  if (r.isClosing(userId, sessionId)) return false;
  return r.isKnown(userId, sessionId) || hasSessionState(userId, sessionId);
}

export function leaseSession(
  userId: string,
  sessionId: string,
  kind: LeaseKind,
  opts: { presented?: boolean } = {},
): Lease | LeaseRefusal {
  return theRetention().lease(userId, sessionId, kind, opts);
}

/** Close, wait for what is running, remove. The caller answers without awaiting it. */
export function deleteSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  return theRetention().close(userId, sessionId);
}

export function maySweepSession(userId: string, sessionId: string): boolean {
  return theRetention().maySweep(userId, sessionId);
}

export function forgetEmptySessions(): number {
  return theRetention().forgetEmpty();
}

/** Test seam. */
export function resetGatekeeperForTest(): void {
  retention = undefined;
}
