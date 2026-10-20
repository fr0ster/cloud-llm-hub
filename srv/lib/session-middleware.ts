import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  buildSetCookie,
  resolveSessionId,
  resolveSessionKey,
  SESSION_HEADER,
  type WithSession,
} from '../session-id';
import type { LongSession } from './long-session';
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
   * session routes, where a stale key in the cookie must not stop a client
   * from opening a new session or from closing what is already gone.
   */
  keyOptional?: (req: Request) => boolean;
}

export type SessionDialect = 'openai' | 'anthropic';

/** `/v1/messages` speaks Anthropic; every other `/v1` route the OpenAI envelope. */
function dialectOf(req: Request): SessionDialect {
  return req.path === '/messages' ? 'anthropic' : 'openai';
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

/**
 * Give every `/v1` request a session this service issued.
 *
 * A long-session key (`x-clh-session`, or a long-session key in the cookie)
 * binds the request to that session: live, or revived from its record. A key
 * that names none — closed, expired, never opened, another user's — is refused
 * 404 when sent in the header; an unknown cookie key is treated as absent.
 * The header takes precedence over the cookie.
 *
 * Without a key, the plain mode of before: the presented `clh_session` is kept
 * when it names a live session, and otherwise one is minted and the cookie set
 * — never a revival of the old id, so state a caller asked us to destroy
 * cannot be reattached through the cookie in their jar.
 */
export function sessionMiddleware(deps: SessionMiddlewareDeps = {}) {
  return (
    req: Request,
    res: Response,
    next: NextFunction,
  ): undefined | Promise<void> => {
    const r = req as Request & WithSession & LongSessionRequest;
    const userId = deps.userIdOf?.() ?? 'anonymous';
    const { key } = resolveSessionKey(r);
    const resolve = deps.resolveSession;
    if (key === undefined || !resolve) {
      perRequest(r, res, userId, deps);
      next();
      return;
    }
    return resolve(userId, key).then(
      (s) => {
        if (s) {
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
        if (
          !r.headers[SESSION_HEADER]?.toString().trim() ||
          deps.keyOptional?.(req)
        ) {
          // The stale key is not a plain session either: mint.
          mint(r, res);
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
): void {
  const presented = resolveSessionId(r);
  if (presented !== undefined && (deps.isLive?.(userId, presented) ?? true)) {
    r.sessionId = presented;
    r.sessionMinted = false;
    return;
  }
  mint(r, res);
}

function mint(r: Request & WithSession, res: Response): void {
  const sid = `s-${randomUUID()}`;
  const secure = !!(r.secure || r.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', buildSetCookie(sid, secure));
  r.sessionId = sid;
  r.sessionMinted = true;
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
