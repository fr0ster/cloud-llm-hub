/**
 * Session identity.
 *
 * A session is the one this service issued in `clh_session`, together with the
 * authenticated user. Nothing a caller writes in a header names one:
 * `x-session-id` and `mcp-session-id` are not read. Between a consumer and MCP
 * and ABAP there is no reason for a consumer to name a chat session, and a
 * header that did was one more value to validate and one more way to collide.
 *
 * The cookie is unsigned and nothing records what was issued, so a caller can
 * still send any value in it. That is harmless only because the user half of
 * the key comes from the token: a chosen id collides with its own author's
 * requests and nobody else's.
 */

/** Name of the HttpOnly session cookie issued by the session middleware. */
export const SESSION_COOKIE = 'clh_session';

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
