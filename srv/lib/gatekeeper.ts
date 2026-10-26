import type { SessionCloseReason } from './usage/hub-records';
import { usageRuntime } from './usage/runtime';
import {
  sessionClosed,
  sessionOpened,
  sessionReleased,
} from './usage/session-records';
import { withinUsageShutdownBudget } from './usage/shutdown';
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
import { longSessionsIfReady } from './long-session';
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

export function processAdmissionCounts(): {
  activeSessions: number;
  admissionQueueLength: number;
  runningTasks: number;
} {
  const sessions = longSessionsIfReady();
  return {
    activeSessions:
      (sessions?.size() ?? 0) +
      (retention?.countExcept(
        (userId: string, sessionId: string): boolean =>
          sessions?.containsIdentity(userId, sessionId) ?? false,
      ) ?? 0),
    admissionQueueLength: door?.snapshot().queued ?? 0,
    runningTasks: usageRuntime()?.enabled('process')
      ? (retention?.countLeases('pipeline') ?? 0)
      : 0,
  };
}

/** An open long session, not closing. */
function isOpenLongSession(userId: string, sessionId: string): boolean {
  return longSessionsIfReady()?.has(userId, sessionId) ?? false;
}

export function theRetention(): SessionRetention {
  if (!retention) {
    retention = new SessionRetention(
      {
        onSessionRetained: (userId: string, sessionId: string): void => {
          if (
            (usageRuntime()?.enabled('session') ||
              usageRuntime()?.enabled('storage')) &&
            !isOpenLongSession(userId, sessionId)
          )
            sessionOpened({ userId, sessionId });
        },
        afterAsyncRemoval: (): void => {
          if (
            usageRuntime()?.enabled('session') ||
            usageRuntime()?.enabled('storage')
          )
            theDoor()?.poke();
        },
        beforeSessionReleased: (
          userId: string,
          sessionId: string,
          reason: SessionCloseReason,
        ): Promise<void> | undefined => {
          if (
            (usageRuntime()?.enabled('session') ||
              usageRuntime()?.enabled('storage')) &&
            !isOpenLongSession(userId, sessionId)
          )
            return sessionClosed({ userId, sessionId }, reason);
        },
        onSessionReleased: (
          userId: string,
          sessionId: string,
          reason: SessionCloseReason,
        ): void => {
          if (
            usageRuntime()?.enabled('session') ||
            usageRuntime()?.enabled('storage')
          )
            sessionReleased({ userId, sessionId }, reason);
        },

        // An open long session holds state by definition, even before its
        // first turn: without this, its first request (presented, since the
        // key was kept) would find it "gone" and be refused.
        hasState: (userId, sessionId) =>
          hasSessionState(userId, sessionId) ||
          isOpenLongSession(userId, sessionId),
        deleteAll: deleteSessionState,
        isPinned: isOpenLongSession,
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
  /** Aborted by shutdown, and by nothing else. */
  readonly signal: AbortSignal | undefined;
  /** Run the pipeline so that its calls register against this session. */
  run<T>(fn: () => T): T;
  /** Resolves when every registered call has settled. */
  drain(): Promise<void>;
  /** Last in teardown. Idempotent. */
  release(): void;
}

let activePipelines: Set<Promise<void>> | undefined;
function trackPipeline(pipeline: PipelineSession): PipelineSession {
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('session') && !runtime.enabled('storage')))
    return pipeline;
  let settle: () => void = (): void => {};
  const done = new Promise<void>(
    (resolve: (value: void | PromiseLike<void>) => void): void => {
      settle = resolve;
    },
  );
  activePipelines ??= new Set<Promise<void>>();
  const pipelines = activePipelines;
  pipelines.add(done);
  return {
    signal: pipeline.signal,
    run: pipeline.run,
    drain: pipeline.drain,
    release(): void {
      try {
        pipeline.release();
      } finally {
        pipelines.delete(done);
        settle();
      }
    },
  };
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
  if (usageRuntime() && backgroundShutdown.signal.aborted)
    return { closed: true };
  const d = theDoor();
  if (d) {
    const r = await d.admit(userId, sessionId, signal, opts);
    if ('refused' in r || 'closed' in r) return r;
    const a = r.admitted;
    return {
      admitted: trackPipeline({
        signal: a.signal,
        run: <T>(fn: () => T) => runWithAdmission(a, fn),
        drain: () => a.drain(),
        release: () => a.release(),
      }),
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
    admitted: trackPipeline({
      signal: usageRuntime() ? backgroundShutdown.signal : undefined,
      run: <T>(fn: () => T) => runWithAdmission(register, fn),
      drain: () => register.drain(),
      release: () => {
        if (released) return;
        released = true;
        lease.release();
      },
    }),
  };
}

let backgroundShutdown = new AbortController();

/** Retain and register background work without taking any Door capacity. */
export async function admitBackground(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<PipelineAdmission> {
  if (signal?.aborted || backgroundShutdown.signal.aborted)
    return { closed: true };
  const lease = theRetention().lease(userId, sessionId, 'pipeline');
  if (isRefusal(lease)) return { closed: true };
  const register = createCallRegister();
  let released = false;
  return {
    admitted: trackPipeline({
      signal: backgroundShutdown.signal,
      run: <T>(fn: () => T) => runWithAdmission(register, fn),
      drain: () => register.drain(),
      release: () => {
        if (!released) {
          released = true;
          lease.release();
        }
      },
    }),
  };
}

/**
 * Whether a presented cookie still names a session.
 *
 * Closing means no, from the mark: the session is unreachable from that moment.
 * Otherwise yes when retention knows it, any store still holds it — the second
 * covers state no lease has touched in this process, such as history — or it
 * is an open long session.
 */
export function sessionIsLive(userId: string, sessionId: string): boolean {
  const r = theRetention();
  if (r.isClosing(userId, sessionId)) return false;
  return (
    r.isKnown(userId, sessionId) ||
    hasSessionState(userId, sessionId) ||
    isOpenLongSession(userId, sessionId)
  );
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

/**
 * The collection sweep leaves an open long session alone: its collections end
 * with the session (explicit close or TTL), whatever their own expiry says.
 */
export function maySweepSession(userId: string, sessionId: string): boolean {
  return (
    theRetention().maySweep(userId, sessionId) &&
    !isOpenLongSession(userId, sessionId)
  );
}

/**
 * Whether a RAG operation is running against this session now — one that
 * writes into its session collections, so they must not be removed under it.
 */
export function hasRagLease(userId: string, sessionId: string): boolean {
  return theRetention().hasLease(userId, sessionId, 'rag');
}

export function forgetEmptySessions(): number {
  const n = theRetention().forgetEmpty();
  if (n > 0) theDoor()?.poke();
  return n;
}

/**
 * End every admitted session and every waiter. The only thing that does.
 *
 * Abort first; recording alone needs a bounded wait for full pipeline teardown.
 */
export function shutdownGatekeeper(): Promise<void> | void {
  backgroundShutdown.abort(new Error('shutdown'));
  theDoor()?.abortAll(new Error('shutdown'));
  if (usageRuntime())
    return withinUsageShutdownBudget(
      Promise.all([...(activePipelines ?? [])]).then((): void => {}),
    ).then((): void => {});
}

/** Test seam. */
export function resetGatekeeperForTest(): void {
  door?.abortAll(new Error('test reset'));
  backgroundShutdown.abort();
  backgroundShutdown = new AbortController();
  activePipelines?.clear();
  door = undefined;
  retention = undefined;
}
