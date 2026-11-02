/**
 * Session identity: plain-mode ids use the cookie; long sessions require an
 * explicit header (or the chat body session field). Authentication supplies
 * the owner half of every session lookup.
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

/** The plain-mode cookie id; legacy long-session cookies are ignored. */
export function resolveSessionId(req: IncomingHeaders): string | undefined {
  const cookieStr = req.headers.cookie;
  if (!cookieStr) return undefined;
  for (const part of cookieStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const val = part.slice(eq + 1).trim();
      return val && !val.startsWith(LONG_SESSION_PREFIX) ? val : undefined;
    }
  }
  return undefined;
}

/** The explicit long-session key this request presents; cookies never select it. */
export function resolveSessionKey(req: IncomingHeaders): { key?: string } {
  const raw = req.headers[SESSION_HEADER];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
  return { key };
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
