/**
 * Session identity.
 *
 * A session is one this service issued, together with the authenticated user:
 * a per-request id in the `clh_session` cookie, or a long-session key
 * (`POST /v1/session`), which the client sends back in `x-clh-session` or,
 * where it cannot set a header (`sendBeacon`), in the cookie. `x-session-id`
 * and `mcp-session-id` are still not read: they named sessions this service
 * never issued.
 *
 * Reading `x-clh-session` is safe for the same reason the cookie is. Neither
 * is signed, so a caller can send any value; but the user half of the key
 * comes from the token, so a chosen key reaches its own author's sessions and
 * nobody else's. A header and a cookie that name two different sessions are
 * refused, never resolved by picking one.
 */

/** Name of the HttpOnly session cookie issued by the session middleware. */
export const SESSION_COOKIE = 'clh_session';

/** The header carrying a long-session key (the extended OpenAI protocol). */
export const SESSION_HEADER = 'x-clh-session';

/** Prefix of a long-session key (`newSessionKey`); a minted id starts `s-`. */
const LONG_SESSION_PREFIX = 'ls-';

/** Minimal shape of an Express request the helpers here need. */
interface IncomingHeaders {
  headers: {
    [key: string]: string | string[] | undefined;
    cookie?: string;
  };
}

/** A request the session middleware has seen. */
export type WithSession = IncomingHeaders & {
  sessionId?: string;
  sessionMinted?: boolean;
};

/** The `clh_session` cookie's value, or `undefined`. */
export function resolveSessionId(req: IncomingHeaders): string | undefined {
  const cookieStr = req.headers.cookie;
  if (!cookieStr) return undefined;
  for (const part of cookieStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const val = part.slice(eq + 1).trim();
      return val || undefined;
    }
  }
  return undefined;
}

/**
 * The long-session key this request presents, and whether it presents two.
 *
 * The header always names a long session. The cookie does only when it holds
 * a long-session key: a minted per-request id there is the plain mode's, and
 * the middleware handles it as before. A header and a cookie with different
 * values are a conflict, whatever either holds.
 */
export function resolveSessionKey(req: IncomingHeaders): {
  key?: string;
  conflict: boolean;
} {
  const raw = req.headers[SESSION_HEADER];
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
  const cookie = resolveSessionId(req);
  if (header !== undefined && cookie !== undefined && header !== cookie) {
    return { key: undefined, conflict: true };
  }
  const key =
    header ?? (cookie?.startsWith(LONG_SESSION_PREFIX) ? cookie : undefined);
  return { key, conflict: false };
}

/**
 * Whether the request still carries a session header.
 *
 * Read only to refuse it loudly where silence would mislead — never to identify
 * a session.
 */
export function carriesSessionHeader(req: IncomingHeaders): boolean {
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim();
  return !!(
    first(req.headers['x-session-id']) || first(req.headers['mcp-session-id'])
  );
}

/** The session this request runs under: what the middleware stashed, else the cookie. */
export function sessionIdOf(req: WithSession): string | undefined {
  return req.sessionId ?? resolveSessionId(req);
}

/**
 * The session the caller presented and we kept, or `undefined` when the
 * middleware minted a new one.
 *
 * The difference decides whether history is server-managed: a caller that
 * presented nothing we kept has no stored turns to prepend, and a stateless API
 * client sending its full history must not be truncated to its last message.
 */
export function honouredSessionId(req: WithSession): string | undefined {
  return req.sessionMinted ? undefined : sessionIdOf(req);
}

/**
 * Build a `Set-Cookie` header value for the session cookie.
 *
 * @param secure When true, appends `; Secure` (behind HTTPS / the CF approuter).
 *               When false, it is omitted so the cookie works on plain
 *               `http://localhost` during local development.
 */
export function buildSetCookie(sessionId: string, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`;
  return secure ? `${base}; Secure` : base;
}

/** A `Set-Cookie` value that removes the session cookie. */
export function buildClearCookie(secure: boolean): string {
  return `${buildSetCookie('', secure)}; Max-Age=0`;
}
