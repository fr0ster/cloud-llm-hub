import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  buildSetCookie,
  resolveSessionId,
  resolveSessionKey,
  type WithSession,
} from '../session-id';
import type { LongSession } from './long-session';
import { getHubRagAccess } from './rag-access';
import { bindCaller } from './rag-caller';
import { sessionConfig } from './session-config';
import {
  type LongSessionRequest,
  SESSION_NOTICE_HEADER,
  type SessionNotice,
} from './session-connection';
import {
  anthropicSessionRefusal,
  openAiSessionRefusal,
  type SessionRefusalCode,
} from './throttle-surfacing';

export interface SessionMiddlewareDeps {
  /**
   * Whether a presented session still exists. Absent: every presented cookie is
   * kept. Supplied once retention exists (Task 6), so a cookie naming a session
   * that was deleted, evicted or swept is treated as holding nothing.
   */
  isLive?: (userId: string, sessionId: string) => boolean;
  /** The authenticated user. The middleware runs after auth, so CAP's context has it. */
  userIdOf?: () => string;
  /**
   * The long session under a presented key: live, or revived. Rejects with
   * `{ refused: 'SESSION_LIMIT' }` when a revival finds no room, and with a
   * `retryAfterSeconds` when it cannot run yet (503 with Retry-After). Absent: keys
   * are not read and every request is handled as in plain mode.
   */
  resolveSession?: (
    userId: string,
    key: string,
  ) => Promise<LongSession | undefined>;
  /** Activity on a resolved session: every `/v1` request in it extends its TTL. */
  touchSession?: (s: LongSession) => void;
  /** Whether this response is the first after a revival (told once). */
  takeRevivalNotice?: (s: LongSession) => boolean;
  /**
   * Requests on which a key naming no session is not refused but ignored: the
   * session routes, where a stale explicit key must not stop a client
   * from opening a new session or from closing what is already gone.
   */
  keyOptional?: (req: Request) => boolean;
}

const chatSessionSchema = z
  .object({ session: z.string().optional() })
  .catchall(z.json());

export type SessionDialect = 'openai' | 'anthropic';

/** `/v1/messages` speaks Anthropic; every other `/v1` route the OpenAI envelope. */
/** Express routes case-insensitively and accepts a trailing slash. */
function routeOf(path: string | undefined): string {
  return (path ?? '').toLowerCase().replace(/\/+$/, '');
}

function dialectOf(req: Request): SessionDialect {
  return routeOf(req.path) === '/messages' ? 'anthropic' : 'openai';
}

function refuse(
  res: Response,
  dialect: SessionDialect,
  code: SessionRefusalCode,
): void {
  const r =
    dialect === 'anthropic'
      ? anthropicSessionRefusal(code)
      : openAiSessionRefusal(code);
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(r.body));
}

function refuseBinding(
  res: Response,
  dialect: SessionDialect,
  message: string,
): void {
  const error = { type: 'permission_error', message };
  res
    .status(403)
    .json(dialect === 'anthropic' ? { type: 'error', error } : { error });
}

/**
 * Give every `/v1` request a session this service issued.
 *
 * An explicit long-session key binds the request to its caller-owned session,
 * live or revived. Chat body `session` takes precedence over the header.
 * Authenticated requests bind the resolved or minted session before continuing.
 *
 * A cookie bound to another user is refused before key resolution or liveness is
 * checked. Otherwise the presented `clh_session` is kept
 * when it names a live session, and otherwise one is minted and the cookie set
 * — never a revival of the old id, so state a caller asked us to destroy
 * cannot be reattached through the cookie in their jar.
 */
function isChatRoute(path: string): boolean {
  const route = routeOf(path);
  return route === '/chat/completions' || route === '/messages';
}

