import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { AxiosResponse } from 'axios';
import type { AbapConnection, AbapRequestOptions } from '@fr0ster/mcp-abap-adt/dist/lib/connection/AbapConnection';
import type { SapConfig } from '@fr0ster/mcp-abap-adt/dist/lib/sapConfig';
import { logger } from '@fr0ster/mcp-abap-adt/dist/lib/logger';

/**
 * AbapConnection implementation using SAP Cloud SDK executeHttpRequest
 * This leverages SAP Cloud SDK's automatic destination handling, authentication,
 * and proxy management instead of manual axios requests.
 */
export class CloudSdkAbapConnection implements AbapConnection {
  private csrfToken: string | null = null;
  private cookies: string | null = null;
  private cachedBaseUrl: string | null = null;

  constructor(
    private readonly config: SapConfig,
    private readonly destinationName: string
  ) {}

  getConfig(): SapConfig {
    return this.config;
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

    // Note: executeHttpRequest handles authentication automatically via destination
    // We only need to add SAP-specific headers here

    return headers;
  }

  private normalizeRequestUrl(url: string): string {
    if (!url.includes('/sap/bc/adt/') && !url.endsWith('/sap/bc/adt')) {
      return url.endsWith('/') ? `${url}sap/bc/adt` : `${url}/sap/bc/adt`;
    }
    return url;
  }

  private async ensureFreshCsrfToken(requestUrl: string): Promise<void> {
    try {
      this.csrfToken = await this.fetchCsrfToken(requestUrl);
    } catch (error) {
      const errorMsg =
        'CSRF token is required for POST/PUT requests but could not be fetched';

      logger.error(errorMsg, {
        type: 'CSRF_FETCH_ERROR',
        cause: error instanceof Error ? error.message : String(error)
      });

      throw new Error(errorMsg);
    }
  }

  private async fetchCsrfToken(url: string, retryCount = 3, retryDelay = 1000): Promise<string> {
    let csrfUrl = url;
    if (!url.includes('/sap/bc/adt/')) {
      csrfUrl = url.endsWith('/') ? `${url}sap/bc/adt/discovery` : `${url}/sap/bc/adt/discovery`;
    } else if (!url.includes('/sap/bc/adt/discovery')) {
      const base = url.split('/sap/bc/adt')[0];
      csrfUrl = `${base}/sap/bc/adt/discovery`;
    }

    logger.csrfToken('fetch', `Fetching CSRF token from: ${csrfUrl}`);

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0) {
          logger.csrfToken('retry', `Retry attempt ${attempt}/${retryCount} for CSRF token`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        // Use executeHttpRequest for CSRF token fetch
        const response = await executeHttpRequest(
          { destinationName: this.destinationName },
          {
            method: 'GET',
            url: csrfUrl,
            headers: {
              ...(await this.getAuthHeaders()),
              'x-csrf-token': 'fetch',
              Accept: 'application/atomsvc+xml'
            }
          }
        );

        // Convert Cloud SDK response to Axios-like format
        const token = response.headers?.['x-csrf-token'] as string | undefined;
        if (!token) {
          logger.csrfToken('error', 'No CSRF token in response headers', {
            headers: response.headers,
            status: response.status
          });

          if (attempt < retryCount) {
            continue;
          }
          throw new Error('No CSRF token in response headers');
        }

        // Extract cookies from Set-Cookie header
        const setCookie = response.headers?.['set-cookie'];
        if (setCookie) {
          this.cookies = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
          logger.csrfToken('success', 'Cookies extracted from response', {
            cookieLength: this.cookies?.length ?? 0
          });
        }

        logger.csrfToken('success', 'CSRF token successfully obtained');
        return token;
      } catch (error: any) {
        logger.csrfToken('error', `CSRF token error: ${error?.message}`, {
          url: csrfUrl,
          status: error?.response?.status,
          statusCode: error?.statusCode
        });

        if (attempt < retryCount) {
          continue;
        }

        throw new Error(
          `Failed to fetch CSRF token after ${retryCount + 1} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new Error('CSRF token fetch failed unexpectedly');
  }

  /**
   * Convert Cloud SDK response to AxiosResponse format
   */
  private convertToAxiosResponse(cloudSdkResponse: any, requestUrl: string): AxiosResponse {
    return {
      data: cloudSdkResponse.data,
      status: cloudSdkResponse.status || 200,
      statusText: cloudSdkResponse.statusText || 'OK',
      headers: cloudSdkResponse.headers || {},
      config: {
        url: requestUrl,
        method: 'GET'
      } as any,
      request: {}
    } as AxiosResponse;
  }

  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    const { url, method, timeout, data, params } = options;
    const normalizedMethod = method.toUpperCase();
    const requestUrl = this.normalizeRequestUrl(url);

    if (normalizedMethod === 'POST' || normalizedMethod === 'PUT') {
      await this.ensureFreshCsrfToken(requestUrl);
    }

    const requestHeaders: Record<string, string> = {
      ...(await this.getAuthHeaders())
    };

    if ((normalizedMethod === 'POST' || normalizedMethod === 'PUT') && this.csrfToken) {
      requestHeaders['x-csrf-token'] = this.csrfToken;
    }

    if (this.cookies) {
      requestHeaders['Cookie'] = this.cookies;
    }

    if (!requestHeaders['Accept']) {
      requestHeaders['Accept'] = 'application/xml, application/json, text/plain, */*';
    }

    if ((normalizedMethod === 'POST' || normalizedMethod === 'PUT') && data) {
      if (typeof data === 'string' && !requestHeaders['Content-Type']) {
        if (requestUrl.includes('/usageReferences') && data.includes('usageReferenceRequest')) {
          requestHeaders['Content-Type'] =
            'application/vnd.sap.adt.repository.usagereferences.request.v1+xml';
          requestHeaders['Accept'] =
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
      destinationName: this.destinationName
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
          method: normalizedMethod as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
          url: requestUrl,
          headers: requestHeaders,
          params,
          data: data !== undefined ? data : undefined
        }
      );

      // Convert Cloud SDK response to AxiosResponse format
      return this.convertToAxiosResponse(response, requestUrl);
    } catch (error: any) {
      logger.error(`Request failed: ${error?.message}`, {
        type: 'REQUEST_ERROR',
        url: requestUrl,
        method: normalizedMethod,
        status: error?.response?.status || error?.statusCode,
        destinationName: this.destinationName
      });

      // If CSRF token validation failed, try to refresh and retry once
      if (
        (error?.response?.status === 403 || error?.statusCode === 403) &&
        (normalizedMethod === 'POST' || normalizedMethod === 'PUT')
      ) {
        logger.info(
          'CSRF token validation failed, fetching new token and retrying request',
          { url: requestUrl }
        );
        this.csrfToken = await this.fetchCsrfToken(requestUrl, 5, 2000);

        // Retry the request
        try {
          const retryHeaders = { ...requestHeaders };
          retryHeaders['x-csrf-token'] = this.csrfToken!;

          const retryResponse = await executeHttpRequest(
            { destinationName: this.destinationName },
            {
              method: normalizedMethod as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
              url: requestUrl,
              headers: retryHeaders,
              params,
              data: data !== undefined ? data : undefined
            }
          );

          return this.convertToAxiosResponse(retryResponse, requestUrl);
        } catch (retryError: any) {
          logger.error('Retry request also failed', {
            type: 'REQUEST_RETRY_ERROR',
            url: requestUrl,
            error: retryError?.message
          });
          throw retryError;
        }
      }

      throw error;
    }
  }
}

