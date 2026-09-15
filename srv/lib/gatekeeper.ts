/**
 * The gatekeeper as the service sees it: one door and one retention per process,
 * built from the configuration and the real stores.
 *
 * The only module the channels, the RAG routes, the server and the health
 * function call. Everything with rules in it lives in the pure units beside it.
 */

import cds from '@sap/cds';
import { createCallRegister, runWithAdmission } from './admission-scope';
import { Door } from './door';
import { gatekeeperConfig } from './gatekeeper-config';
import {
  isRefusal,
  type Lease,
  type LeaseKind,
  type LeaseRefusal,
  SessionRetention,
} from './session-retention';
import { deleteSessionState, hasSessionState } from './session-state';
import type { DoorRefusalReason } from './throttle-surfacing';

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

/** `null` once built and not configured; `undefined` before the first call. */
let door: Door | null | undefined;

/** The door, or `undefined` when no capacity is configured. */
export function theDoor(): Door | undefined {
  if (door === undefined) {
    const cfg = gatekeeperConfig();
    door =
      cfg.maxLiveSessions === undefined
        ? null
        : new Door({
            capacity: cfg.maxLiveSessions,
            queueLength: cfg.queueLength ?? cfg.maxLiveSessions,
            retention: theRetention(),
            onPressure: (depth, queueLength) =>
              cds
                .log('gatekeeper')
                .warn('admission queue three quarters full', {
                  depth,
                  queueLength,
                }),
          });
  }
  return door ?? undefined;
}

/** A running pipeline's hold on its session, door or no door. */
export interface PipelineSession {
  /** Aborted by shutdown, and by nothing else. `undefined` with no door. */
  readonly signal: AbortSignal | undefined;
  /** Run the pipeline so that its calls register against this session. */
  run<T>(fn: () => T): T;
  /** Resolves when every registered call has settled. */
  drain(): Promise<void>;
  /** Last in teardown. Idempotent. */
  release(): void;
}

export type PipelineAdmission =
  | { admitted: PipelineSession }
  | { refused: DoorRefusalReason }
  | { closed: true };

/**
 * Admit a pipeline for this user's session.
 *
 * With a door: waits in the queue or is refused. Without one: admitted at once,
 * and still leased and registered, so a logout waits for the run and teardown
 * waits for its calls.
 */
export async function admitPipeline(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
  opts: { presented?: boolean } = {},
): Promise<PipelineAdmission> {
  const d = theDoor();
  if (d) {
    const r = await d.admit(userId, sessionId, signal, opts);
    if ('refused' in r || 'closed' in r) return r;
    const a = r.admitted;
    return {
      admitted: {
        signal: a.signal,
        run: (fn) => runWithAdmission(a, fn),
        drain: () => a.drain(),
        release: () => a.release(),
      },
    };
  }
  // With no door there is no retention cap, so a refusal here means one thing:
  // the session was closed after the middleware accepted it. No limit is set;
  // that does not mean running over a session the caller asked us to destroy.
  const lease = theRetention().lease(userId, sessionId, 'pipeline', opts);
  if (isRefusal(lease)) return { closed: true };
  const register = createCallRegister();
  let released = false;
  return {
    admitted: {
      signal: undefined,
      run: (fn) => runWithAdmission(register, fn),
      drain: () => register.drain(),
      release: () => {
        if (released) return;
        released = true;
        lease.release();
      },
    },
  };
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
  const lease = theRetention().lease(userId, sessionId, kind, opts);
  if (isRefusal(lease)) return lease;
  return {
    kind: lease.kind,
    signal: lease.signal,
    release: () => {
      lease.release();
      // A place may have freed that a queued pipeline is waiting for.
      theDoor()?.poke();
    },
  };
}

/** Close, wait for what is running, remove. The caller answers without awaiting it. */
export function deleteSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  const removal = theRetention().close(userId, sessionId);
  // From the mark, a waiter that presented this session is answered, not left
  // to wait for a session that is going.
  theDoor()?.poke();
  return removal.finally(() => theDoor()?.poke());
}

export function maySweepSession(userId: string, sessionId: string): boolean {
  return theRetention().maySweep(userId, sessionId);
}

/**
 * Whether a RAG operation is running against this session now — one that
 * writes into its session collections, so they must not be removed under it.
 */
export function hasRagLease(userId: string, sessionId: string): boolean {
  return theRetention().hasLease(userId, sessionId, 'rag');
}

/**
 * The five-minute pass: forget sessions that hold nothing, and retry removals
 * that failed. A directory that would not go keeps its session closed and its
 * place taken until one of these passes, or another close, removes it.
 */
export function forgetEmptySessions(): number {
  const r = theRetention();
  const n = r.forgetEmpty() + r.retryFailedCleanups();
  if (n > 0) theDoor()?.poke();
  return n;
}

/**
 * End every admitted session and every waiter. The only thing that does.
 *
 * Best-effort by necessity: it aborts and returns without waiting for the
 * register, because the process is exiting.
 */
export function shutdownGatekeeper(): void {
  theDoor()?.abortAll(new Error('shutdown'));
}

/** Test seam. */
export function resetGatekeeperForTest(): void {
  door?.abortAll(new Error('test reset'));
  door = undefined;
  retention = undefined;
}
