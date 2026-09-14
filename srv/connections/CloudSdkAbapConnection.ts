// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before submodule imports
import '../env-setup';

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type {
  AbapConnection,
  AbapRequestOptions,
  SapConfig,
} from '@mcp-abap-adt/connection';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';
import type { IAdtResponse } from '@mcp-abap-adt/interfaces';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { logger } from '../lib/logger';

/**
 * AbapConnection implementation using SAP Cloud SDK executeHttpRequest
 * This leverages SAP Cloud SDK's automatic destination handling, authentication,
 * and proxy management instead of manual axios requests.
 */
export class CloudSdkAbapConnection implements AbapConnection {
  private csrfToken: string | null = null;
  private cookieJar: Map<string, string> = new Map();
  private cachedBaseUrl: string | null = null;
  private readonly sessionId: string;
  private sessionType: 'stateless' | 'stateful' = 'stateless';
  private readonly destinationName: string;
  /** Shared promise for CSRF refresh — ensures only one fetch at a time */
  private csrfRefreshing: Promise<string> | null = null;
  /** Reference count for nested beginCriticalSection()/endCriticalSection(). */
  private criticalSectionDepth = 0;
  /** True while a lock→modify→unlock chain must not be cut by a short timeout. */
  private inCriticalSection = false;
  /** True once this connection has run any stateful request — so cleanup knows
   * it must terminate the server-side ADT session (which may hold an edit-lock). */
  private wentStateful = false;
  /**
   * App-server stickiness (the orphaned-lock fix).
   *
   * On the BTP connectivity forward-proxy path SAP does NOT issue a
   * `SAP_SESSIONID_<SID>_<CLIENT>` routing cookie (only `sap-contextid`), so a
   * stateful lock chain's follow-up request (e.g. the domain update's
   * read-modify-write GET after LOCK) scatters to a DIFFERENT ABAP app-server →
   * 400 "Session not found" → the edit-lock is orphaned. mcp-abap-adt avoids this
   * only because its persistent socket keeps one TCP connection to one instance.
   *
   * We instead generate a stable `SAP_SESSIONID_<SID>_<CLIENT>` ourselves and send
   * it on every request so the SAP Web Dispatcher pins the whole chain to one
   * app-server. Stable per connection (hence per destination, since a connection
   * targets one destination); if the server ever issues a real one it wins. */
  private generatedSapSessionId: string | null = null;
  /**
   * ONE keep-alive socket per connector (one destination = one session = one
   * connector = one connection). SAP Cloud SDK's `executeHttpRequest` otherwise
   * builds a fresh agent per call and draws from a shared socket pool, so a cold
   * lock chain can send LOCK on one socket/tunnel and the follow-up GET on
   * another — and the ADT stateful session (bound to that tunnel) is then "not
   * found", orphaning the edit-lock. `maxSockets: 1` + keepAlive forces every
   * request of the chain (CSRF → validate → create → LOCK → update → unlock →
   * activate) down the SAME socket → the same tunnel → the one app-server behind
   * the connectivity proxy, so the session holds even on a cold start. Requests
   * on one connector are sequential, so a single socket never bottlenecks.
   *
   * ONLY `httpAgent` is overridden — on-prem ADT reaches the Cloud Connector over
   * PLAIN HTTP (axios picks the agent by target protocol), so this is the agent
   * that carries the stateful chain. `httpsAgent` is deliberately LEFT to the SAP
   * Cloud SDK: it builds destination-specific TLS (TrustAll / custom trust store /
   * client-cert mTLS) via getAgentConfig(destination), and overriding it would
   * drop that config for HTTPS destinations. (HTTPS on-prem, if ever needed, must
   * copy the SDK's TLS options rather than replace the agent.)
   */
  private keepAliveHttpAgent: http.Agent | null = null;

