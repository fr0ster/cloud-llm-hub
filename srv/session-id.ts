/**
 * Session ID resolution helpers.
 *
 * Priority:
 *   1. x-session-id header (API/MCP clients that set it explicitly)
 *   2. mcp-session-id header (MCP SDK default header name)
 *   3. clh_session cookie (browser sessions — set by the session middleware)
 *   4. undefined (caller must mint a new id)
 *
 * No npm dependencies — cookie parsing is done inline.
 */

/** Name of the HttpOnly session cookie issued by the session middleware. */
export const SESSION_COOKIE = 'clh_session';

/** Minimal shape of an Express request that resolveSessionId needs. */
interface IncomingHeaders {
  headers: {
    [key: string]: string | string[] | undefined;
    cookie?: string;
  };
}

/**
 * Return the effective session id for the incoming request.
 *
 * - Header wins over cookie so API/MCP clients (Cline, curl) keep working as-is.
 * - Cookie is parsed manually (split on `;`, find `clh_session=`) — no extra deps.
 */
export function resolveSessionId(req: IncomingHeaders): string | undefined {
  // 1. x-session-id header
  const xHeader = req.headers['x-session-id'];
  if (xHeader) {
    const v = Array.isArray(xHeader) ? xHeader[0] : xHeader;
    const trimmed = v.trim();
    if (trimmed) return trimmed;
  }

  // 2. mcp-session-id header
  const mcpHeader = req.headers['mcp-session-id'];
  if (mcpHeader) {
    const v = Array.isArray(mcpHeader) ? mcpHeader[0] : mcpHeader;
    const trimmed = v.trim();
    if (trimmed) return trimmed;
  }

  // 3. Cookie: clh_session=<value>
  const cookieStr = req.headers.cookie;
  if (cookieStr) {
    for (const part of cookieStr.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name === SESSION_COOKIE) {
        const val = part.slice(eq + 1).trim();
        if (val) return val;
      }
    }
  }

  return undefined;
}

/**
 * Build a `Set-Cookie` header value for the session cookie.
 *
 * @param sessionId  The session identifier to embed in the cookie.
 * @param secure     When true, appends `; Secure` (use behind HTTPS / CF approuter).
 *                   When false, the `Secure` attribute is omitted so the cookie
 *                   works on plain `http://localhost` during local development.
 */
export function buildSetCookie(sessionId: string, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`;
  return secure ? `${base}; Secure` : base;
}
