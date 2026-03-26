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
  private cookies: string | null = null;
  private cachedBaseUrl: string | null = null;
  private sessionId: string = 'cloud-sdk-session';
  private sessionType: 'stateless' | 'stateful' = 'stateless';
  private readonly destinationName: string;

  constructor(
    private readonly config: SapConfig,
    destinationName: string,
  ) {
    this.destinationName = destinationName;
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
    // Cloud SDK handles connection automatically via destination
    // This is a no-op for Cloud SDK implementation
  }

  reset(): void {
    this.csrfToken = null;
    this.cookies = null;
    this.cachedBaseUrl = null;
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
  private async ensureFreshCsrfToken(requestUrl: string): Promise<void> {
    // Reuse existing token if available — avoids breaking session affinity
    // in stateful mode (lock → update → unlock → activate chain).
    // Token is reset on connection.reset() or after 403 retry.
    if (this.csrfToken) {
      return;
    }
    try {
      this.csrfToken = await this.fetchCsrfToken(requestUrl);
    } catch (error) {
      const errorMsg = CSRF_ERROR_MESSAGES.REQUIRED_FOR_MUTATION;

      logger.error(errorMsg, {
        type: 'CSRF_FETCH_ERROR',
        cause: error instanceof Error ? error.message : String(error),
      });

      throw new Error(errorMsg);
    }
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
        const response = await executeHttpRequest(
          { destinationName: this.destinationName },
          {
            method: 'GET',
            url: csrfUrl,
            headers: {
              ...(await this.getAuthHeaders()),
              ...CSRF_CONFIG.REQUIRED_HEADERS,
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

        // Extract cookies from Set-Cookie header
        const setCookie = response.headers?.['set-cookie'];
        if (setCookie) {
          this.cookies = Array.isArray(setCookie)
            ? setCookie.join('; ')
            : setCookie;
          logger.csrfToken('success', 'Cookies extracted from response', {
            cookieLength: this.cookies?.length ?? 0,
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
        logger.csrfToken('error', `CSRF token error: ${errorMessage}`, {
          url: csrfUrl,
          status: errorObj?.response?.status || errorObj?.statusCode,
          attempt: attempt + 1,
          maxAttempts: retryCount + 1,
        });

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

    if (this.cookies) {
      requestHeaders.Cookie = this.cookies;
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
      const respSetCookie = response.headers?.['set-cookie'];
      if (respSetCookie) {
        this.cookies = Array.isArray(respSetCookie)
          ? respSetCookie.join('; ')
          : (respSetCookie as string);
      }

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
          'CSRF token validation failed, fetching new token and retrying request',
          {
            url: requestUrl,
          },
        );
        this.csrfToken = await this.fetchCsrfToken(requestUrl);

        // Retry the request
        try {
          const retryHeaders = { ...requestHeaders };
          if (!this.csrfToken) {
            throw new Error('CSRF token is required for retry');
          }
          retryHeaders['x-csrf-token'] = this.csrfToken;

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

      throw error;
    }
  }
}