export function sessionMiddleware(deps: SessionMiddlewareDeps = {}) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const r = req as Request & WithSession & LongSessionRequest;
    const userId = deps.userIdOf?.() ?? 'anonymous';
    if (deps.userIdOf) {
      try {
        const presented = resolveSessionId(r);
        if (presented) {
          const owner =
            await getHubRagAccess().access.bindings.getUserId(presented);
          if (
            !owner.ok ||
            (owner.value !== undefined && owner.value !== userId)
          ) {
            refuseBinding(
              res,
              dialectOf(req),
              'Session belongs to another user or its binding is unavailable',
            );
            return;
          }
        }
      } catch (error) {
        refuseBinding(
          res,
          dialectOf(req),
          error instanceof Error
            ? error.message
            : 'Session binding unavailable',
        );
        return;
      }
    }
    let bodySession: string | undefined;
    let hasBodySession = false;
    if (req.method === 'POST' && isChatRoute(req.path)) {
      const parsed = chatSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        const error = {
          type: 'invalid_request_error',
          message: 'Invalid JSON body: session must be a string',
        };
        res
          .status(400)
          .json(
            dialectOf(req) === 'anthropic'
              ? { type: 'error', error }
              : { error },
          );
        return;
      }
      const { session, ...body } = parsed.data;
      hasBodySession = session !== undefined;
      bodySession = session?.trim() || undefined;
      req.body = body;
    }
    const { key } = hasBodySession
      ? { key: bodySession }
      : resolveSessionKey(r);
    const resolve = deps.resolveSession;
    if (key === undefined || !resolve) {
      if (!deps.userIdOf) {
        perRequest(r, res, userId, deps);
        next();
        return;
      }
      return (async () => {
        const sessionId = perRequest(r, res, userId, deps);
        const bound = await bindCaller(sessionId, userId, false);
        if (!bound.ok) {
          refuseBinding(res, dialectOf(req), bound.error.message);
          return;
        }
        next();
      })().catch((error) => {
        refuseBinding(
          res,
          dialectOf(req),
          error instanceof Error
            ? error.message
            : 'Session binding unavailable',
        );
      });
    }
    return resolve(userId, key).then(
      async (s) => {
        if (s && s.userId === userId) {
          const bound = await bindCaller(key, userId, false);
          if (!bound.ok) {
            refuseBinding(res, dialectOf(req), bound.error.message);
            return;
          }
          deps.touchSession?.(s);
          r.sessionId = key;
          r.sessionMinted = false;
          r.longSession = s;
          if (deps.takeRevivalNotice?.(s))
            res.setHeader(
              SESSION_NOTICE_HEADER,
              'revived' satisfies SessionNotice,
            );
          next();
          return;
        }
        if (deps.keyOptional?.(req)) {
          // The stale key is not a plain session either: mint.
          const sessionId = mint(r, res);
          const bound = await bindCaller(sessionId, userId, false);
          if (!bound.ok) {
            refuseBinding(res, dialectOf(req), bound.error.message);
            return;
          }
          next();
          return;
        }
        refuse(res, dialectOf(req), 'SESSION_NOT_FOUND');
      },
      (err: unknown) => {
        const e = err as {
          refused?: unknown;
          retryAfterSeconds?: unknown;
        } | null;
        const limit = e?.refused === 'SESSION_LIMIT';
        // Not ready yet (a revival before the providers are built): retry.
        if (typeof e?.retryAfterSeconds === 'number')
          res.setHeader('Retry-After', String(e.retryAfterSeconds));
        refuse(
          res,
          dialectOf(req),
          limit ? 'SESSION_LIMIT' : 'SESSION_STORE_UNAVAILABLE',
        );
      },
    );
  };
}

/** The plain mode: keep a live presented session, else mint. */
function perRequest(
  r: Request & WithSession,
  res: Response,
  userId: string,
  deps: SessionMiddlewareDeps,
): string {
  const presented = resolveSessionId(r);
  if (presented !== undefined && (deps.isLive?.(userId, presented) ?? true)) {
    r.sessionId = presented;
    r.sessionMinted = false;
    return presented;
  }
  return mint(r, res);
}

function mint(r: Request & WithSession, res: Response): string {
  const sid = `s-${randomUUID()}`;
  const secure = !!(r.secure || r.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', buildSetCookie(sid, secure));
  r.sessionId = sid;
  r.sessionMinted = true;
  return sid;
}

/**
 * Plain mode off (the default, `LLM_AGENT_PLAIN_API`): a chat request outside a
 * long session is refused 400 with how to get one. On: it is served per
 * request, as before.
 */
export function requireLongSession(dialect: SessionDialect) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req as LongSessionRequest).longSession || sessionConfig().plainApi) {
      next();
      return;
    }
    refuse(res, dialect, 'SESSION_REQUIRED');
  };
}