  private getHttpAgent(): http.Agent {
    if (!this.keepAliveHttpAgent) {
      this.keepAliveHttpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: 1,
      });
    }
    return this.keepAliveHttpAgent;
  }

  constructor(
    private readonly config: SapConfig,
    destinationName: string,
    sessionId?: string,
  ) {
    this.destinationName = destinationName;
    this.sessionId = sessionId || randomUUID();
  }

  getConfig(): SapConfig {
    return this.config;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionType(type: 'stateless' | 'stateful'): void {
    if (type === 'stateful') this.wentStateful = true;
    this.sessionType = type;
    logger.debug(`Session type set to: ${type}`, {
      sessionId: this.sessionId?.substring(0, 8),
    });
  }

  /**
   * Terminate the server-side ADT stateful session, releasing any edit-lock it
   * still holds.
   *
   * An ADT mutating flow (lock → create → update → unlock → activate) runs in a
   * STATEFUL session bound to `sap-adt-connection-id`. ADT keeps the object
   * "being edited" for the LIFETIME OF THAT SESSION — and nothing here ended it,
   * so the object was left inactive and reporting "User X is currently editing"
   * (an ADT session lock, NOT an SM12 enqueue) until the session timed out
   * server-side. That is why a combined create+activate could leave the object
   * inactive+locked, and why a separate later activate (fresh session) worked.
   *
   * Sending ONE stateless request for the same `sap-adt-connection-id` tells ADT
   * to drop the stateful session now, freeing the (already-persisted, inactive)
   * object for activation. Best-effort: never throws — this is a cleanup path.
   *
   * It also closes a session this connection merely OPENED without ever going
   * stateful. `ensureGeneratedSessionCookie` mints a `SAP_SESSIONID` per
   * connection, and SAP keeps a session per distinct value until it times out —
   * so a connection built only to read or probe still costs one session. Every
   * connection we open must be closed, whatever it turned out to be used for.
   */
  async closeSession(): Promise<void> {
    // A SAP_SESSIONID the SERVER issued is a session that exists on the server
    // and is ours to give back. One we generated ourselves is only app-server
    // stickiness (see ensureGeneratedSessionCookie) and names no server session,
    // so it is never grounds for a logoff.
    const serverSession = this.hasServerIssuedSession();
    if (!this.wentStateful && !this.generatedSapSessionId && !serverSession) {
      return;
    }
    const wasStateful = this.wentStateful;
    this.wentStateful = false;
    this.sessionType = 'stateless';
    try {
      const baseUrl = await this.getBaseUrl();
      this.enforceClientCookie();
      // Built WITHOUT minting: getCookieHeader() would generate a session id
      // here, at the very moment we are handing one back.
      const cookie = this.cookieHeader();
      if (wasStateful || this.generatedSapSessionId) {
        await this.endAdtStatefulSession(baseUrl, cookie);
      }
      if (serverSession) {
        await this.icfLogoff(baseUrl, cookie);
      }
    } catch (err) {
      // Never let session cleanup break the request flow.
      logger.warn('closeSession (ADT session release) failed', {
        error: String(err),
      });
    } finally {
      // Drop our session identity so a second call cannot re-present it, and so
      // a reused connection does not keep answering for a session we just
      // released. A later request mints a fresh one only if it needs one.
      for (const key of [...this.cookieJar.keys()]) {
        if (/^SAP_SESSIONID_/i.test(key)) this.cookieJar.delete(key);
      }
      this.generatedSapSessionId = null;
    }
  }

  /**
   * True when the cookie jar holds a `SAP_SESSIONID_*` that did NOT come from
   * `ensureGeneratedSessionCookie` — i.e. the server opened a session for us.
   */
  private hasServerIssuedSession(): boolean {
    for (const [name, value] of this.cookieJar.entries()) {
      if (!/^SAP_SESSIONID_/i.test(name)) continue;
      if (value !== this.generatedSapSessionId) return true;
    }
    return false;
  }

  /**
   * End the ADT STATEFUL session for this `sap-adt-connection-id`, releasing an
   * edit-lock a mutating tool left open. This is an ADT concern and is NOT what
   * gives the platform session back — see {@link icfLogoff}.
   *
   * Best-effort: never throws, so a failure here cannot skip the logoff.
   */
  private async endAdtStatefulSession(
    baseUrl: string,
    cookie: string | null,
  ): Promise<void> {
    try {
      await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: 'GET',
          url: `${baseUrl}/sap/bc/adt/compatibility/graph`,
          timeout: 12_000,
          httpAgent: this.getHttpAgent(),
          headers: {
            ...(await this.getAuthHeaders()),
            'sap-adt-connection-id': this.sessionId,
            // Explicit stateless ends the stateful session for this connection-id.
            'x-sap-adt-sessiontype': 'stateless',
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
      );
      logger.debug('ADT session closed', {
        sessionId: this.sessionId?.substring(0, 8),
      });
    } catch (err) {
      logger.warn('ADT stateful session release failed', {
        error: String(err),
      });
    }
  }

  /**
   * Tell the platform we are finished with the session it opened.
   *
   * On an on-premise system the logon IS the establishing request — ADT
   * publishes no session resource to close, so `/sap/public/bc/icf/logoff` is
   * the mechanism, and it is the platform's rather than ADT's. Without it every
   * connect() leaves a session behind, which is what SM04 shows as a growing
   * list opened by `P=/sap/bc/adt/discovery`.
   *
   * Only ever sent while holding the session cookie: the session limit is per
   * USER and the pool is shared with that user's SAP GUI logons, so a connector
   * that tidied up sessions it did not open would eventually close somebody's
   * GUI.
   *
   * The response's cookies are deliberately NOT adopted — a teardown must not
   * feed the session identity of a connection on its way out.
   *
   * Best-effort: never throws, and says nothing about what the server then did.
   */
  private async icfLogoff(
    baseUrl: string,
    cookie: string | null,
  ): Promise<void> {
    try {
      await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: 'GET',
          url: `${baseUrl}/sap/public/bc/icf/logoff`,
          timeout: 12_000,
          httpAgent: this.getHttpAgent(),
          headers: {
            ...(await this.getAuthHeaders()),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
      );
      logger.debug('Told the server the session is finished', {
        sessionId: this.sessionId?.substring(0, 8),
      });
    } catch (err) {
      // A hang-up here is the NORMAL outcome, not a failure.
      //
      // The logoff travels the same pinned socket the session used
      // (`maxSockets: 1`, which is what keeps a stateful chain on one
      // connection). Ending the session ends that connection, so the reply is
      // frequently never written and the client sees `socket hang up`.
      //
      // Measured on DEV, 2026-09-12: this warning fired on 100% of polls while
      // SM05 showed NO accumulated sessions — the release was working every
      // time it claimed to have failed. Reported as a failure it sends whoever
      // reads the log hunting a leak that is not there, which it already did.
      //
      // Anything else IS worth a warning: it means the request failed before
      // the server could act on it.
      //
      // The compromise, stated plainly: a hang-up does not PROVE the server
      // processed the logoff — the same three codes would appear if the
      // connection died on the way out. It is demoted because the measurement
      // above says which of the two actually happens here, and because the
      // alternative warns on every release and hides the rare real one in the
      // noise. SM05 remains the ground truth; if sessions ever do accumulate,
      // this line is where to look first.
      const text = String(err);
      if (/socket hang up|ECONNRESET|EPIPE/i.test(text)) {
        logger.debug('Session release closed the connection, as expected', {
          sessionId: this.sessionId?.substring(0, 8),
          detail: text,
        });
        return;
      }
      logger.warn('ICF logoff (session release) failed', { error: text });
    }
  }

  /**
   * Enter an uninterruptible critical section (mirrors AbstractAbapConnection).
   *
   * Core wraps every Create/Update/Delete handler in `beginCriticalSection()` …
   * `endCriticalSection()` via optional chaining (`conn?.beginCriticalSection?.()`).
   * This connection `implements AbapConnection` rather than extending the base, so
   * WITHOUT these methods that wrapping is a silent no-op and a slow write on a BTP
   * destination is cut by the short per-request timeout — which drops the stateful
   * ADT session and orphans the lock, leaving the object locked and inactive.
   * Implementing them here makes the upstream lock/timeout fix actually apply on the
   * BTP-destination path. Reference-counted so nested begin/end pairs are safe.
   */
  beginCriticalSection(): void {
    this.criticalSectionDepth++;
    this.inCriticalSection = true;
  }

  endCriticalSection(): void {
    if (this.criticalSectionDepth > 0) this.criticalSectionDepth--;
    if (this.criticalSectionDepth === 0) this.inCriticalSection = false;
  }

  isInCriticalSection(): boolean {
    return this.inCriticalSection;
  }

  async connect(): Promise<void> {
    // Pre-fetch CSRF token so the first POST doesn't need to fetch lazily.
    // Optional — refreshCsrf handles on-demand fetch if token is missing.
    await this.ensureFreshCsrfToken(CSRF_CONFIG.ENDPOINT);
  }

  /**
   * Single-shot connectivity probe under THIS connection's identity (the
   * caller's Basic auth + client). Used by the active-destination probe.
   *
   * Deliberately does NOT call connect(): a GET needs no CSRF token, and
   * connect()'s CSRF retry loop would both waste round-trips and violate the
   * "exactly one attempt" rule (retrying a 401/403 risks locking the ABAP
   * user). It seeds the `sap-usercontext` cookie up front so the request hits
   * the configured client (the `X-SAP-Client` header alone is ignored by ABAP),
   * makes ONE executeHttpRequest GET with a server-side timeout, and never
   * retries on any status.
   *
   * @param path - ADT path to GET, e.g. `/sap/bc/adt/discovery`
   * @returns httpCode and a trimmed backend body/error snippet (rawMessage)
   */
  async probe(path: string): Promise<{ httpCode: number; rawMessage: string }> {
    const baseUrl = await this.getBaseUrl();
    this.enforceClientCookie();
    const cookie = this.getCookieHeader();
    const trim = (v: unknown): string => {
      if (typeof v === 'string') return v.slice(0, 500);
      if (v && typeof v === 'object') {
        try {
          return JSON.stringify(v).slice(0, 500);
        } catch {
          return String(v).slice(0, 500);
        }
      }
      return '';
    };
    try {
      const response = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: 'GET',
          url: `${baseUrl}${path}`,
          // Server-side timeout: the browser AbortController only stops the UI
          // wait, not this Cloud SDK request.
          timeout: 12_000,
          httpAgent: this.getHttpAgent(),
          headers: {
            ...(await this.getAuthHeaders()),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
      );
      // Keep the session cookie this answered with. The probe is an
      // authenticated call, so the server may open a session for it — and a
      // session whose cookie we discarded can never be given back, because
      // holding the cookie is the whole permission to end one. Merging here is
      // what lets closeSession() log the probe's session off.
      this.mergeSetCookies(
        response.headers?.['set-cookie'] as string | string[] | undefined,
      );
      return {
        httpCode: response.status || 200,
        rawMessage: trim(response.data),
      };
    } catch (error: unknown) {
      const errObj = error as {
        response?: { status?: number; data?: unknown };
        statusCode?: number;
        message?: string;
      };
      const httpCode = errObj?.response?.status ?? errObj?.statusCode ?? 0;
      const body = errObj?.response?.data;
      const rawMessage = body ? trim(body) : trim(errObj?.message);
      return { httpCode, rawMessage };
    }
  }

  reset(): void {
    this.csrfToken = null;
    this.cookieJar.clear();
    this.cachedBaseUrl = null;
    // End-of-request cleanup: close the pinned keep-alive socket.
    this.keepAliveHttpAgent?.destroy();
    this.keepAliveHttpAgent = null;
  }

  /**
   * Parse Set-Cookie headers and merge into the cookie jar.
   * Extracts only name=value pairs, ignoring attributes (Path, Domain, HttpOnly, etc.).
   */
  private mergeSetCookies(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
      // First segment before ';' is the name=value pair
      const nameValue = header.split(';')[0]?.trim();
      if (!nameValue?.includes('=')) continue;
      const eqIdx = nameValue.indexOf('=');
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      if (name) {
        this.cookieJar.set(name, value);
      }
    }
  }

  /**
   * Inject a self-generated `SAP_SESSIONID_<SID>_<CLIENT>` so the SAP Web
   * Dispatcher pins the stateful lock chain to one app-server (see
   * `generatedSapSessionId`). The `<SID>_<CLIENT>` suffix (e.g. DEV_100) is
   * derived from the server's own `sap-XSRF_<SID>_<CLIENT>` cookie (present after
   * the first response). Only injects ours when the server has NOT issued a real
   * SAP_SESSIONID (mergeSetCookies stores that first, and we never overwrite it).
   */
  private ensureGeneratedSessionCookie(): void {
    const xsrfKey = [...this.cookieJar.keys()].find((k) =>
      /^sap-XSRF_/i.test(k),
    );
    if (!xsrfKey) return; // suffix not known yet (no response captured)
    const cookieName = `SAP_SESSIONID_${xsrfKey.replace(/^sap-XSRF_/i, '')}`;
    if (this.cookieJar.has(cookieName)) return; // real server-issued one wins
    if (!this.generatedSapSessionId) {
      // base64url (URL-safe: no +, /, or = padding) so the value never trips a
      // cookie parser, while resembling the server's own base64 SAP_SESSIONID
      // format. Generated ONCE and never changed for the connection's lifetime
      // (a new connection = a new session = a new value) — this constancy is what
      // keeps the ADT stateful session (LOCK → update → unlock) bound to one value
      // on the single app-server instance behind the connectivity proxy.
      this.generatedSapSessionId = randomBytes(24).toString('base64url');
    }
    this.cookieJar.set(cookieName, this.generatedSapSessionId);
  }

  /**
   * Build Cookie header string from the jar (name1=value1; name2=value2).
   */
  private getCookieHeader(): string | null {
    this.ensureGeneratedSessionCookie();
    return this.cookieHeader();
  }

  /**
   * The jar as a Cookie header, WITHOUT minting a session id.
   *
   * Teardown reads the jar through this: {@link getCookieHeader} would generate
   * a `SAP_SESSIONID` at the very moment the session is being handed back,
   * opening one more than it closes.
   */
  private cookieHeader(): string | null {
    if (this.cookieJar.size === 0) return null;
    return [...this.cookieJar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Force the configured SAP client (mandant) into the `sap-usercontext` cookie.
   * The `X-SAP-Client` header alone is NOT enough: SAP routes the request to the
   * system DEFAULT client unless `sap-usercontext=sap-client=<client>` is sent,
   * and the CSRF token itself is client-specific. Without this, a non-default
   * client (e.g. 600) silently falls back to the default (e.g. 100) and the
   * logon fails because the user's context lives in the other client.
   */
  private enforceClientCookie(): void {
    if (this.config.client) {
      this.cookieJar.set('sap-usercontext', `sap-client=${this.config.client}`);
    }
  }

  async getBaseUrl(): Promise<string> {
    if (this.cachedBaseUrl) {
      return this.cachedBaseUrl;
    }

    const { url } = this.config;
    try {
      const urlObj = new URL(url);
      this.cachedBaseUrl = urlObj.origin;
      return this.cachedBaseUrl;
    } catch (error) {
      const errorMessage = `Invalid URL in configuration: ${
        error instanceof Error ? error.message : error
      }`;
      throw new Error(errorMessage);
    }
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    if (this.config.client) {
      headers['X-SAP-Client'] = this.config.client;
    }

    // Add Basic auth header when credentials are provided via x-sap-login/x-sap-password override
    // This takes precedence over destination-configured authentication
    if (this.config.username && this.config.password) {
      const credentials = Buffer.from(
        `${this.config.username}:${this.config.password}`,
      ).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }

    return headers;
  }

  /**
   * Ensure CSRF token is fresh before making mutation requests
   *
   * NOTE: This implementation uses SAP Cloud SDK executeHttpRequest instead of axios.
   * The retry logic and parameters are synchronized with @mcp-abap-adt/connection
   * via CSRF_CONFIG, but the HTTP client differs due to BTP Destination Service integration.
   */
  /**
   * Ensure CSRF token is available. Reuses cached token or fetches a new one.
   * Safe for parallel calls — only one fetch runs at a time.
   */
  private async ensureFreshCsrfToken(requestUrl: string): Promise<void> {
    if (this.csrfToken) {
      return;
    }
    await this.refreshCsrf(requestUrl);
  }

  /**
   * Refresh CSRF token. Clears stale cookies, fetches new token.
   * Uses shared promise so parallel callers wait for the same fetch.
   */
  private async refreshCsrf(requestUrl: string): Promise<void> {
    if (!this.csrfRefreshing) {
      this.csrfRefreshing = (async () => {
        // A CSRF refresh must NOT drop session/affinity cookies. SAP pins the
        // stateful ADT session (created on LOCK) to an app-server via
        // `SAP_SESSIONID_<sid>_<client>` and tracks it via `sap-contextid`.
        // The old code cleared the WHOLE jar — and a POST/PUT in the middle of a
        // lock→update→unlock chain triggers a CSRF refresh — which wiped those
        // cookies, so the next request 400'd "Session not found" and the
        // edit-lock was orphaned (object left locked). More frequent on a cold
        // instance (background warmup drives extra CSRF churn), hence it looked
        // intermittent/warm-up-dependent — and pre-migration prod showed it too.
        // Only the CSRF token (an HTTP header) needs to reset here: drop just the
        // transient CSRF cookie, keep everything else (session + affinity).
        const dropped: string[] = [];
        for (const name of [...this.cookieJar.keys()]) {
          if (/csrf|xsrf/i.test(name)) {
            this.cookieJar.delete(name);
            dropped.push(name);
          }
        }
        this.csrfToken = null;
        // Drop only the transient CSRF/XSRF cookie on refresh; the ADT session
        // cookies (sap-contextid, our SAP_SESSIONID) MUST survive, else the
        // stateful lock chain loses its session and orphans the edit-lock.
        logger.debug('CSRF refresh (session cookies preserved)', {
          type: 'CSRF_REFRESH',
          dropped,
        });
        try {
          return await this.fetchCsrfToken(requestUrl);
        } finally {
          this.csrfRefreshing = null;
        }
      })();
    }
    this.csrfToken = await this.csrfRefreshing;
  }

  /**
   * Fetch CSRF token from SAP ADT discovery endpoint
   *
   * Implementation differences from @mcp-abap-adt/connection:
   * - Uses SAP Cloud SDK executeHttpRequest instead of axios
   * - Leverages BTP Destination Service for authentication
   * - Automatic proxy handling via Cloud Connector (if configured)
   *
   * Retry logic and parameters are synchronized via CSRF_CONFIG.
   *
   * @param url - Original request URL (used for logging context)
   * @returns CSRF token string
   */
  private async fetchCsrfToken(url: string): Promise<string> {
    // Get base URL and build CSRF token endpoint
    // Connection has base URL, we just need to add CSRF endpoint
    const baseUrl = await this.getBaseUrl();
    const csrfUrl = `${baseUrl}${CSRF_CONFIG.ENDPOINT}`;

    logger.csrfToken('fetch', `Fetching CSRF token from: ${csrfUrl}`, {
      baseUrl,
      originalRequestUrl: url,
      retryCount: CSRF_CONFIG.RETRY_COUNT,
      retryDelay: CSRF_CONFIG.RETRY_DELAY,
    });

    const retryCount = CSRF_CONFIG.RETRY_COUNT;
    const retryDelay = CSRF_CONFIG.RETRY_DELAY;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0) {
          logger.csrfToken(
            'retry',
            `Retry attempt ${attempt}/${retryCount} for CSRF token`,
            {
              delay: retryDelay,
            },
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        // Use executeHttpRequest for CSRF token fetch
        // This automatically handles:
        // - Authentication via BTP Destination Service
        // - Proxy configuration for On-Premise systems
        // - SSL certificate validation
        // The CSRF token is client-specific — fetch it in the TARGET client, not
        // the system default. Seed sap-usercontext before the request.
        this.enforceClientCookie();
        const csrfCookie = this.getCookieHeader();
        // Bound the CSRF fetch too — the SAP Cloud SDK does not time out on its
        // own, so a hung CSRF request on a POST/PUT tool would otherwise block
        // the whole call indefinitely. Uses SAP_TIMEOUT_CSRF (default 15 s).
        const csrfTimeoutMs = Number(process.env.SAP_TIMEOUT_CSRF) || 15_000;
        const response = await executeHttpRequest(
          { destinationName: this.destinationName },
          {
            method: 'GET',
            url: csrfUrl,
            timeout: csrfTimeoutMs,
            httpAgent: this.getHttpAgent(),
            headers: {
              ...(await this.getAuthHeaders()),
              ...CSRF_CONFIG.REQUIRED_HEADERS,
              // Send OUR client-generated stateful-session id on the discovery
              // fetch too. This is the request where SAP establishes the HTTP
              // session and sets the app-server-affinity cookie
              // (SAP_SESSIONID_<sid>_<client>). Without the connection-id here,
              // SAP established that session under a DIFFERENT context than the
              // lock chain (which does send it), so the app-server pin did not
              // carry — the first stateful request (LOCK) scattered and the
              // GET/UNLOCK 400'd "Session not found" (cold-start orphaned lock).
              // Binding the discovery to the same connection-id lets the whole
              // lock→update→unlock chain resume one session on one app-server.
              'sap-adt-connection-id': this.sessionId,
              ...(csrfCookie ? { Cookie: csrfCookie } : {}),
            },
          },
        );

        // Convert Cloud SDK response to Axios-like format
        const token = response.headers?.['x-csrf-token'] as string | undefined;
        if (!token) {
          logger.csrfToken('error', CSRF_ERROR_MESSAGES.NOT_IN_HEADERS, {
            headers: Object.keys(response.headers || {}),
            status: response.status,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1,
          });

          if (attempt < retryCount) {
            continue;
          }
          throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        }

        // Extract cookies from Set-Cookie header (name=value only, no attributes)
        this.mergeSetCookies(
          response.headers?.['set-cookie'] as string | string[] | undefined,
        );
        // SAP's response often resets sap-usercontext to the system DEFAULT
        // client — re-enforce our configured client for all subsequent requests.
        this.enforceClientCookie();
        if (this.cookieJar.size > 0) {
          logger.csrfToken('success', 'Cookies extracted from CSRF response', {
            cookieCount: this.cookieJar.size,
            cookieNames: [...this.cookieJar.keys()].join(', '),
          });
        }

        logger.csrfToken('success', 'CSRF token successfully obtained', {
          attempt: attempt + 1,
          tokenLength: token.length,
        });
        return token;
      } catch (error: unknown) {
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        const errorObj = error as {
          response?: { status?: number; data?: unknown };
          statusCode?: number;
        };
        const status = errorObj?.response?.status ?? errorObj?.statusCode;

        // The bare Cloud SDK / axios message is just "Request failed with
        // status code NNN", which hides the real cause. The connectivity proxy
        // puts the actual reason in the response BODY (e.g. an SSL
        // "certificate_expired" handshake error, or "Anmeldung fehlgeschlagen"
        // for bad credentials). Surface a trimmed snippet so the diagnosis
        // reaches the service response instead of an opaque 500.
        const respData = errorObj?.response?.data;
        let backendDetail = '';
        if (typeof respData === 'string') {
          backendDetail = respData;
        } else if (respData && typeof respData === 'object') {
          try {
            backendDetail = JSON.stringify(respData);
          } catch {
            backendDetail = String(respData);
          }
        }
        const errorMessage = backendDetail
          ? `${rawMessage} — backend: ${backendDetail.slice(0, 300)}`
          : rawMessage;

        logger.csrfToken('error', `CSRF token error: ${errorMessage}`, {
          url: csrfUrl,
          status,
          attempt: attempt + 1,
          maxAttempts: retryCount + 1,
        });

        // Authentication failures (401/403) must NOT be retried: each retry is
        // another failed ABAP logon and will LOCK the user after a few attempts.
        // Only transient failures (network/5xx/missing-token) are worth retrying.
        if (status === 401 || status === 403) {
          throw new Error(CSRF_ERROR_MESSAGES.FETCH_FAILED(1, errorMessage));
        }

        if (attempt < retryCount) {
          continue;
        }

        // Use synchronized error message format
        throw new Error(
          CSRF_ERROR_MESSAGES.FETCH_FAILED(retryCount + 1, errorMessage),
        );
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new Error(
      CSRF_ERROR_MESSAGES.FETCH_FAILED(retryCount + 1, 'Unexpected failure'),
    );
  }

  /**
   * Convert Cloud SDK response to IAdtResponse format
   */
  // biome-ignore lint/suspicious/noExplicitAny: Generic type parameters with default any are standard for flexible response types
  private convertToAdtResponse<T = any, D = any>(
    cloudSdkResponse: {
      data: unknown;
      status?: number;
      statusText?: string;
      headers?: Record<string, unknown>;
    },
    requestUrl: string,
  ): IAdtResponse<T, D> {
    return {
      data: cloudSdkResponse.data as T,
      status: cloudSdkResponse.status || 200,
      statusText: cloudSdkResponse.statusText || 'OK',
      headers: (cloudSdkResponse.headers || {}) as Record<
        string,
        string | string[] | number | boolean | null | undefined | object
      >,
      config: {
        url: requestUrl,
        method: 'GET',
      } as D,
      request: {},
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Generic type parameters with default any match IAbapConnection interface signature
  async makeAdtRequest<T = any, D = any>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    const {
      url,
      method,
      timeout,
      data,
      params,
      headers: optionHeaders,
    } = options;
    const normalizedMethod = method.toUpperCase();
    // SAP Cloud SDK's executeHttpRequest does NOT time out on its own, so the
    // per-request timeout (from the ADT client, ultimately SAP_TIMEOUT_*) MUST be
    // forwarded here — otherwise a hung BTP-destination request blocks forever.
    // Falls back to 120 s when the caller didn't specify one. Inside a critical
    // section (lock→modify→unlock), raise the ceiling to SAP_TIMEOUT_CRITICAL so a
    // slow write is not cut mid-flight — cutting it drops the stateful session and
    // orphans the lock. Applied here, so main + both retries + reused config honour it.
    // Mirrors @mcp-abap-adt/connection getCriticalSectionTimeout() (not re-exported
    // from the package root): SAP_TIMEOUT_CRITICAL, default 600000 ms (10 min).
    const criticalTimeoutMs =
      Number(process.env.SAP_TIMEOUT_CRITICAL) || 600_000;
    const requestTimeoutMs = this.inCriticalSection
      ? Math.max(timeout ?? 0, criticalTimeoutMs)
      : (timeout ?? 120_000);

    // Get base URL and build full URL from endpoint
    // Connection has base URL, url parameter is endpoint (e.g., /sap/bc/adt/oo/classes/...)
    const baseUrl = await this.getBaseUrl();
    let requestUrl: string;

    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Already absolute URL, use as is
      requestUrl = url;
    } else {
      // Relative endpoint, combine with base URL
      const endpoint = url.startsWith('/') ? url : `/${url}`;
      requestUrl = `${baseUrl}${endpoint}`;
    }

    if (normalizedMethod === 'POST' || normalizedMethod === 'PUT') {
      // Pass endpoint (not full URL) for CSRF token fetch
      await this.ensureFreshCsrfToken(url);
    }

    // Merge headers: auth headers < library-provided headers (Content-Type, Accept, etc.)
    const requestHeaders: Record<string, string> = {
      ...(await this.getAuthHeaders()),
      ...(optionHeaders || {}),
    };

    // ALWAYS add sap-adt-connection-id header (connectionId is sent for ALL session types)
    if (this.sessionId) {
      requestHeaders['sap-adt-connection-id'] = this.sessionId;
    }

    // Add stateful session headers if stateful mode enabled
    if (this.sessionType === 'stateful') {
      requestHeaders['x-sap-adt-sessiontype'] = 'stateful';
      requestHeaders['sap-adt-request-id'] = randomUUID().replace(/-/g, '');
      requestHeaders['X-sap-adt-profiling'] = 'server-time';
    }

    if (
      (normalizedMethod === 'POST' || normalizedMethod === 'PUT') &&
      this.csrfToken
    ) {
      requestHeaders['x-csrf-token'] = this.csrfToken;
    }

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      requestHeaders.Cookie = cookieHeader;
    }

    if (!requestHeaders.Accept) {
      requestHeaders.Accept =
        'application/xml, application/json, text/plain, */*';
    }

    if ((normalizedMethod === 'POST' || normalizedMethod === 'PUT') && data) {
      if (typeof data === 'string' && !requestHeaders['Content-Type']) {
        if (
          requestUrl.includes('/usageReferences') &&
          data.includes('usageReferenceRequest')
        ) {
          requestHeaders['Content-Type'] =
            'application/vnd.sap.adt.repository.usagereferences.request.v1+xml';
          requestHeaders.Accept =
            'application/vnd.sap.adt.repository.usagereferences.result.v1+xml';
        } else {
          requestHeaders['Content-Type'] = 'text/plain; charset=utf-8';
        }
      }
    }

    logger.debug(`Executing ${normalizedMethod} request to: ${requestUrl}`, {
      type: 'REQUEST_INFO',
      url: requestUrl,
      method: normalizedMethod,
      destinationName: this.destinationName,
    });

    try {
      // Use executeHttpRequest from SAP Cloud SDK
      // This automatically handles:
      // - Destination resolution
      // - Authentication (Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion)
      // - Proxy configuration
      // - Token refresh
      const response = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: normalizedMethod as
            | 'GET'
            | 'POST'
            | 'PUT'
            | 'DELETE'
            | 'PATCH',
          url: requestUrl,
          headers: requestHeaders,
          timeout: requestTimeoutMs,
          httpAgent: this.getHttpAgent(),
          // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK params type is not fully typed
          params: params as Record<string, any> | undefined,
          // Keep original data type (string for XML, object for JSON).
          // Casting string→Record causes axios to serialize as JSON,
          // ignoring Content-Type and triggering 415 on ADT endpoints.
          // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK data type accepts any
          data: data as any,
        },
      );

      // Capture cookies from response to maintain session affinity
      // Critical for stateful sessions: lock → update → unlock → activate chain
      const rawSetCookie = response.headers?.['set-cookie'] as
        | string
        | string[]
        | undefined;
      this.mergeSetCookies(rawSetCookie);

      // Convert Cloud SDK response to IAdtResponse format
      return this.convertToAdtResponse<T, D>(response, requestUrl);
    } catch (error: unknown) {
      // Anomaly log (INFO): a stateful request that lost its ADT session despite
      // the generated SAP_SESSIONID. This is the orphaned-lock symptom — normally
      // it never fires, so it's cheap and pinpoints the rare cases in production
      // (which request, on which destination, and the session context sent).
      {
        const e = error as {
          response?: { status?: number; data?: unknown };
        };
        const body = e?.response?.data;
        if (
          e?.response?.status === 400 &&
          typeof body === 'string' &&
          /session/i.test(body)
        ) {
          const sidKey = [...this.cookieJar.keys()].find((k) =>
            /^SAP_SESSIONID_/.test(k),
          );
          logger.warn('ADT stateful session lost mid-chain', {
            type: 'SESSION_LOST',
            method: normalizedMethod,
            url: requestUrl,
            destinationName: this.destinationName,
            sessionType: this.sessionType,
            connId: this.sessionId?.slice(0, 8),
            sapSessionId: sidKey
              ? `${sidKey}=${(this.cookieJar.get(sidKey) ?? '').slice(0, 8)}…`
              : 'NONE',
          });
        }
      }
      // Use synchronized error handling from errorUtils
      // In development (cds watch), TypeScript files are executed directly, so use .ts extension
      // In production (compiled), files are .js
      // Try .ts first (development), fallback to .js (production)
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic import result type is not fully typed
      let errorUtils: any;
      try {
        // @ts-expect-error - Dynamic import with .ts extension for development mode
        errorUtils = await import('../lib/errorUtils.ts');
      } catch {
        errorUtils = await import('../lib/errorUtils.js');
      }
      const { logErrorSafely } = errorUtils;
      logErrorSafely(logger, 'ADT request', error, {
        url: requestUrl,
        method: normalizedMethod,
        destinationName: this.destinationName,
      });

      const errorObj = error as {
        response?: { status?: number };
        statusCode?: number;
      };
      // If CSRF token validation failed, try to refresh and retry once
      if (
        (errorObj?.response?.status === 403 || errorObj?.statusCode === 403) &&
        (normalizedMethod === 'POST' || normalizedMethod === 'PUT')
      ) {
        logger.info(
          'CSRF token validation failed, refreshing token and retrying',
          { url: requestUrl },
        );
        // Shared refresh — if another parallel call is already refreshing, wait for it
        await this.refreshCsrf(requestUrl);

        // Retry the request with fresh CSRF token + cookies
        try {
          const retryHeaders = { ...requestHeaders };
          if (!this.csrfToken) {
            throw new Error('CSRF token is required for retry');
          }
          retryHeaders['x-csrf-token'] = this.csrfToken;
          const retryCookie = this.getCookieHeader();
          if (retryCookie) {
            retryHeaders.Cookie = retryCookie;
          } else {
            delete retryHeaders.Cookie;
          }

          const retryResponse = await executeHttpRequest(
            { destinationName: this.destinationName },
            {
              method: normalizedMethod as
                | 'GET'
                | 'POST'
                | 'PUT'
                | 'DELETE'
                | 'PATCH',
              url: requestUrl,
              headers: retryHeaders,
              timeout: requestTimeoutMs,
              httpAgent: this.getHttpAgent(),
              // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK params type is not fully typed
              params: params as Record<string, any> | undefined,
              // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK data type accepts any
              data: data as any,
            },
          );

          return this.convertToAdtResponse<T, D>(retryResponse, requestUrl);
        } catch (retryError: unknown) {
          logErrorSafely(logger, 'ADT request retry', retryError, {
            url: requestUrl,
            method: normalizedMethod,
            destinationName: this.destinationName,
          });
          throw retryError;
        }
      }

      // NOTE: intentionally NO retry on a 400 "Session not found". A stateful
      // write (create/lock/update) may have ALREADY executed server-side before
      // the follow-up request scattered; blindly re-running it just PILES UP
      // locked/duplicate objects. The right fix is to not scatter in the first
      // place (see the generated SAP_SESSIONID app-server stickiness in
      // getCookieHeader), not to retry. Let the error propagate.

      // Enrich the error message with the shared connectivity-proxy classifier
      // so MCP clients (curl, Cline, goose, IDE integrations) see "tunnel_timeout
      // — SCC registered but handshake fails" etc. directly in the tool error
      // envelope, not just an opaque 503. See issues #83 / #85.
      try {
        const errObj = error as {
          response?: { status?: number; data?: unknown };
          message?: string;
        };
        const httpCode = errObj?.response?.status || 0;
        const respData = errObj?.response?.data;
        const rawMessage =
          typeof respData === 'string' ? respData : (errObj?.message ?? '');
        const looksTunnelRelated =
          httpCode >= 500 ||
          /tunnel|SCC|Cloud Connector|Anmeldung|Logon/i.test(rawMessage) ||
          // The plain CONNECT-PHASE shapes of a host that is not there.
          // classifyProbe already reads these as dns_or_network; it was simply
          // never asked. Deliberately NOT ECONNRESET / EPIPE / "socket hang
          // up" — on the one long-lived keep-alive socket (maxSockets:1) those
          // can mean SAP ran the write and reset afterwards, not that nothing
          // reached it; asking about them here would tag (and later close) a
          // destination that may simply have executed the request.
          /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN/i.test(
            rawMessage,
          );
        if (looksTunnelRelated && error instanceof Error) {
          let classifier: typeof import('../lib/probe-classifier');
          try {
            // @ts-expect-error — .ts extension for cds-watch dev mode
            classifier = await import('../lib/probe-classifier.ts');
          } catch {
            classifier = await import('../lib/probe-classifier.js');
          }
          const { status, hint } = classifier.classifyProbe(
            httpCode,
            rawMessage,
            'OnPremise',
          );
          if (status !== 'ok' && status !== 'unknown') {
            const tag = `[${status}]`;
            if (!error.message.includes(tag)) {
              error.message = `${error.message} ${tag}${hint ? ` ${hint}` : ''}`;
            }
          }
        }
      } catch {
        // classifier enrichment is best-effort; never block the original error
      }

      throw error;
    }
  }
}
