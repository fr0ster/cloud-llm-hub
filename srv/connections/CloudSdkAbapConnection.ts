// Import env setup FIRST to ensure MCP_SKIP_ENV_LOAD is set before submodule imports
import '../env-setup';

import { randomUUID } from 'node:crypto';
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
    this.sessionType = type;
    logger.debug(`Session type set to: ${type}`, {
      sessionId: this.sessionId?.substring(0, 8),
    });
  }

  async connect(): Promise<void> {
    // Pre-fetch CSRF token so the first POST doesn't need to fetch lazily.
    // Optional — refreshCsrf handles on-demand fetch if token is missing.
    await this.ensureFreshCsrfToken(CSRF_CONFIG.ENDPOINT);
  }

  reset(): void {
    this.csrfToken = null;
    this.cookieJar.clear();
    this.cachedBaseUrl = null;
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
   * Build Cookie header string from the jar (name1=value1; name2=value2).
   */
  private getCookieHeader(): string | null {
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
        this.cookieJar.clear();
        this.csrfToken = null;
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
        const response = await executeHttpRequest(
          { destinationName: this.destinationName },
          {
            method: 'GET',
            url: csrfUrl,
            headers: {
              ...(await this.getAuthHeaders()),
              ...CSRF_CONFIG.REQUIRED_HEADERS,
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
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorObj = error as {
          response?: { status?: number };
          statusCode?: number;
        };
        const status = errorObj?.response?.status ?? errorObj?.statusCode;
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
      timeout: _timeout,
      data,
      params,
      headers: optionHeaders,
    } = options;
    const normalizedMethod = method.toUpperCase();

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

    logger.info(`Executing ${normalizedMethod} request to: ${requestUrl}`, {
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
      this.mergeSetCookies(
        response.headers?.['set-cookie'] as string | string[] | undefined,
      );

      // Convert Cloud SDK response to IAdtResponse format
      return this.convertToAdtResponse<T, D>(response, requestUrl);
    } catch (error: unknown) {
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

      // If session timed out (400), clear stale cookies/CSRF and retry once
      const responseData = (error as { response?: { data?: string } })?.response
        ?.data;
      const isSessionTimeout =
        (errorObj?.response?.status === 400 || errorObj?.statusCode === 400) &&
        typeof responseData === 'string' &&
        (responseData.includes('Session') || responseData.includes('session'));
      if (isSessionTimeout) {
        logger.info(
          'Session timed out, clearing cookies/CSRF and retrying request',
          { url: requestUrl },
        );
        this.cookieJar.clear();
        this.csrfToken = null;

        try {
          // Re-fetch CSRF for mutation requests
          const retryHeaders = { ...requestHeaders };
          delete retryHeaders.Cookie;
          if (normalizedMethod === 'POST' || normalizedMethod === 'PUT') {
            this.csrfToken = await this.fetchCsrfToken(requestUrl);
            retryHeaders['x-csrf-token'] = this.csrfToken;
          }
          const cookieAfterReset = this.getCookieHeader();
          if (cookieAfterReset) {
            retryHeaders.Cookie = cookieAfterReset;
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
              // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK params type is not fully typed
              params: params as Record<string, any> | undefined,
              // biome-ignore lint/suspicious/noExplicitAny: SAP Cloud SDK data type accepts any
              data: data as any,
            },
          );

          this.mergeSetCookies(
            retryResponse.headers?.['set-cookie'] as
              | string
              | string[]
              | undefined,
          );
          return this.convertToAdtResponse<T, D>(retryResponse, requestUrl);
        } catch (retryError: unknown) {
          logErrorSafely(
            logger,
            'ADT request retry (session reset)',
            retryError,
            {
              url: requestUrl,
              method: normalizedMethod,
              destinationName: this.destinationName,
            },
          );
          throw retryError;
        }
      }

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
          /tunnel|SCC|Cloud Connector|Anmeldung|Logon/i.test(rawMessage);
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
