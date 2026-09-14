import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  buildSetCookie,
  resolveSessionId,
  type WithSession,
} from '../session-id';

export interface SessionMiddlewareDeps {
  /**
   * Whether a presented session still exists. Absent: every presented cookie is
   * kept. Supplied once retention exists (Task 6), so a cookie naming a session
   * that was deleted, evicted or swept is treated as holding nothing.
   */
  isLive?: (userId: string, sessionId: string) => boolean;
  /** The authenticated user. The middleware runs after auth, so CAP's context has it. */
  userIdOf?: () => string;
}

/**
 * Give every `/v1` request a session this service issued.
 *
 * Keeps the presented `clh_session` when it names a live session, and otherwise
 * mints one and sets the cookie — never a revival of the old id, so state a
 * caller asked us to destroy cannot be reattached through the cookie in their
 * jar.
 */
export function sessionMiddleware(deps: SessionMiddlewareDeps = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as Request & WithSession;
    const presented = resolveSessionId(r);
    const userId = deps.userIdOf?.() ?? 'anonymous';
    if (presented !== undefined && (deps.isLive?.(userId, presented) ?? true)) {
      r.sessionId = presented;
      r.sessionMinted = false;
      next();
      return;
    }
    const sid = `s-${randomUUID()}`;
    const secure = !!(
      req.secure || req.headers['x-forwarded-proto'] === 'https'
    );
    res.setHeader('Set-Cookie', buildSetCookie(sid, secure));
    r.sessionId = sid;
    r.sessionMinted = true;
    next();
  };
}
